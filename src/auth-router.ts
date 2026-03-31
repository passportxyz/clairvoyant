import express, { Router } from 'express';
import type { Request, Response } from 'express';
import pg from 'pg';
import { requireAuth, getActorId } from './middleware.js';
import { registerUser } from './tools/users.js';
import { authenticate } from './tools/users.js';
import { getUser } from './tools/users.js';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createAuthRouter(pool: pg.Pool): Router {
  const router = Router();

  router.use(express.json());

  // ── POST /auth/register ────────────────────────────────────────────
  router.post('/register', async (req: Request, res: Response) => {
    const { name, public_key, user_id } = req.body as {
      name?: string;
      public_key?: string;
      user_id?: string;
    };

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required and must be a string' });
      return;
    }
    if (name.length > 255) {
      res.status(400).json({ error: 'name must be 255 characters or fewer' });
      return;
    }
    if (public_key != null && (typeof public_key !== 'string' || !public_key.startsWith('ssh-ed25519 '))) {
      res.status(400).json({ error: 'public_key must be an ssh-ed25519 key string' });
      return;
    }
    if (user_id != null && typeof user_id !== 'string') {
      res.status(400).json({ error: 'user_id must be a string' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await registerUser(client, { name, public_key, user_id });
      await client.query('COMMIT');
      res.json(result);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  // ── POST /auth/challenge ───────────────────────────────────────────
  router.post('/challenge', async (req: Request, res: Response) => {
    const { user_id } = req.body as { user_id?: string };

    if (!user_id || typeof user_id !== 'string') {
      res.status(400).json({ error: 'user_id is required and must be a string' });
      return;
    }

    const client = await pool.connect();
    try {
      const result = await authenticate(client, {
        user_id,
        action: 'request_challenge',
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  // ── POST /auth/verify ─────────────────────────────────────────────
  router.post('/verify', async (req: Request, res: Response) => {
    const { user_id, nonce, signature } = req.body as {
      user_id?: string;
      nonce?: string;
      signature?: string;
    };

    if (!user_id || typeof user_id !== 'string' ||
        !nonce || typeof nonce !== 'string' ||
        !signature || typeof signature !== 'string') {
      res.status(400).json({ error: 'user_id, nonce, and signature are required and must be strings' });
      return;
    }

    const client = await pool.connect();
    try {
      const result = await authenticate(client, {
        user_id,
        action: 'verify',
        nonce,
        signature,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  // ── GET /auth/user/:id ────────────────────────────────────────────
  router.get('/user/:id', requireAuth, async (req: Request, res: Response) => {
    const userId = req.params.id as string;
    const actorId = getActorId(req);

    const client = await pool.connect();
    try {
      const result = await getUser(client, actorId, { user_id: userId });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      client.release();
    }
  });

  return router;
}
