import express, { Router } from 'express';
import type { Request, Response } from 'express';
import type pg from 'pg';
import type { Task, User, Event, Attachment } from './types.js';
import { consumeCode, generateCode, generateAccessCode } from './access-codes.js';
import { signToken, verifyToken } from './auth.js';
import { getTaskById, getEventsByTaskId, getAttachmentsByTaskId, getNotificationSubscriptionsByUserId, insertNotificationSubscription, deleteNotificationSubscription, updateNotificationSubscription } from './db/queries.js';
import crypto from 'node:crypto';
import { NOTIFICATION_EVENTS } from './ntfy.js';

const BOARD_CODE_TTL_MS = 10 * 60_000; // 10 minutes
const BOARD_TOKEN_DAYS = 30;

export function createBoardRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use(express.json());

  // ── POST /board/auth — exchange code for JWT ────────────────────
  router.post('/auth', (req: Request, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'code is required' });
      return;
    }

    const data = consumeCode(code, 'board');
    if (!data) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    const token = signToken(
      { sub: data.userId, name: data.userName, scope: 'board' },
      BOARD_TOKEN_DAYS,
    );

    res.json({ token, expires_in_days: BOARD_TOKEN_DAYS });
  });

  // ── GET /board/task/:id — task detail JSON API ──────────────────
  router.get('/task/:id', async (req: Request, res: Response) => {
    const token = extractBoardToken(req);
    if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
    try { verifyToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }

    const client = await pool.connect();
    try {
      const task = await getTaskById(client, req.params.id as string);
      if (!task) { res.status(404).json({ error: 'Task not found' }); return; }

      const [events, attachments] = await Promise.all([
        getEventsByTaskId(client, task.id),
        getAttachmentsByTaskId(client, task.id),
      ]);

      // Fetch all users referenced
      const actorIds = new Set<string>();
      actorIds.add(task.creator_id);
      if (task.owner_id) actorIds.add(task.owner_id);
      for (const e of events) actorIds.add(e.actor_id);

      const usersResult = await client.query<User>(
        `SELECT * FROM users WHERE id = ANY($1)`,
        [Array.from(actorIds)],
      );
      const users: Record<string, User> = {};
      for (const u of usersResult.rows) users[u.id] = u;

      // Generate access codes for attachments
      const baseUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
      const attachmentsWithUrls = attachments.map(a => ({
        ...a,
        download_url: `${baseUrl}/attachments/${a.id}?code=${generateAccessCode(a.id)}`,
      }));

      res.json({ task, events, attachments: attachmentsWithUrls, users });
    } finally {
      client.release();
    }
  });

  // ── GET /board — main board page ────────────────────────────────
  router.get('/', async (req: Request, res: Response) => {
    const token = extractBoardToken(req);

    if (!token) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginPage());
      return;
    }

    try {
      const payload = verifyToken(token);
      if (payload.scope && payload.scope !== 'board') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderLoginPage('Invalid token scope'));
        return;
      }
    } catch {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginPage('Session expired — enter a new code'));
      return;
    }

    const client = await pool.connect();
    try {
      const [openResult, doneResult, usersResult] = await Promise.all([
        client.query<Task>(
          `SELECT * FROM tasks WHERE status = 'open' ORDER BY priority ASC NULLS LAST, created_at DESC`
        ),
        client.query<Task>(
          `SELECT * FROM tasks WHERE status IN ('done', 'cancelled') ORDER BY updated_at DESC LIMIT 20`
        ),
        client.query<User>(
          `SELECT * FROM users WHERE status = 'active' ORDER BY name ASC`
        ),
      ]);

      const allTasks = [...openResult.rows, ...doneResult.rows];
      const taskIds = allTasks.map(t => t.id);

      let latestEvents: Record<string, Event> = {};
      let attachmentCounts: Record<string, number> = {};

      if (taskIds.length > 0) {
        const [eventsResult, attachResult] = await Promise.all([
          client.query<Event & { rn: number }>(
            `SELECT DISTINCT ON (task_id) * FROM events
             WHERE task_id = ANY($1)
             ORDER BY task_id, created_at DESC`,
            [taskIds]
          ),
          client.query<{ task_id: string; count: string }>(
            `SELECT task_id, count(*)::text FROM attachments
             WHERE task_id = ANY($1) GROUP BY task_id`,
            [taskIds]
          ),
        ]);
        for (const e of eventsResult.rows) latestEvents[e.task_id] = e;
        for (const a of attachResult.rows) attachmentCounts[a.task_id] = parseInt(a.count, 10);
      }

      const usersById: Record<string, User> = {};
      for (const u of usersResult.rows) usersById[u.id] = u;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderBoard({
        ownedTasks: openResult.rows.filter(t => t.owner_id),
        triageTasks: openResult.rows.filter(t => !t.owner_id),
        doneTasks: doneResult.rows,
        usersById,
        latestEvents,
        attachmentCounts,
      }));
    } finally {
      client.release();
    }
  });

  // ── GET /board/notifications — list subscriptions ────────────────
  router.get('/notifications', async (req: Request, res: Response) => {
    const token = extractBoardToken(req);
    if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
    let payload;
    try { payload = verifyToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }

    const client = await pool.connect();
    try {
      const subs = await getNotificationSubscriptionsByUserId(client, payload.sub);
      res.json({ subscriptions: subs, available_events: NOTIFICATION_EVENTS });
    } finally {
      client.release();
    }
  });

  // ── POST /board/notifications — create/update subscription ─────
  router.post('/notifications', async (req: Request, res: Response) => {
    const token = extractBoardToken(req);
    if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
    let payload;
    try { payload = verifyToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }

    const { events } = req.body as { events?: string[] };
    if (!events || !Array.isArray(events) || events.length === 0) {
      res.status(400).json({ error: 'events array is required' });
      return;
    }

    for (const evt of events) {
      if (!NOTIFICATION_EVENTS.includes(evt as any)) {
        res.status(400).json({ error: `Invalid event: ${evt}` });
        return;
      }
    }

    const client = await pool.connect();
    try {
      const existing = await getNotificationSubscriptionsByUserId(client, payload.sub);
      if (existing.length > 0) {
        const sub = await updateNotificationSubscription(client, existing[0].id, payload.sub, { events, active: true });
        res.json({ subscription: sub });
      } else {
        const random = crypto.randomBytes(16).toString('hex');
        const topic = `ql-${random}`;
        const sub = await insertNotificationSubscription(client, { user_id: payload.sub, topic, events });
        res.json({ subscription: sub });
      }
    } finally {
      client.release();
    }
  });

  // ── DELETE /board/notifications/:id — remove subscription ──────
  router.delete('/notifications/:id', async (req: Request, res: Response) => {
    const token = extractBoardToken(req);
    if (!token) { res.status(401).json({ error: 'Not authenticated' }); return; }
    let payload;
    try { payload = verifyToken(token); } catch { res.status(401).json({ error: 'Invalid token' }); return; }

    const client = await pool.connect();
    try {
      await deleteNotificationSubscription(client, req.params.id as string, payload.sub);
      res.json({ deleted: true });
    } catch (err) {
      res.status(404).json({ error: 'Subscription not found' });
    } finally {
      client.release();
    }
  });

  return router;
}

// ── Helper: generate a board login code ──────────────────────────

export function generateBoardCode(userId: string, userName: string): string {
  return generateCode('board', { userId, userName }, {
    ttlMs: BOARD_CODE_TTL_MS,
    friendly: true,
    length: 8,
    formatted: 4,
  });
}

// ── Token extraction ─────────────────────────────────────────────

function extractBoardToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

  const cookies = req.headers.cookie;
  if (cookies) {
    const match = cookies.match(/(?:^|;\s*)ql_board_token=([^\s;]+)/);
    if (match) return match[1];
  }

  if (req.query.token) return req.query.token as string;
  return null;
}

// ── Rendering helpers ────────────────────────────────────────────

interface BoardData {
  ownedTasks: Task[];
  triageTasks: Task[];
  doneTasks: Task[];
  usersById: Record<string, User>;
  latestEvents: Record<string, Event>;
  attachmentCounts: Record<string, number>;
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTaskCard(task: Task, data: BoardData, index: number): string {
  const owner = task.owner_id ? data.usersById[task.owner_id] : null;
  const latestEvent = data.latestEvents[task.id];
  const attachCount = data.attachmentCounts[task.id] || 0;
  const shortId = task.id.slice(0, 8);

  const priorityClass = task.priority !== null && task.priority !== undefined
    ? `priority-${Math.min(task.priority as number, 3)}`
    : '';

  const statusClass = task.status === 'done' ? 'status-done'
    : task.status === 'cancelled' ? 'status-cancelled'
    : owner ? 'status-active' : 'status-triage';

  const tagHtml = task.tags?.length
    ? task.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')
    : '';

  const eventHtml = latestEvent
    ? `<div class="latest-event">
        <span class="event-type">${esc(latestEvent.event_type)}</span>
        <span class="event-actor">${esc(data.usersById[latestEvent.actor_id]?.name || 'unknown')}</span>
        <span class="event-time">${timeAgo(latestEvent.created_at)}</span>
       </div>`
    : '';

  const eventBody = latestEvent?.body
    ? `<div class="event-body">${esc(latestEvent.body)}</div>`
    : '';

  return `
    <div class="task-card ${statusClass} ${priorityClass}" data-task-id="${esc(task.id)}" style="--delay: ${index * 0.06}s">
      <div class="card-header">
        <span class="task-id">${shortId}</span>
        ${owner ? `<span class="owner">${esc(owner.name)}</span>` : '<span class="owner triage-label">triage</span>'}
      </div>
      <h3 class="task-title">${esc(task.title)}</h3>
      <div class="card-meta">
        ${tagHtml}
        ${attachCount > 0 ? `<span class="attachment-count">${attachCount} file${attachCount > 1 ? 's' : ''}</span>` : ''}
        <span class="created">${timeAgo(task.created_at)}</span>
      </div>
      ${eventHtml}
      ${eventBody}
    </div>`;
}

// ── Login Page ───────────────────────────────────────────────────

function renderLoginPage(error?: string): string {
  const errorHtml = error
    ? `<div class="error-msg">${esc(error)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quest Log</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #f8f8fa;
    --surface: #ffffff;
    --border: #e4e4e8;
    --border-hover: #c8c8d0;
    --text: #1a1a2e;
    --text-dim: #6b6b80;
    --text-muted: #a0a0b0;
    --accent: #6c5ce7;
    --accent-soft: rgba(108, 92, 231, 0.08);
    --red: #e74c3c;
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04);
  }

  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .login-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 2.5rem;
    width: 100%;
    max-width: 380px;
    box-shadow: var(--shadow-md);
    animation: fadeIn 0.4s ease-out;
  }

  .login-card h1 {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 0.5rem;
  }

  .login-card p {
    color: var(--text-dim);
    font-size: 0.85rem;
    margin-bottom: 1.5rem;
    line-height: 1.5;
  }

  .code-input {
    width: 100%;
    padding: 0.85rem 1rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.2rem;
    letter-spacing: 0.15em;
    text-align: center;
    text-transform: uppercase;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .code-input::placeholder { color: var(--text-muted); letter-spacing: 0.05em; font-size: 0.9rem; text-transform: none; }
  .code-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  .submit-btn {
    width: 100%;
    margin-top: 1rem;
    padding: 0.75rem;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 10px;
    font-family: 'Inter', sans-serif;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s, transform 0.15s;
  }
  .submit-btn:hover { opacity: 0.9; }
  .submit-btn:active { transform: scale(0.98); }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .error-msg {
    margin-top: 1rem;
    padding: 0.6rem 0.8rem;
    background: rgba(231, 76, 60, 0.08);
    border: 1px solid rgba(231, 76, 60, 0.15);
    border-radius: 8px;
    color: var(--red);
    font-size: 0.8rem;
    text-align: center;
  }

  .hint {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.75rem;
    text-align: center;
    line-height: 1.6;
  }
  .hint code {
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-dim);
    background: var(--bg);
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
    font-size: 0.7rem;
  }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
</style>
</head>
<body>
<div class="login-card">
  <h1>Quest Log</h1>
  <p>Enter your access code to view the board.</p>
  <form id="login-form">
    <input type="text" class="code-input" id="code" placeholder="XXXX-XXXX"
           maxlength="9" autocomplete="off" autofocus spellcheck="false">
    <button type="submit" class="submit-btn">Enter</button>
  </form>
  ${errorHtml}
  <div class="hint">
    Generate a code with <code>ql board-code</code><br>
    or ask your agent for a board access code
  </div>
</div>
<script>
  const form = document.getElementById('login-form');
  const input = document.getElementById('code');
  const btn = form.querySelector('button');

  input.addEventListener('input', () => {
    let v = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4, 8);
    input.value = v;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    btn.disabled = true;
    btn.textContent = 'Verifying...';
    try {
      const res = await fetch('/board/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) { showError(data.error || 'Invalid code'); return; }
      localStorage.setItem('ql_board_token', data.token);
      document.cookie = 'ql_board_token=' + data.token + '; path=/board; max-age=' + (data.expires_in_days * 86400) + '; SameSite=Lax';
      window.location.reload();
    } catch { showError('Connection failed'); }
    finally { btn.disabled = false; btn.textContent = 'Enter'; }
  });

  function showError(msg) {
    let el = document.querySelector('.error-msg');
    if (!el) { el = document.createElement('div'); el.className = 'error-msg'; form.parentNode.insertBefore(el, form.nextSibling); }
    el.textContent = msg;
  }

  const stored = localStorage.getItem('ql_board_token');
  if (stored && !document.cookie.includes('ql_board_token')) {
    document.cookie = 'ql_board_token=' + stored + '; path=/board; max-age=' + (30 * 86400) + '; SameSite=Lax';
    window.location.reload();
  }
</script>
</body>
</html>`;
}

// ── Board Page ──────────────────────────────────────────────────

function renderBoard(data: BoardData): string {
  const { ownedTasks, triageTasks, doneTasks } = data;

  const ownedHtml = ownedTasks.map((t, i) => renderTaskCard(t, data, i)).join('');
  const triageHtml = triageTasks.map((t, i) => renderTaskCard(t, data, i)).join('');
  const doneHtml = doneTasks.map((t, i) => renderTaskCard(t, data, i)).join('');
  const openTotal = ownedTasks.length + triageTasks.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quest Log</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"><\/script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #f5f5f7;
    --surface: #ffffff;
    --surface-hover: #fafafe;
    --border: #e2e2ea;
    --border-hover: #c8c8d4;
    --text: #1a1a2e;
    --text-dim: #5a5a72;
    --text-muted: #9898ab;
    --accent: #6c5ce7;
    --accent-soft: rgba(108, 92, 231, 0.07);
    --accent-medium: rgba(108, 92, 231, 0.12);
    --green: #00b894;
    --green-soft: rgba(0, 184, 148, 0.08);
    --amber: #e17055;
    --amber-soft: rgba(225, 112, 85, 0.08);
    --red: #d63031;
    --red-soft: rgba(214, 48, 49, 0.06);
    --triage: #0984e3;
    --triage-soft: rgba(9, 132, 227, 0.07);
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md: 0 4px 14px rgba(0,0,0,0.05), 0 2px 6px rgba(0,0,0,0.03);
    --shadow-lg: 0 10px 30px rgba(0,0,0,0.08), 0 4px 10px rgba(0,0,0,0.04);
    --radius: 12px;
  }

  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
  }

  /* Header */
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 2.5rem;
  }

  header h1 {
    font-size: 1.6rem;
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.03em;
  }

  header .subtitle {
    color: var(--text-muted);
    font-size: 0.85rem;
    margin-top: 0.25rem;
  }

  .logout-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: 'Inter', sans-serif;
    font-size: 0.75rem;
    padding: 0.4rem 0.9rem;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
    box-shadow: var(--shadow-sm);
  }
  .logout-btn:hover { border-color: var(--border-hover); color: var(--text); box-shadow: var(--shadow-md); }

  /* Sections */
  .section { margin-bottom: 2.5rem; }

  .section-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 1rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .section-header h2 {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }

  .section-header .count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 500;
  }

  .section-header .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .section.active .dot { background: var(--green); box-shadow: 0 0 6px rgba(0, 184, 148, 0.4); animation: pulse 2.5s ease-in-out infinite; }
  .section.triage .dot { background: var(--triage); box-shadow: 0 0 6px rgba(9, 132, 227, 0.3); animation: pulse 2.5s ease-in-out infinite; }
  .section.done .dot { background: var(--text-muted); }

  /* Card grid */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 0.75rem;
  }

  /* Cards */
  .task-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.15rem;
    cursor: pointer;
    position: relative;
    overflow: hidden;
    box-shadow: var(--shadow-sm);
    opacity: 0;
    transform: translateY(12px);
    will-change: transform, box-shadow;
  }

  .task-card::before {
    content: '';
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 3px;
    border-radius: 3px 0 0 3px;
  }

  .task-card.status-active::before { background: var(--green); }
  .task-card.status-triage::before { background: var(--triage); }
  .task-card.status-done::before { background: var(--text-muted); opacity: 0.4; }
  .task-card.status-cancelled::before { background: var(--red); opacity: 0.3; }

  .task-card.priority-0 { border-left: 3px solid var(--red); }
  .task-card.priority-1 { border-left: 3px solid var(--amber); }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .task-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    color: var(--text-muted);
  }

  .owner {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--accent);
    padding: 0.12rem 0.5rem;
    background: var(--accent-soft);
    border-radius: 999px;
  }
  .owner.triage-label { color: var(--triage); background: var(--triage-soft); }

  .task-title {
    font-size: 0.9rem;
    font-weight: 600;
    line-height: 1.45;
    margin-bottom: 0.55rem;
    letter-spacing: -0.01em;
    color: var(--text);
  }

  .card-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.65rem;
    color: var(--text-dim);
  }

  .tag {
    padding: 0.12rem 0.4rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
  }

  .attachment-count { color: var(--amber); font-weight: 500; }

  .latest-event {
    margin-top: 0.55rem;
    padding-top: 0.45rem;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.65rem;
  }

  .event-type {
    font-family: 'JetBrains Mono', monospace;
    color: var(--accent);
    font-size: 0.6rem;
    padding: 0.1rem 0.35rem;
    background: var(--accent-soft);
    border-radius: 4px;
    font-weight: 500;
  }

  .event-actor { color: var(--text-dim); }
  .event-time { color: var(--text-muted); margin-left: auto; }

  .event-body {
    font-size: 0.7rem;
    color: var(--text-dim);
    margin-top: 0.35rem;
    line-height: 1.5;
    max-height: 2.8em;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-done .task-title,
  .status-cancelled .task-title { opacity: 0.45; }
  .status-cancelled .task-title { text-decoration: line-through; }

  .empty {
    color: var(--text-muted);
    font-size: 0.85rem;
    font-style: italic;
    padding: 1.5rem 0;
  }

  /* Modal overlay */
  .modal-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(4px);
    z-index: 100;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }
  .modal-overlay.open { display: flex; }

  .modal {
    background: var(--surface);
    border-radius: 16px;
    width: 100%;
    max-width: 640px;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.12), 0 8px 20px rgba(0,0,0,0.06);
    padding: 2rem;
    position: relative;
  }

  .modal-close {
    position: absolute;
    top: 1rem;
    right: 1rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text-dim);
    font-size: 1rem;
    transition: all 0.15s;
  }
  .modal-close:hover { background: var(--border); color: var(--text); }

  .modal-loading {
    text-align: center;
    padding: 3rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .modal h2 {
    font-size: 1.15rem;
    font-weight: 700;
    margin-bottom: 1rem;
    padding-right: 2.5rem;
    line-height: 1.4;
  }

  .modal-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
    font-size: 0.8rem;
  }

  .modal-meta .meta-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .meta-label { color: var(--text-muted); font-weight: 500; }
  .meta-value { color: var(--text-dim); }
  .meta-value.status-open { color: var(--green); font-weight: 600; }
  .meta-value.status-done { color: var(--text-muted); }
  .meta-value.status-cancelled { color: var(--red); }

  /* Attachments in modal */
  .modal-section {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }

  .modal-section h3 {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    margin-bottom: 0.75rem;
  }

  .attachment-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.65rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 0.4rem;
    font-size: 0.8rem;
    transition: all 0.15s;
    text-decoration: none;
    color: var(--text);
  }
  .attachment-item:hover { border-color: var(--accent); background: var(--accent-soft); }

  .attachment-icon {
    width: 28px;
    height: 28px;
    background: var(--accent-soft);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    font-size: 0.7rem;
    font-weight: 600;
    flex-shrink: 0;
  }

  .attachment-info { flex: 1; min-width: 0; }
  .attachment-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attachment-desc { font-size: 0.7rem; color: var(--text-muted); margin-top: 0.1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attachment-size { font-size: 0.65rem; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; flex-shrink: 0; }

  /* Events timeline in modal */
  .event-item {
    display: flex;
    gap: 0.6rem;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--bg);
    font-size: 0.8rem;
  }
  .event-item:last-child { border-bottom: none; }

  .event-dot-wrap {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 0.35rem;
    flex-shrink: 0;
  }
  .event-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
  }
  .event-line {
    width: 1px;
    flex: 1;
    background: var(--border);
    margin-top: 0.3rem;
  }

  .event-content { flex: 1; min-width: 0; }
  .event-header { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
  .event-type-tag {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    font-weight: 500;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }
  .event-actor-name { font-weight: 500; color: var(--text-dim); font-size: 0.75rem; }
  .event-timestamp { color: var(--text-muted); font-size: 0.7rem; margin-left: auto; }
  .event-body-text { margin-top: 0.3rem; color: var(--text-dim); line-height: 1.55; font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; }

  /* Animations */
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  /* Header actions */
  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  /* Tab navigation */
  .tab-nav {
    display: flex;
    gap: 0.25rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.2rem;
  }

  .tab-btn {
    font-family: 'Inter', sans-serif;
    font-size: 0.75rem;
    font-weight: 500;
    padding: 0.35rem 0.85rem;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    transition: all 0.2s;
  }
  .tab-btn:hover { color: var(--text); }
  .tab-btn.active { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); font-weight: 600; }

  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* Notifications panel */
  .notif-container { max-width: 600px; }

  .notif-header { margin-bottom: 1.5rem; }
  .notif-header h2 { font-size: 1.1rem; font-weight: 700; margin-bottom: 0.3rem; }
  .notif-subtitle { font-size: 0.85rem; color: var(--text-dim); line-height: 1.5; }
  .notif-subtitle a { color: var(--accent); text-decoration: none; }
  .notif-subtitle a:hover { text-decoration: underline; }

  .notif-loading { color: var(--text-muted); font-size: 0.85rem; padding: 2rem 0; }

  .notif-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
    box-shadow: var(--shadow-sm);
    margin-bottom: 1rem;
  }

  .notif-card h3 { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.5rem; }

  .notif-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .notif-status-badge {
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    background: var(--green-soft);
    color: var(--green);
  }

  .notif-delete-btn {
    font-family: 'Inter', sans-serif;
    font-size: 0.7rem;
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--red);
    cursor: pointer;
    transition: all 0.15s;
  }
  .notif-delete-btn:hover { background: var(--red-soft); border-color: var(--red); }

  .notif-topic-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
  }

  .notif-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .notif-topic-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 0.2rem 0.5rem;
    border-radius: 6px;
    user-select: all;
  }

  .notif-events-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .notif-event-tag {
    font-size: 0.65rem;
    font-family: 'JetBrains Mono', monospace;
    padding: 0.15rem 0.45rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text-dim);
  }

  .notif-setup-hint {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
    box-shadow: var(--shadow-sm);
  }

  .notif-setup-hint h3 {
    font-size: 0.8rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
    color: var(--text-dim);
  }

  .notif-setup-hint ol {
    padding-left: 1.25rem;
    font-size: 0.82rem;
    color: var(--text-dim);
    line-height: 1.8;
  }

  .notif-setup-hint code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    background: var(--accent-soft);
    color: var(--accent);
    padding: 0.15rem 0.4rem;
    border-radius: 4px;
    user-select: all;
  }

  .notif-setup-hint a { color: var(--accent); text-decoration: none; }
  .notif-setup-hint a:hover { text-decoration: underline; }

  .notif-qr-section {
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
  }

  #notif-qr {
    border: 1px solid var(--border);
    border-radius: 8px;
    flex-shrink: 0;
  }

  .notif-qr-instructions { flex: 1; }
  .notif-qr-instructions ol { margin-bottom: 1rem; }

  .notif-manual-url {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border);
  }

  .notif-manual-url .notif-label { display: block; margin-bottom: 0.3rem; font-size: 0.7rem; }

  .notif-form-hint { font-size: 0.82rem; color: var(--text-dim); margin-bottom: 1rem; }

  .notif-event-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
  }

  .notif-event-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.65rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s;
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .notif-event-option:hover { border-color: var(--accent); }
  .notif-event-option.selected { border-color: var(--accent); background: var(--accent-soft); color: var(--text); }
  .notif-event-option input { display: none; }

  .notif-event-check {
    width: 16px;
    height: 16px;
    border: 1.5px solid var(--border);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 0.15s;
    font-size: 0.65rem;
    color: transparent;
  }
  .notif-event-option.selected .notif-event-check {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }

  .notif-save-btn {
    width: 100%;
    padding: 0.7rem;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 10px;
    font-family: 'Inter', sans-serif;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .notif-save-btn:hover { opacity: 0.9; }
  .notif-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  @media (max-width: 640px) {
    .container { padding: 1rem; }
    .card-grid { grid-template-columns: 1fr; }
    header h1 { font-size: 1.3rem; }
    .modal { padding: 1.25rem; margin: 1rem; max-height: 90vh; }
    .notif-event-grid { grid-template-columns: 1fr; }
    .header-actions { flex-direction: column; align-items: flex-end; gap: 0.4rem; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>Quest Log</h1>
      <p class="subtitle">${openTotal} open &middot; ${doneTasks.length} completed</p>
    </div>
    <div class="header-actions">
      <nav class="tab-nav">
        <button class="tab-btn active" data-tab="board">Board</button>
        <button class="tab-btn" data-tab="notifications">Notifications</button>
      </nav>
      <button class="logout-btn" onclick="logout()">Sign out</button>
    </div>
  </header>

  <div class="tab-panel active" id="panel-board">
  ${ownedTasks.length > 0 ? `
  <div class="section active">
    <div class="section-header">
      <div class="dot"></div>
      <h2>In Progress</h2>
      <span class="count">${ownedTasks.length}</span>
    </div>
    <div class="card-grid">${ownedHtml}</div>
  </div>` : ''}

  ${triageTasks.length > 0 ? `
  <div class="section triage">
    <div class="section-header">
      <div class="dot"></div>
      <h2>Triage</h2>
      <span class="count">${triageTasks.length}</span>
    </div>
    <div class="card-grid">${triageHtml}</div>
  </div>` : ''}

  ${doneTasks.length > 0 ? `
  <div class="section done">
    <div class="section-header">
      <div class="dot"></div>
      <h2>Recently Completed</h2>
      <span class="count">${doneTasks.length}</span>
    </div>
    <div class="card-grid">${doneHtml}</div>
  </div>` : ''}

  ${openTotal === 0 && doneTasks.length === 0 ? `
  <div class="empty">No tasks yet. Create one with your agent or the ql CLI.</div>` : ''}
  </div>

  <div class="tab-panel" id="panel-notifications">
    <div class="notif-container">
      <div class="notif-header">
        <h2>Push Notifications</h2>
        <p class="notif-subtitle">Get notified on your phone when task events happen via <a href="https://ntfy.sh" target="_blank">ntfy</a>.</p>
      </div>

      <div id="notif-loading" class="notif-loading">Loading...</div>
      <div id="notif-content" style="display:none">
        <div id="notif-active" style="display:none">
          <div class="notif-card">
            <div class="notif-card-header">
              <span class="notif-status-badge">Active</span>
              <button class="notif-delete-btn" id="notif-delete">Remove</button>
            </div>
            <div class="notif-topic-row">
              <span class="notif-label">Topic</span>
              <code class="notif-topic-value" id="notif-topic"></code>
            </div>
            <div class="notif-events-row" id="notif-events-list"></div>
          </div>
          <div class="notif-setup-hint">
            <h3>Setup</h3>
            <div class="notif-qr-section">
              <canvas id="notif-qr" width="200" height="200"></canvas>
              <div class="notif-qr-instructions">
                <ol>
                  <li>Install the <a href="https://ntfy.sh" target="_blank">ntfy app</a> on your phone</li>
                  <li>Scan this QR code with your phone camera</li>
                  <li>It will open the ntfy app and auto-subscribe</li>
                </ol>
                <div class="notif-manual-url">
                  <span class="notif-label">Or subscribe manually to:</span>
                  <code id="notif-subscribe-url"></code>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div id="notif-setup" style="display:none">
          <div class="notif-card">
            <h3>Subscribe to events</h3>
            <p class="notif-form-hint">Choose which events trigger a push notification:</p>
            <div class="notif-event-grid" id="notif-event-checkboxes"></div>
            <button class="notif-save-btn" id="notif-save">Enable Notifications</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Task detail modal -->
<div class="modal-overlay" id="modal-overlay">
  <div class="modal" id="modal">
    <button class="modal-close" id="modal-close">&times;</button>
    <div id="modal-content">
      <div class="modal-loading">Loading...</div>
    </div>
  </div>
</div>

<script>
  // ── GSAP entrance animations ──────────────────────────────
  gsap.set('.task-card', { opacity: 0, y: 16 });
  gsap.to('.task-card', {
    opacity: 1, y: 0,
    duration: 0.5,
    stagger: 0.06,
    ease: 'back.out(1.4)',
    delay: 0.1,
  });

  gsap.from('header', { opacity: 0, y: -12, duration: 0.5, ease: 'power2.out' });
  gsap.from('.section-header', { opacity: 0, x: -10, duration: 0.4, stagger: 0.1, ease: 'power2.out', delay: 0.2 });

  // ── Card hover animations ────────────────────────────────
  document.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('mouseenter', () => {
      gsap.to(card, {
        y: -4,
        scale: 1.015,
        boxShadow: '0 8px 24px rgba(0,0,0,0.08), 0 4px 8px rgba(0,0,0,0.04)',
        duration: 0.35,
        ease: 'back.out(2)',
      });
    });
    card.addEventListener('mouseleave', () => {
      gsap.to(card, {
        y: 0,
        scale: 1,
        boxShadow: '0 1px 3px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.04)',
        duration: 0.4,
        ease: 'power2.out',
      });
    });
  });

  // ── Modal ─────────────────────────────────────────────────
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal');
  const modalContent = document.getElementById('modal-content');
  const modalClose = document.getElementById('modal-close');

  function getToken() {
    return localStorage.getItem('ql_board_token') || '';
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function fileExt(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts.pop().toUpperCase().slice(0, 4) : '?';
  }

  function timeAgo(dateStr) {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  async function openTask(taskId) {
    modalContent.innerHTML = '<div class="modal-loading">Loading...</div>';
    overlay.classList.add('open');
    gsap.fromTo(modal, { opacity: 0, scale: 0.92, y: 20 }, { opacity: 1, scale: 1, y: 0, duration: 0.4, ease: 'back.out(1.6)' });
    gsap.fromTo(overlay, { backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: 'rgba(0,0,0,0.25)', duration: 0.3 });

    try {
      const res = await fetch('/board/task/' + taskId, {
        headers: { 'Authorization': 'Bearer ' + getToken() },
      });
      if (!res.ok) throw new Error('Failed to load task');
      const data = await res.json();
      renderTaskDetail(data);
    } catch (err) {
      modalContent.innerHTML = '<div class="modal-loading">Failed to load task details.</div>';
    }
  }

  function renderTaskDetail(data) {
    const { task, events, attachments, users } = data;
    const statusClass = 'status-' + task.status;
    const owner = task.owner_id ? users[task.owner_id] : null;
    const creator = users[task.creator_id];

    let html = '<h2>' + esc(task.title) + '</h2>';
    html += '<div class="modal-meta">';
    html += '<div class="meta-item"><span class="meta-label">Status</span><span class="meta-value ' + statusClass + '">' + task.status + '</span></div>';
    if (owner) html += '<div class="meta-item"><span class="meta-label">Owner</span><span class="meta-value">' + esc(owner.name) + '</span></div>';
    if (creator) html += '<div class="meta-item"><span class="meta-label">Creator</span><span class="meta-value">' + esc(creator.name) + '</span></div>';
    if (task.priority != null) html += '<div class="meta-item"><span class="meta-label">Priority</span><span class="meta-value">P' + task.priority + '</span></div>';
    if (task.due_date) html += '<div class="meta-item"><span class="meta-label">Due</span><span class="meta-value">' + new Date(task.due_date).toLocaleDateString() + '</span></div>';
    if (task.tags && task.tags.length) html += '<div class="meta-item"><span class="meta-label">Tags</span><span class="meta-value">' + task.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join(' ') + '</span></div>';
    html += '<div class="meta-item"><span class="meta-label">Created</span><span class="meta-value">' + timeAgo(task.created_at) + '</span></div>';
    html += '</div>';

    // Attachments
    if (attachments.length > 0) {
      html += '<div class="modal-section"><h3>Attachments</h3>';
      for (const a of attachments) {
        html += '<a href="' + esc(a.download_url) + '" target="_blank" class="attachment-item">';
        html += '<div class="attachment-icon">' + fileExt(a.filename) + '</div>';
        html += '<div class="attachment-info">';
        html += '<div class="attachment-name">' + esc(a.filename) + '</div>';
        if (a.description) html += '<div class="attachment-desc">' + esc(a.description) + '</div>';
        html += '</div>';
        html += '<span class="attachment-size">' + formatBytes(a.size_bytes) + '</span>';
        html += '</a>';
      }
      html += '</div>';
    }

    // Events timeline
    if (events.length > 0) {
      html += '<div class="modal-section"><h3>Activity</h3>';
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const actor = users[e.actor_id];
        const isLast = i === events.length - 1;
        html += '<div class="event-item">';
        html += '<div class="event-dot-wrap"><div class="event-dot"></div>' + (isLast ? '' : '<div class="event-line"></div>') + '</div>';
        html += '<div class="event-content">';
        html += '<div class="event-header">';
        html += '<span class="event-type-tag">' + esc(e.event_type) + '</span>';
        if (actor) html += '<span class="event-actor-name">' + esc(actor.name) + '</span>';
        html += '<span class="event-timestamp">' + timeAgo(e.created_at) + '</span>';
        html += '</div>';
        if (e.body) html += '<div class="event-body-text">' + esc(e.body) + '</div>';
        html += '</div></div>';
      }
      html += '</div>';
    }

    modalContent.innerHTML = html;

    // Animate modal content in
    gsap.from(modalContent.children, { opacity: 0, y: 8, stagger: 0.04, duration: 0.3, ease: 'power2.out' });
  }

  function closeModal() {
    gsap.to(modal, { opacity: 0, scale: 0.95, y: 10, duration: 0.25, ease: 'power2.in' });
    gsap.to(overlay, { backgroundColor: 'rgba(0,0,0,0)', duration: 0.25, onComplete: () => overlay.classList.remove('open') });
  }

  modalClose.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal(); });

  // Click handlers for task cards
  document.querySelectorAll('.task-card').forEach(card => {
    card.addEventListener('click', () => {
      const taskId = card.dataset.taskId;
      if (taskId) openTask(taskId);
    });
  });

  function logout() {
    localStorage.removeItem('ql_board_token');
    document.cookie = 'ql_board_token=; path=/board; max-age=0';
    window.location.reload();
  }

  // ── Tab switching ──────────────────────────────────────────
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + tab).classList.add('active');
      if (tab === 'notifications') loadNotifications();
    });
  });

  // ── Notifications ──────────────────────────────────────────
  const EVENT_LABELS = {
    assigned_to_me: 'Assigned to me',
    task_completed: 'Task completed',
    task_blocked: 'Task blocked',
    task_unblocked: 'Task unblocked',
    comment_added: 'Comment added',
    field_changed: 'Field changed',
  };

  let notifLoaded = false;

  async function loadNotifications() {
    if (notifLoaded) return;
    const loadingEl = document.getElementById('notif-loading');
    const contentEl = document.getElementById('notif-content');

    try {
      const res = await fetch('/board/notifications', {
        headers: { 'Authorization': 'Bearer ' + getToken() },
      });
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();

      loadingEl.style.display = 'none';
      contentEl.style.display = 'block';

      if (data.subscriptions.length > 0) {
        showActiveSubscription(data.subscriptions[0]);
      } else {
        showSetupForm(data.available_events);
      }
      notifLoaded = true;
    } catch (err) {
      loadingEl.textContent = 'Failed to load notifications.';
    }
  }

  function renderQR(text) {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const canvas = document.getElementById('notif-qr');
      const ctx = canvas.getContext('2d');
      const count = qr.getModuleCount();
      const size = 200;
      const cellSize = size / (count + 8); // padding
      const offset = (size - count * cellSize) / 2;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#1a1a2e';
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(offset + c * cellSize, offset + r * cellSize, cellSize + 0.5, cellSize + 0.5);
          }
        }
      }
    } catch (e) { console.error('QR render error:', e); }
  }

  function showActiveSubscription(sub) {
    document.getElementById('notif-active').style.display = 'block';
    document.getElementById('notif-setup').style.display = 'none';

    document.getElementById('notif-topic').textContent = sub.topic;
    const ntfyBase = location.origin.replace(/:\\d+/, ':8080');
    const subscribeUrl = ntfyBase + '/' + sub.topic;
    document.getElementById('notif-subscribe-url').textContent = subscribeUrl;

    // Render QR code with ntfy:// deep link
    const deepLink = 'ntfy://' + location.hostname + ':8080/' + sub.topic;
    renderQR(deepLink);

    const eventsEl = document.getElementById('notif-events-list');
    eventsEl.innerHTML = sub.events.map(e =>
      '<span class="notif-event-tag">' + esc(EVENT_LABELS[e] || e) + '</span>'
    ).join('');

    document.getElementById('notif-delete').onclick = async () => {
      if (!confirm('Remove notification subscription?')) return;
      await fetch('/board/notifications/' + sub.id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + getToken() },
      });
      notifLoaded = false;
      document.getElementById('notif-active').style.display = 'none';
      loadNotifications();
    };

    gsap.from('#notif-active', { opacity: 0, y: 10, duration: 0.4, ease: 'power2.out' });
  }

  function showSetupForm(availableEvents) {
    document.getElementById('notif-active').style.display = 'none';
    document.getElementById('notif-setup').style.display = 'block';

    const grid = document.getElementById('notif-event-checkboxes');
    grid.innerHTML = availableEvents.map(evt => {
      const label = EVENT_LABELS[evt] || evt.replace(/_/g, ' ');
      return '<label class="notif-event-option selected" data-event="' + evt + '">' +
        '<input type="checkbox" checked>' +
        '<span class="notif-event-check">\\u2713</span>' +
        '<span>' + esc(label) + '</span>' +
        '</label>';
    }).join('');

    grid.querySelectorAll('.notif-event-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.preventDefault();
        opt.classList.toggle('selected');
        opt.querySelector('input').checked = opt.classList.contains('selected');
      });
    });

    document.getElementById('notif-save').onclick = async () => {
      const selected = [];
      grid.querySelectorAll('.notif-event-option.selected').forEach(opt => {
        selected.push(opt.dataset.event);
      });
      if (selected.length === 0) { alert('Select at least one event'); return; }

      const btn = document.getElementById('notif-save');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      try {
        const res = await fetch('/board/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + getToken(),
          },
          body: JSON.stringify({ events: selected }),
        });
        if (!res.ok) throw new Error('Failed to save');
        const data = await res.json();
        showActiveSubscription(data.subscription);
      } catch (err) {
        alert('Failed to save notification subscription');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Enable Notifications';
      }
    };

    gsap.from('#notif-setup', { opacity: 0, y: 10, duration: 0.4, ease: 'power2.out' });
  }
</script>
</body>
</html>`;
}
