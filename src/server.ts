import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));

import { getPool, shutdown } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { verifyToken } from './auth.js';
import { AuthError } from './types.js';
import { processSideEffects } from './webhooks.js';
import { processNotification } from './ntfy.js';
import { checkUnblocks } from './unblock.js';
import { clearStaleAlert } from './staleness.js';

// Tool handlers
import { createTask } from './tools/tasks.js';
import { getTask } from './tools/tasks.js';
import { updateTask } from './tools/events.js';
import { claimTask } from './tools/events.js';
import { listTasks, listUsers, getAttachmentById } from './db/queries.js';
import { createAdminRouter } from './admin.js';
import { createAuthRouter } from './auth-router.js';
import { createAttachmentsRouter } from './attachments-router.js';
import { attachFile } from './tools/attachments.js';
import { generateAccessCode } from './access-codes.js';
import { createBoardRouter, generateBoardCode } from './board-router.js';
import { subscribeNotifications, listNotificationSubscriptions, unsubscribeNotifications } from './tools/notifications.js';
import { NOTIFICATION_EVENTS } from './ntfy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getActorIdFromAuth(authInfo?: AuthInfo): string {
  if (!authInfo?.extra?.actorId) {
    throw new AuthError('Authentication required — provide a Bearer token', 'missing_token');
  }
  return authInfo.extra.actorId as string;
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

type ToolHandler<T> = (client: import('pg').PoolClient, actorId: string, params: T) => Promise<unknown>;

/**
 * Wrap a tool handler with: auth, pool connection, transaction, error handling.
 * Write handlers get BEGIN/COMMIT/ROLLBACK. Side effects are processed after commit.
 * Auth is extracted from the MCP extra.authInfo (populated by HTTP middleware).
 */
function withClient<T>(handler: ToolHandler<T>, opts: { write?: boolean } = {}) {
  return async (params: T, extra: { authInfo?: AuthInfo }) => {
    try {
      const actorId = getActorIdFromAuth(extra.authInfo);
      const pool = getPool();
      const client = await pool.connect();
      try {
        if (opts.write) await client.query('BEGIN');
        const result = await handler(client, actorId, params);
        if (opts.write) await client.query('COMMIT');

        // Process side effects after commit
        processSideEffectsFromResult(result);

        return textResult(result);
      } catch (err) {
        if (opts.write) await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  };
}


/**
 * Fire-and-forget side effect processing after a successful commit.
 */
function processSideEffectsFromResult(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const r = result as Record<string, unknown>;
  const sideEffects = r.sideEffects as Array<{ type: string; eventType?: string; taskId?: string }> | undefined;
  if (!sideEffects || sideEffects.length === 0) return;

  const event = r.event as import('./types.js').Event | undefined;
  const task = r.task as import('./types.js').Task | undefined;

  const pool = getPool();

  for (const effect of sideEffects) {
    if (effect.type === 'webhook' && effect.eventType && event && task) {
      processSideEffects(pool, [{ type: 'webhook', eventType: effect.eventType }], event, task).catch((err) => {
        console.error('Webhook dispatch error:', err);
      });
    } else if (effect.type === 'check_unblocks' && effect.taskId && event) {
      const client = pool.connect();
      client.then(async (c) => {
        try {
          await c.query('BEGIN');
          await checkUnblocks(c, effect.taskId!, event.actor_id);
          await c.query('COMMIT');
        } catch (err) {
          await c.query('ROLLBACK').catch(() => {});
          console.error('Unblock check error:', err);
        } finally {
          c.release();
        }
      }).catch((err) => {
        console.error('Unblock connection error:', err);
      });
    } else if (effect.type === 'notify' && event && task) {
      processNotification(pool, event, task).catch((err) => {
        console.error('Notification dispatch error:', err);
      });
    } else if (effect.type === 'staleness_reset' && task) {
      clearStaleAlert(task.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Server factory — one McpServer per session (SDK requires 1:1 server:transport)
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'questlog', version: pkg.version },
    { capabilities: { tools: {} } },
  );

  // ── create_task ──────────────────────────────────────────────────

  server.tool(
    'create_task',
    'Create a persistent tracked work item in Quest Log — for cross-session coordination, delegation between agents/humans, and work that needs an audit trail. Not for ephemeral to-dos or background processes.',
    {
      title: z.string(),
      body: z.string(),
      owner_id: z.string().optional(),
      parent_task_id: z.string().optional(),
      priority: z.number().optional(),
      due_date: z.string().optional().describe('ISO 8601 date string'),
      tags: z.array(z.string()).optional(),
      idempotency_key: z.string(),
    },
    withClient(async (client, actorId, params) => {
      const input = {
        ...params,
        due_date: params.due_date ? new Date(params.due_date) : undefined,
      };
      return createTask(client, actorId, input);
    }, { write: true }),
  );

  // ── list_tasks ───────────────────────────────────────────────────

  server.tool(
    'list_tasks',
    'List Quest Log work items with optional filters for status, owner, tags, parent, creator',
    {
      status: z.enum(['open', 'done', 'cancelled']).optional(),
      owner_id: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      parent_task_id: z.string().optional(),
      creator_id: z.string().optional(),
      cursor: z.string().optional(),
    },
    withClient(async (client, _actorId, params) => {
      return listTasks(client, params);
    }),
  );

  // ── get_task ─────────────────────────────────────────────────────

  server.tool(
    'get_task',
    'Get a Quest Log work item by ID, including its full event history',
    {
      task_id: z.string(),
    },
    withClient(async (client, actorId, params) => {
      return getTask(client, actorId, params);
    }),
  );

  // ── update_task ──────────────────────────────────────────────────

  server.tool(
    'update_task',
    'Update a Quest Log work item by appending an event (note, progress, handoff, field_changed, completed, cancelled, etc.)',
    {
      task_id: z.string(),
      event_type: z.enum([
        'created', 'note', 'progress', 'handoff', 'claimed',
        'blocked', 'unblocked', 'field_changed', 'completed', 'cancelled',
      ]),
      body: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      idempotency_key: z.string(),
    },
    withClient(async (client, actorId, params) => {
      return updateTask(client, actorId, params);
    }, { write: true }),
  );

  // ── claim_task ───────────────────────────────────────────────────

  server.tool(
    'claim_task',
    'Claim an unowned Quest Log work item — sets the caller as the owner',
    {
      task_id: z.string(),
      idempotency_key: z.string(),
    },
    withClient(async (client, actorId, params) => {
      return claimTask(client, actorId, params);
    }, { write: true }),
  );

  // ── list_users ──────────────────────────────────────────────────

  server.tool(
    'list_users',
    'List all active users — useful for discovering handoff targets',
    {},
    withClient(async (client, _actorId, _params) => {
      const users = await listUsers(client);
      return { users };
    }),
  );

  // ── attach_file ────────────────────────────────────────────────

  server.tool(
    'attach_file',
    'Attach a file to a task. Send file content as base64 with a filename. Max 10MB. Use for screenshots, logs, design mockups, or any artifact relevant to a task.',
    {
      task_id: z.string().describe('The task to attach the file to'),
      file_data: z.string().describe('Base64-encoded file content'),
      filename: z.string().describe('Original filename (e.g. screenshot.png)'),
      description: z.string().describe('What this attachment contains and why it is relevant'),
    },
    withClient(async (client, actorId, params) => {
      return attachFile(client, actorId, params);
    }, { write: true }),
  );

  // ── get_attachment_url ──────────────────────────────────────────

  server.tool(
    'get_attachment_url',
    'Generate a short-lived public download URL for an attachment. The link expires after 1 hour. Use when sharing attachment links in messages, handoffs, or notes.',
    {
      attachment_id: z.string().describe('The attachment ID'),
    },
    withClient(async (client, _actorId, params) => {
      const attachment = await getAttachmentById(client, params.attachment_id);
      if (!attachment) throw new Error(`Attachment not found: ${params.attachment_id}`);
      const code = generateAccessCode(params.attachment_id);
      const baseUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
      const url = `${baseUrl}/attachments/${params.attachment_id}?code=${code}`;
      return { url, expires_in: '1 hour', filename: attachment.filename };
    }),
  );

  // ── generate_board_code ──────────────────────────────────────────

  server.tool(
    'generate_board_code',
    'Generate a short-lived code that grants read-only board access for 30 days. The user enters this code at /board to authenticate. Code expires in 10 minutes if unused.',
    {},
    withClient(async (client, actorId, _params) => {
      const user = await import('./db/queries.js').then(m => m.getUserById(client, actorId));
      if (!user) throw new Error('User not found');
      const code = generateBoardCode(user.id, user.name);
      return { code, expires_in: '10 minutes', instructions: 'Enter this code at /board to access the Quest Log dashboard' };
    }),
  );

  // ── subscribe_notifications ────────────────────────────────────────

  server.tool(
    'subscribe_notifications',
    `Subscribe to push notifications for task events via ntfy. Valid events: ${NOTIFICATION_EVENTS.join(', ')}. If the user already has a subscription, this updates it. Agents can create subscriptions on behalf of users by passing user_id.`,
    {
      events: z.array(z.string()).describe('Notification events to subscribe to'),
      user_id: z.string().optional().describe('User ID to subscribe (for agents acting on behalf of a user). Defaults to caller.'),
    },
    withClient(async (client, actorId, params) => {
      return subscribeNotifications(client, actorId, params);
    }, { write: true }),
  );

  // ── list_notification_subscriptions ────────────────────────────────

  server.tool(
    'list_notification_subscriptions',
    'List notification subscriptions. Agents can pass user_id to list another user\'s subscriptions.',
    {
      user_id: z.string().optional().describe('User ID to list subscriptions for. Defaults to caller.'),
    },
    withClient(async (client, actorId, params) => {
      return listNotificationSubscriptions(client, actorId, params);
    }),
  );

  // ── unsubscribe_notifications ──────────────────────────────────────

  server.tool(
    'unsubscribe_notifications',
    'Remove a notification subscription. Agents can pass user_id to remove on behalf of a user.',
    {
      subscription_id: z.string().describe('The subscription ID to remove'),
      user_id: z.string().optional().describe('User ID who owns the subscription. Defaults to caller.'),
    },
    withClient(async (client, actorId, params) => {
      return unsubscribeNotifications(client, actorId, params);
    }, { write: true }),
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP Transport & startup
// ---------------------------------------------------------------------------

const MAX_SESSIONS = 100;

async function main() {
  const pool = getPool();

  // Run migrations on startup
  console.error('[questlog] Running migrations...');
  await runMigrations(pool);
  console.error('[questlog] Migrations complete.');

  // Start staleness checker
  const { startStalenessChecker } = await import('./staleness.js');
  startStalenessChecker(pool);
  console.error('[questlog] Staleness checker started.');

  // Express app with MCP defaults (JSON body parser, host validation)
  const app = createMcpExpressApp({ host: '0.0.0.0' });

  // Mount admin REST API (not MCP — CLI-only)
  app.use('/admin', createAdminRouter(pool));

  // Mount auth REST API (registration, challenge/response auth, user lookup)
  app.use('/auth', createAuthRouter(pool));

  // Mount attachments file serving
  app.use('/attachments', createAttachmentsRouter(pool));

  // Mount read-only board UI
  app.use('/board', createBoardRouter(pool));

  // JWT auth middleware — extracts Bearer token and attaches as AuthInfo
  app.use('/mcp', (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        const payload = verifyToken(token);
        (req as unknown as { auth: AuthInfo }).auth = {
          token,
          clientId: payload.sub,
          scopes: [],
          extra: { actorId: payload.sub, name: payload.name },
        };
      } catch {
        // Let unauthenticated requests through —
        // tools that require auth will fail in withClient
      }
    }
    next();
  });

  // Session management — one McpServer + transport per session
  const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

  app.all('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      // DELETE — terminate session per MCP spec
      if (req.method === 'DELETE' && sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          await session.transport.close();
          await session.server.close();
          sessions.delete(sessionId);
          res.status(204).end();
        } else {
          res.status(404).json({ error: 'Session not found' });
        }
        return;
      }

      if (sessionId && sessions.has(sessionId)) {
        // Existing session
        const session = sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res, req.body);
      } else if (sessionId && !sessions.has(sessionId)) {
        // Stale/unknown session ID
        res.status(404).json({ error: 'Session not found — re-initialize' });
      } else if (!sessionId && req.method === 'POST') {
        // New session — enforce cap to prevent memory exhaustion
        if (sessions.size >= MAX_SESSIONS) {
          res.status(503).json({ error: 'Too many active sessions' });
          return;
        }

        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sessionId) => {
            sessions.set(sessionId, { server, transport });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({ error: 'Bad Request: missing session ID' });
      }
    } catch (err) {
      console.error('[questlog] Request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: pkg.version, sessions: sessions.size });
  });

  const port = parseInt(process.env.PORT || '3000', 10);
  const httpServer = app.listen(port, '0.0.0.0', () => {
    console.error(`[questlog] MCP server listening on http://0.0.0.0:${port}/mcp`);
  });

  // Graceful shutdown
  const cleanup = async () => {
    console.error('[questlog] Shutting down...');
    httpServer.close();
    for (const { server, transport } of sessions.values()) {
      await transport.close();
      await server.close();
    }
    await shutdown();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('[questlog] Fatal error:', err);
  process.exit(1);
});
