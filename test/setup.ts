import pg from 'pg';
const { Pool } = pg;
import { runMigrations } from '../src/db/migrate.js';

let pool: pg.Pool | null = null;

// Get or create the test pool
export function getTestPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.TEST_DATABASE_URL ||
      'postgresql://clairvoyant:clairvoyant@localhost:5432/clairvoyant_test';
    pool = new Pool({ connectionString });
  }
  return pool;
}

// Run migrations on the test DB. Call once before all tests.
export async function setupTestDb(): Promise<void> {
  const p = getTestPool();
  await runMigrations(p);
}

// Wrap a test function in a transaction that rolls back.
// This gives each test a clean slate.
export async function withTransaction(
  fn: (client: pg.PoolClient) => Promise<void>
): Promise<void> {
  const p = getTestPool();
  const client = await p.connect();
  await client.query('BEGIN');
  try {
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// Helper to create a test user directly via SQL (bypassing tool handlers)
// Creates an active user with an approved key by default.
export async function createTestUser(
  client: pg.PoolClient,
  overrides: {
    name?: string;
    public_key?: string;
    status?: 'pending' | 'active';
    is_admin?: boolean;
  } = {}
): Promise<{ id: string; name: string; status: string; is_admin: boolean; created_at: Date }> {
  const name = overrides.name || 'test-user-' + Math.random().toString(36).slice(2, 8);
  const status = overrides.status || 'active';
  const is_admin = overrides.is_admin || false;

  const result = await client.query(
    `INSERT INTO users (name, status, is_admin)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [name, status, is_admin]
  );
  const user = result.rows[0];

  // If a public_key is provided, create an approved key for them
  const public_key = overrides.public_key || 'ssh-ed25519 ' + Buffer.from(Math.random().toString()).toString('base64');
  await client.query(
    `INSERT INTO keys (user_id, public_key, status, approved_at)
     VALUES ($1, $2, 'approved', now())`,
    [user.id, public_key]
  );

  return user;
}

// Helper to create a test task directly via SQL
export async function createTestTask(
  client: pg.PoolClient,
  creatorId: string,
  overrides: {
    title?: string;
    status?: 'open' | 'done' | 'cancelled';
    owner_id?: string;
    parent_task_id?: string;
    priority?: number;
    tags?: string[];
  } = {}
): Promise<{ id: string; title: string; status: string; owner_id: string | null; creator_id: string; version: number; created_at: Date; updated_at: Date }> {
  const title = overrides.title || 'Test task ' + Math.random().toString(36).slice(2, 8);
  const status = overrides.status || 'open';
  const owner_id = overrides.owner_id || null;
  const parent_task_id = overrides.parent_task_id || null;
  const priority = overrides.priority || null;
  const tags = overrides.tags || [];

  const result = await client.query(
    `INSERT INTO tasks (title, status, owner_id, creator_id, parent_task_id, priority, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [title, status, owner_id, creatorId, parent_task_id, priority, tags]
  );
  return result.rows[0];
}

// Cleanup — call after all tests
export async function teardownTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
