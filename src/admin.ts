import express, { Router } from 'express';
import type { Request, Response } from 'express';
import { getPool } from './db/pool.js';
import { verifyToken } from './auth.js';
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

// ---------------------------------------------------------------------------
// Auth middleware for admin routes
// ---------------------------------------------------------------------------

interface AuthedRequest extends Request {
  actorId: string;
}

function requireAuth(req: Request, res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const payload = verifyToken(authHeader.slice(7));
    (req as unknown as AuthedRequest).actorId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function optionalAuth(req: Request, _res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(authHeader.slice(7));
      (req as unknown as AuthedRequest).actorId = payload.sub;
    } catch {
      // Ignore invalid token — set-admin bootstrap may not have one
    }
  }
  next();
}

async function requireAdmin(req: Request, res: Response, next: () => void): Promise<void> {
  const actorId = (req as unknown as AuthedRequest).actorId;
  const pool = getPool();
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

export function createAdminRouter(): Router {
  const router = Router();

  // Parse JSON bodies for admin routes
  router.use(express.json());

  // ── POST /admin/set-admin (before requireAuth — supports bootstrap) ──
  router.post('/set-admin', optionalAuth, async (req: Request, res: Response) => {
    const { user_id } = req.body as { user_id?: string };
    if (!user_id) {
      res.status(400).json({ error: 'user_id is required' });
      return;
    }

    const actorId = (req as unknown as AuthedRequest).actorId;
    const pool = getPool();
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

  // ── GET /admin/users ─────────────────────────────────────────────
  router.get('/users', requireAdmin, async (_req: Request, res: Response) => {
    const pool = getPool();
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
    const pool = getPool();
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

    const actorId = (req as unknown as AuthedRequest).actorId;
    const pool = getPool();
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

    const pool = getPool();
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
    const pool = getPool();
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

  // ── GET /admin/webhooks ──────────────────────────────────────────
  router.get('/webhooks', requireAdmin, async (_req: Request, res: Response) => {
    const pool = getPool();
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
    const pool = getPool();
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
