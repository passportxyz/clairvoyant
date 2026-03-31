import express, { Router } from 'express';
import type { Request, Response } from 'express';
import pg from 'pg';
import { requireAuth, optionalAuth, getActorId } from './middleware.js';
import {
  getUserById,
  listUsers,
  activateUser,
  setAdmin,
  listPendingUsers,
  getActiveKeyForUser,
  approveKey,
  revokeKey,
  deleteUser,
  listWebhooks,
  deleteWebhook,
} from './db/queries.js';
import { acquireBootstrapLock, hasAnyAdmin } from './db/queries.js';
import { registerWebhook } from './tools/webhooks.js';

// ---------------------------------------------------------------------------
// Admin check middleware
// ---------------------------------------------------------------------------

async function requireAdmin(req: Request, res: Response, next: () => void): Promise<void> {
  const actorId = getActorId(req);
  const pool = (req as unknown as { _pool: pg.Pool })._pool;
  const client = await pool.connect();
  try {
    const actor = await getUserById(client, actorId);
    if (!actor?.is_admin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }
    next();
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createAdminRouter(pool: pg.Pool): Router {
  const router = Router();

  // Parse JSON bodies for admin routes
  router.use(express.json());

  // Attach pool to request for middleware use
  router.use((req: Request, _res: Response, next: () => void) => {
    (req as unknown as { _pool: pg.Pool })._pool = pool;
    next();
  });

  // ── POST /admin/set-admin (before requireAuth — supports bootstrap) ──
  router.post('/set-admin', optionalAuth, async (req: Request, res: Response) => {
    const { user_id } = req.body as { user_id?: string };
    if (!user_id) {
      res.status(400).json({ error: 'user_id is required' });
      return;
    }

    const actorId = getActorId(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await acquireBootstrapLock(client);
      const adminExists = await hasAnyAdmin(client);

      if (adminExists) {
        if (!actorId) {
          await client.query('ROLLBACK');
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
        const actor = await getUserById(client, actorId);
        if (!actor?.is_admin) {
          await client.query('ROLLBACK');
          res.status(403).json({ error: 'Only admins can promote other users' });
          return;
        }
      }

      await activateUser(client, user_id);

      const key = await getActiveKeyForUser(client, user_id);
      if (key && key.status === 'pending') {
        await approveKey(client, key.id, actorId ?? user_id);
      }

      const user = await setAdmin(client, user_id, true);
      await client.query('COMMIT');

      const result: { user: typeof user; warning?: string } = { user };
      if (!adminExists) {
        result.warning = 'First admin set — registration is now locked down.';
      }
      res.json(result);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  // All remaining admin routes require auth
  router.use(requireAuth);

  // ── POST /admin/revoke-self ──────────────────────────────────────
  // Only way to remove admin status — you can only revoke your own
  router.post('/revoke-self', async (req: Request, res: Response) => {
    const actorId = getActorId(req);
    const client = await pool.connect();
    try {
      const actor = await getUserById(client, actorId);
      if (!actor?.is_admin) {
        res.status(400).json({ error: 'You are not an admin' });
        return;
      }
      const user = await setAdmin(client, actorId, false);
      res.json({ user });
    } finally {
      client.release();
    }
  });

  // ── GET /admin/users ─────────────────────────────────────────────
  router.get('/users', requireAdmin, async (_req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const users = await listUsers(client);
      res.json({ users });
    } finally {
      client.release();
    }
  });

  // ── GET /admin/pending ───────────────────────────────────────────
  router.get('/pending', requireAdmin, async (_req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const users = await listPendingUsers(client);
      res.json({ users });
    } finally {
      client.release();
    }
  });

  // ── POST /admin/approve ──────────────────────────────────────────
  router.post('/approve', requireAdmin, async (req: Request, res: Response) => {
    const { user_id } = req.body as { user_id?: string };
    if (!user_id) {
      res.status(400).json({ error: 'user_id is required' });
      return;
    }

    const actorId = getActorId(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await activateUser(client, user_id);
      const key = await getActiveKeyForUser(client, user_id);
      let keyResult: { id: string; status: string } | undefined;
      if (key && key.status === 'pending') {
        const approved = await approveKey(client, key.id, actorId);
        keyResult = { id: approved.id, status: approved.status };
      }
      await client.query('COMMIT');
      res.json({ user, key: keyResult });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  // ── POST /admin/revoke-key ───────────────────────────────────────
  router.post('/revoke-key', requireAdmin, async (req: Request, res: Response) => {
    const { user_id } = req.body as { user_id?: string };
    if (!user_id) {
      res.status(400).json({ error: 'user_id is required' });
      return;
    }

    const client = await pool.connect();
    try {
      const key = await getActiveKeyForUser(client, user_id);
      if (!key) {
        res.status(404).json({ error: 'No active key found for this user' });
        return;
      }
      await revokeKey(client, key.id);
      res.json({ revoked: true });
    } finally {
      client.release();
    }
  });

  // ── DELETE /admin/users/:id ──────────────────────────────────────
  router.delete('/users/:id', requireAdmin, async (req: Request, res: Response) => {
    const userId = req.params.id as string;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await deleteUser(client, userId);
      await client.query('COMMIT');
      res.json({ deleted: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  // ── POST /admin/webhooks ─────────────────────────────────────────
  router.post('/webhooks', requireAdmin, async (req: Request, res: Response) => {
    const { url, events } = req.body as { url?: string; events?: string[] };
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'url is required and must be a string' });
      return;
    }
    if (!events || !Array.isArray(events) || events.length === 0) {
      res.status(400).json({ error: 'events is required and must be a non-empty array' });
      return;
    }

    const actorId = getActorId(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await registerWebhook(client, actorId, { url, events });
      await client.query('COMMIT');
      res.json(result);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  // ── GET /admin/webhooks ──────────────────────────────────────────
  router.get('/webhooks', requireAdmin, async (_req: Request, res: Response) => {
    const client = await pool.connect();
    try {
      const webhooks = await listWebhooks(client);
      res.json({ webhooks });
    } finally {
      client.release();
    }
  });

  // ── DELETE /admin/webhooks/:id ───────────────────────────────────
  router.delete('/webhooks/:id', requireAdmin, async (req: Request, res: Response) => {
    const webhookId = req.params.id as string;
    const client = await pool.connect();
    try {
      await deleteWebhook(client, webhookId);
      res.json({ deleted: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  return router;
}
