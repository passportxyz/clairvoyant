import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

import { getPool, shutdown } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { verifyToken } from './auth.js';
import { AuthError } from './types.js';
import { processSideEffects } from './webhooks.js';
import { checkUnblocks } from './unblock.js';
import { clearStaleAlert } from './staleness.js';

// Tool handlers
import { createTask } from './tools/tasks.js';
import { getTask } from './tools/tasks.js';
import { appendEvent } from './tools/events.js';
import { claimTask } from './tools/events.js';
import {
  registerUser, getUser, listUsers, authenticate,
  approveUser, setAdminTool, listPending, revokeUserKey,
} from './tools/users.js';
import { registerWebhook } from './tools/webhooks.js';
import { listTasks } from './db/queries.js';

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
 * Wrap an unauthenticated tool handler (no actorId).
 */
function withClientNoAuth<T>(handler: (client: import('pg').PoolClient, params: T) => Promise<unknown>) {
  return async (params: T, _extra: { authInfo?: AuthInfo }) => {
    try {
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await handler(client, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  };
}

/**
 * Wrap a tool that optionally uses auth (e.g. set_admin bootstrap).
 * Passes actorId as null if no auth is present.
 */
function withClientOptionalAuth<T>(
  handler: (client: import('pg').PoolClient, actorId: string | null, params: T) => Promise<unknown>,
  opts: { write?: boolean } = {},
) {
  return async (params: T, extra: { authInfo?: AuthInfo }) => {
    try {
      const actorId = extra.authInfo?.extra?.actorId as string | undefined ?? null;
      const pool = getPool();
      const client = await pool.connect();
      try {
        if (opts.write) await client.query('BEGIN');
        const result = await handler(client, actorId, params);
        if (opts.write) await client.query('COMMIT');
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
    if (effect.type === 'webhook' && event && task) {
      processSideEffects(pool, [{ type: 'webhook', eventType: effect.eventType! }], event, task).catch((err) => {
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
    { name: 'clairvoyant', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ── create_task ──────────────────────────────────────────────────

  server.tool(
    'create_task',
    'Create a persistent tracked work item in Clairvoyant — for cross-session coordination, delegation between agents/humans, and work that needs an audit trail. Not for ephemeral to-dos or background processes.',
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
    'List Clairvoyant work items with optional filters for status, owner, tags, parent, creator',
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
    'Get a Clairvoyant work item by ID, including its full event history',
    {
      task_id: z.string(),
    },
    withClient(async (client, actorId, params) => {
      return getTask(client, actorId, params);
    }),
  );

  // ── append_event ─────────────────────────────────────────────────

  server.tool(
    'append_event',
    'Append an event to a Clairvoyant work item (note, progress, handoff, field_changed, completed, cancelled, etc.)',
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
      return appendEvent(client, actorId, params);
    }, { write: true }),
  );

  // ── claim_task ───────────────────────────────────────────────────

  server.tool(
    'claim_task',
    'Claim an unowned Clairvoyant work item — sets the caller as the owner',
    {
      task_id: z.string(),
      idempotency_key: z.string(),
    },
    withClient(async (client, actorId, params) => {
      return claimTask(client, actorId, params);
    }, { write: true }),
  );

  // ── register_user (no auth) ──────────────────────────────────────

  server.tool(
    'register_user',
    'Register a new Clairvoyant user. Provide a public_key (ed25519) if the user needs API/CLI access. Users without keys are assignees only. If no admin exists, auto-approved. Otherwise pending admin approval.',
    {
      name: z.string().min(1).max(255),
      public_key: z.string().max(1024).optional().describe('ed25519 public key — provide if user needs to authenticate'),
    },
    withClientOptionalAuth(async (client, _actorId, params) => {
      return registerUser(client, params);
    }, { write: true }),
  );

  // ── get_user ─────────────────────────────────────────────────────

  server.tool(
    'get_user',
    'Get a Clairvoyant user by ID',
    {
      user_id: z.string(),
    },
    withClient(async (client, actorId, params) => {
      return getUser(client, actorId, params);
    }),
  );

  // ── list_users ───────────────────────────────────────────────────

  server.tool(
    'list_users',
    'List all Clairvoyant users',
    {},
    withClient(async (client, actorId) => {
      return listUsers(client, actorId);
    }),
  );

  // ── authenticate (no auth) ───────────────────────────────────────

  server.tool(
    'authenticate',
    'Authenticate with Clairvoyant: request a challenge nonce, or verify an ed25519 signature to get a JWT. No authentication required.',
    {
      user_id: z.string(),
      action: z.enum(['request_challenge', 'verify']),
      nonce: z.string().optional(),
      signature: z.string().optional(),
    },
    withClientNoAuth(async (client, params) => {
      return authenticate(client, params);
    }),
  );

  // ── register_webhook ─────────────────────────────────────────────

  server.tool(
    'register_webhook',
    'Register a webhook URL to receive Clairvoyant event notifications (task changes, handoffs, etc.)',
    {
      url: z.string().url(),
      events: z.array(z.string()),
    },
    withClient(async (client, actorId, params) => {
      return registerWebhook(client, actorId, params);
    }),
  );

  // ── approve_user (admin only) ─────────────────────────────────────

  server.tool(
    'approve_user',
    'Approve a pending Clairvoyant user registration. Admin only. Also approves their pending key.',
    {
      user_id: z.string(),
    },
    withClient(async (client, actorId, params) => {
      return approveUser(client, actorId, params);
    }, { write: true }),
  );

  // ── set_admin (admin or bootstrap) ────────────────────────────────

  server.tool(
    'set_admin',
    'Promote a Clairvoyant user to admin. If no admin exists yet, anyone can call this (bootstrap). After that, only admins can promote.',
    {
      user_id: z.string(),
    },
    withClientOptionalAuth(async (client, actorId, params) => {
      return setAdminTool(client, actorId, params);
    }, { write: true }),
  );

  // ── list_pending (admin only) ─────────────────────────────────────

  server.tool(
    'list_pending',
    'List Clairvoyant users awaiting admin approval. Admin only.',
    {},
    withClient(async (client, actorId) => {
      return listPending(client, actorId);
    }),
  );

  // ── revoke_key (admin only) ───────────────────────────────────────

  server.tool(
    'revoke_key',
    'Revoke a Clairvoyant user\'s key. Admin only. User must register a new key and get re-approved.',
    {
      user_id: z.string(),
    },
    withClient(async (client, actorId, params) => {
      return revokeUserKey(client, actorId, params);
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
  console.error('[clairvoyant] Running migrations...');
  await runMigrations(pool);
  console.error('[clairvoyant] Migrations complete.');

  // Start staleness checker
  const { startStalenessChecker } = await import('./staleness.js');
  startStalenessChecker(pool);
  console.error('[clairvoyant] Staleness checker started.');

  // Express app with MCP defaults (JSON body parser, host validation)
  const app = createMcpExpressApp({ host: '0.0.0.0' });

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
      console.error('[clairvoyant] Request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: '0.1.0', sessions: sessions.size });
  });

  const port = parseInt(process.env.PORT || '3000', 10);
  const httpServer = app.listen(port, '0.0.0.0', () => {
    console.error(`[clairvoyant] MCP server listening on http://0.0.0.0:${port}/mcp`);
  });

  // Graceful shutdown
  const cleanup = async () => {
    console.error('[clairvoyant] Shutting down...');
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
  console.error('[clairvoyant] Fatal error:', err);
  process.exit(1);
});
