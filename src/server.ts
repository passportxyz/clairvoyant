import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getPool, shutdown } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { extractActorId } from './auth.js';
import { AuthError } from './types.js';
import { processSideEffects } from './webhooks.js';
import { checkUnblocks } from './unblock.js';
import { clearStaleAlert } from './staleness.js';

// Tool handlers
import { createTask } from './tools/tasks.js';
import { getTask } from './tools/tasks.js';
import { appendEvent } from './tools/events.js';
import { claimTask } from './tools/events.js';
import { registerUser, getUser, authenticate } from './tools/users.js';
import { registerWebhook } from './tools/webhooks.js';
import { listTasks } from './db/queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getActorIdFromEnv(): string {
  const token = process.env.CV_TOKEN;
  if (!token) throw new AuthError('CV_TOKEN environment variable is required', 'missing_token');
  return extractActorId(token);
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
 */
function withClient<T>(handler: ToolHandler<T>, opts: { write?: boolean } = {}) {
  return async (params: T) => {
    try {
      const actorId = getActorIdFromEnv();
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
  return async (params: T) => {
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
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'clairvoyant', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ── create_task ──────────────────────────────────────────────────

server.tool(
  'create_task',
  'Create a new task with title, body, and optional metadata',
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
  'List tasks with optional filters for status, owner, tags, parent, creator',
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
  'Get a task by ID, including its full event history',
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
  'Append an event to a task (note, progress, handoff, field_changed, completed, cancelled, etc.)',
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
  'Claim an unowned task — sets the caller as the owner',
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
  'Register a new user. No authentication required.',
  {
    name: z.string(),
    public_key: z.string(),
  },
  withClientNoAuth(async (client, params) => {
    return registerUser(client, params);
  }),
);

// ── get_user ─────────────────────────────────────────────────────

server.tool(
  'get_user',
  'Get a user by ID',
  {
    user_id: z.string(),
  },
  withClient(async (client, actorId, params) => {
    return getUser(client, actorId, params);
  }),
);

// ── authenticate (no auth) ───────────────────────────────────────

server.tool(
  'authenticate',
  'Authenticate: request a challenge nonce, or verify a signature to get a JWT. No authentication required.',
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
  'Register a webhook URL to receive event notifications',
  {
    url: z.string().url(),
    events: z.array(z.string()),
  },
  withClient(async (client, actorId, params) => {
    return registerWebhook(client, actorId, params);
  }),
);

// ---------------------------------------------------------------------------
// Transport & startup
// ---------------------------------------------------------------------------

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[clairvoyant] MCP server running on stdio.');

  // Graceful shutdown
  const cleanup = async () => {
    console.error('[clairvoyant] Shutting down...');
    await server.close();
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
