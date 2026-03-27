import pg from 'pg';
import type {
  User,
  Task,
  TaskStatus,
  Event,
  EventType,
  Webhook,
} from '../types.js';

// ── Helpers ────────────────────────────────────────────────────────

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
  const [createdAt, id] = decoded.split('|');
  return { createdAt, id };
}

// ── User queries ───────────────────────────────────────────────────

export async function insertUser(
  client: pg.PoolClient,
  params: {
    name: string;
    public_key: string;
  },
): Promise<User> {
  const { rows } = await client.query<User>(
    `INSERT INTO users (name, public_key)
     VALUES ($1, $2)
     RETURNING *`,
    [params.name, params.public_key],
  );
  return rows[0];
}

export async function getUserById(
  client: pg.PoolClient,
  id: string,
): Promise<User | null> {
  const { rows } = await client.query<User>(
    'SELECT * FROM users WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function getUserByPublicKey(
  client: pg.PoolClient,
  publicKey: string,
): Promise<User | null> {
  const { rows } = await client.query<User>(
    'SELECT * FROM users WHERE public_key = $1',
    [publicKey],
  );
  return rows[0] ?? null;
}

// ── Task queries ───────────────────────────────────────────────────

export async function insertTask(
  client: pg.PoolClient,
  params: {
    title: string;
    status: TaskStatus;
    owner_id?: string;
    creator_id: string;
    parent_task_id?: string;
    priority?: number;
    due_date?: Date;
    tags: string[];
  },
): Promise<Task> {
  const { rows } = await client.query<Task>(
    `INSERT INTO tasks (title, status, owner_id, creator_id, parent_task_id, priority, due_date, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      params.title,
      params.status,
      params.owner_id ?? null,
      params.creator_id,
      params.parent_task_id ?? null,
      params.priority ?? null,
      params.due_date ?? null,
      params.tags,
    ],
  );
  return rows[0];
}

export async function getTaskById(
  client: pg.PoolClient,
  id: string,
): Promise<Task | null> {
  const { rows } = await client.query<Task>(
    'SELECT * FROM tasks WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Lock a task row for update (prevents concurrent claim races).
 */
export async function getTaskByIdForUpdate(
  client: pg.PoolClient,
  id: string,
): Promise<Task | null> {
  const { rows } = await client.query<Task>(
    'SELECT * FROM tasks WHERE id = $1 FOR UPDATE',
    [id],
  );
  return rows[0] ?? null;
}

export interface ListTasksFilters {
  status?: TaskStatus;
  owner_id?: string | null;
  tags?: string[];
  parent_task_id?: string;
  creator_id?: string;
  cursor?: string;
  limit?: number;
}

export async function listTasks(
  client: pg.PoolClient,
  filters: ListTasksFilters,
): Promise<{ tasks: Task[]; cursor?: string }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (filters.status !== undefined) {
    conditions.push(`status = $${paramIdx++}`);
    values.push(filters.status);
  }

  // owner_id=null means unowned, owner_id=string means specific owner
  if (filters.owner_id === null) {
    conditions.push('owner_id IS NULL');
  } else if (filters.owner_id !== undefined) {
    conditions.push(`owner_id = $${paramIdx++}`);
    values.push(filters.owner_id);
  }

  if (filters.tags !== undefined && filters.tags.length > 0) {
    conditions.push(`tags @> $${paramIdx++}`);
    values.push(filters.tags);
  }

  if (filters.parent_task_id !== undefined) {
    conditions.push(`parent_task_id = $${paramIdx++}`);
    values.push(filters.parent_task_id);
  }

  if (filters.creator_id !== undefined) {
    conditions.push(`creator_id = $${paramIdx++}`);
    values.push(filters.creator_id);
  }

  if (filters.cursor !== undefined) {
    const { createdAt, id } = decodeCursor(filters.cursor);
    conditions.push(
      `(created_at, id) > ($${paramIdx}, $${paramIdx + 1})`,
    );
    values.push(createdAt, id);
    paramIdx += 2;
  }

  const limit = filters.limit ?? 50;

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await client.query<Task>(
    `SELECT * FROM tasks ${whereClause}
     ORDER BY created_at ASC, id ASC
     LIMIT $${paramIdx}`,
    [...values, limit + 1],
  );

  let nextCursor: string | undefined;
  if (rows.length > limit) {
    rows.pop();
    const last = rows[rows.length - 1];
    nextCursor = encodeCursor(last.created_at, last.id);
  }

  return { tasks: rows, cursor: nextCursor };
}

// Column allowlist for updateTask — prevents SQL injection via event metadata
const ALLOWED_TASK_COLUMNS = new Set([
  'title', 'status', 'owner_id', 'priority', 'due_date', 'tags', 'updated_at',
]);

export async function updateTask(
  client: pg.PoolClient,
  id: string,
  version: number,
  updates: Record<string, unknown>,
): Promise<Task | null> {
  const setClauses: string[] = ['version = version + 1', 'updated_at = now()'];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const [column, value] of Object.entries(updates)) {
    if (column === 'updated_at') continue; // already handled above
    if (!ALLOWED_TASK_COLUMNS.has(column)) {
      throw new Error(`Column '${column}' is not allowed in task updates`);
    }
    setClauses.push(`${column} = $${paramIdx++}`);
    values.push(value);
  }

  values.push(id, version);

  const { rows } = await client.query<Task>(
    `UPDATE tasks
     SET ${setClauses.join(', ')}
     WHERE id = $${paramIdx++} AND version = $${paramIdx}
     RETURNING *`,
    values,
  );

  return rows[0] ?? null;
}

// ── Event queries ──────────────────────────────────────────────────

export async function insertEvent(
  client: pg.PoolClient,
  params: {
    task_id: string;
    event_type: EventType;
    actor_id: string;
    body?: string;
    metadata: Record<string, unknown>;
    idempotency_key: string;
  },
): Promise<Event> {
  const { rows } = await client.query<Event>(
    `INSERT INTO events (task_id, event_type, actor_id, body, metadata, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      params.task_id,
      params.event_type,
      params.actor_id,
      params.body ?? null,
      JSON.stringify(params.metadata),
      params.idempotency_key,
    ],
  );
  return rows[0];
}

export async function getEventsByTaskId(
  client: pg.PoolClient,
  taskId: string,
): Promise<Event[]> {
  const { rows } = await client.query<Event>(
    'SELECT * FROM events WHERE task_id = $1 ORDER BY created_at ASC',
    [taskId],
  );
  return rows;
}

export async function getEventByIdempotencyKey(
  client: pg.PoolClient,
  key: string,
): Promise<Event | null> {
  const { rows } = await client.query<Event>(
    'SELECT * FROM events WHERE idempotency_key = $1',
    [key],
  );
  return rows[0] ?? null;
}

export async function getBlockedEvents(
  client: pg.PoolClient,
  blockedByTaskId: string,
): Promise<Event[]> {
  const { rows } = await client.query<Event>(
    `SELECT * FROM events
     WHERE event_type = 'blocked'
       AND metadata->>'blocked_by_task_id' = $1
     ORDER BY created_at ASC`,
    [blockedByTaskId],
  );
  return rows;
}

export async function getEventsByTaskIdAndType(
  client: pg.PoolClient,
  taskId: string,
  eventType: string,
): Promise<Event[]> {
  const { rows } = await client.query<Event>(
    `SELECT * FROM events
     WHERE task_id = $1 AND event_type = $2
     ORDER BY created_at ASC`,
    [taskId, eventType],
  );
  return rows;
}

// ── Webhook queries ────────────────────────────────────────────────

export async function insertWebhook(
  client: pg.PoolClient,
  params: {
    url: string;
    events: string[];
    secret: string;
    owner_id: string;
  },
): Promise<Webhook> {
  const { rows } = await client.query<Webhook>(
    `INSERT INTO webhooks (url, events, secret, owner_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [params.url, params.events, params.secret, params.owner_id],
  );
  return rows[0];
}

export async function getActiveWebhooksByEventType(
  client: pg.PoolClient,
  eventType: string,
): Promise<Webhook[]> {
  const { rows } = await client.query<Webhook>(
    'SELECT * FROM webhooks WHERE active = true AND $1 = ANY(events)',
    [eventType],
  );
  return rows;
}
