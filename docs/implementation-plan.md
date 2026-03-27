# The Clairvoyant — Implementation Plan

An event-sourced task management system for human/agent collaboration. This document covers everything needed to build the core system. AI is the UI — humans talk to agents, agents talk to Clairvoyant.

## Scope

**In scope:** API server, database, MCP server, CLI, SKILL.md, webhooks, auth, staleness alerts.

**Out of scope:** Triage bot, community agents, per-user agents. These are consumers of the system built in separate repos. The core system just needs to support them well — the right events, the right queries, the right webhooks. A separate spec will be provided for agent implementors.

## Architecture

### Event Sourcing

Every action is an append-only event. The `tasks` table is a materialized view kept in sync via **synchronous projection** — every event insert updates the tasks row in the same Postgres transaction.

```sql
BEGIN;
INSERT INTO events (...) VALUES (...);
UPDATE tasks SET status = $new, owner_id = $new, version = version + 1 WHERE id = $task_id AND version = $expected;
COMMIT;
```

The projection logic lives in a single function (`applyEvent`) that takes an event and returns the SQL updates for the tasks row. This function is the heart of the system — every behavior change flows through it.

### Project Structure

```
clairvoyant/
├── src/
│   ├── server.ts              -- Express app setup, middleware
│   ├── routes/
│   │   ├── tasks.ts           -- /tasks endpoints
│   │   ├── events.ts          -- /tasks/:id/events, /tasks/:id/claim
│   │   ├── users.ts           -- /users, /admin endpoints
│   │   └── webhooks.ts        -- /webhooks endpoints
│   ├── db/
│   │   ├── pool.ts            -- pg Pool setup, connection config
│   │   ├── queries.ts         -- raw SQL queries as named exports
│   │   └── migrate.ts         -- migration runner
│   ├── projection.ts          -- applyEvent() — event → task state changes
│   ├── webhooks.ts            -- webhook dispatch logic
│   ├── staleness.ts           -- periodic check for unowned tasks
│   ├── auth.ts                -- SSH signature verification middleware
│   └── types.ts               -- shared TypeScript types
├── migrations/
│   ├── 001_create_users.sql
│   ├── 002_create_tasks.sql
│   ├── 003_create_events.sql
│   └── 004_create_webhooks.sql
├── mcp/
│   ├── server.ts              -- MCP server entry point
│   ├── tools.ts               -- tool definitions (maps to API endpoints)
│   └── SKILL.md               -- agent guidance document
├── cli/
│   ├── cv.ts                  -- CLI entry point
│   └── commands/              -- one file per command group
├── test/
│   ├── setup.ts               -- test DB, migrations, transaction wrapper
│   ├── projection.test.ts
│   ├── tasks.test.ts
│   ├── events.test.ts
│   ├── users.test.ts
│   ├── auth.test.ts
│   └── webhooks.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── docker-compose.yml         -- Postgres for local dev + test
```

## Data Model

### migrations/001_create_users.sql

```sql
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('human', 'agent')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  is_admin    boolean NOT NULL DEFAULT false,
  public_key  text NOT NULL UNIQUE,
  parent_id   uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_parent_id ON users(parent_id);
```

### migrations/002_create_tasks.sql

```sql
CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title           text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  owner_id        uuid REFERENCES users(id),
  creator_id      uuid NOT NULL REFERENCES users(id),
  parent_task_id  uuid REFERENCES tasks(id),
  priority        text,
  due_date        timestamptz,
  tags            text[] NOT NULL DEFAULT '{}',
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_owner_id ON tasks(owner_id);
CREATE INDEX idx_tasks_creator_id ON tasks(creator_id);
CREATE INDEX idx_tasks_parent_task_id ON tasks(parent_task_id);
CREATE INDEX idx_tasks_status_owner ON tasks(status, owner_id) WHERE status = 'open' AND owner_id IS NULL;
```

The composite index on `(status, owner_id) WHERE status = 'open' AND owner_id IS NULL` is specifically for the triage query — "give me all unowned open tasks" needs to be fast.

### migrations/003_create_events.sql

```sql
CREATE TABLE events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES tasks(id),
  event_type      text NOT NULL CHECK (event_type IN (
    'created', 'note', 'progress', 'handoff', 'claimed',
    'blocked', 'unblocked', 'field_changed', 'completed', 'cancelled'
  )),
  actor_id        uuid NOT NULL REFERENCES users(id),
  body            text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  idempotency_key uuid NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_task_id ON events(task_id);
CREATE INDEX idx_events_task_id_created ON events(task_id, created_at);
CREATE INDEX idx_events_actor_id ON events(actor_id);
CREATE INDEX idx_events_idempotency ON events(idempotency_key);
```

### migrations/004_create_webhooks.sql

```sql
CREATE TABLE webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url         text NOT NULL,
  events      text[] NOT NULL,   -- which event types to fire on, e.g. ['handoff', 'claimed', 'completed']
  secret      text NOT NULL,     -- HMAC secret for signature verification
  owner_id    uuid NOT NULL REFERENCES users(id),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

## Event Types — Detailed Specification

Each event type has a specific contract for what `body` and `metadata` contain, and what projection side-effects it triggers.

| Event Type | Body | Metadata | Projection |
|---|---|---|---|
| `created` | Task description (required) | `{ priority?, due_date?, tags?, owner_id?, on_behalf_of? }` | INSERT tasks row |
| `note` | Commentary text | `{}` | updated_at only |
| `progress` | What was done | `{}` | updated_at only |
| `handoff` | Context for recipient | `{ from_user_id?, to_user_id, reason? }` | owner_id = to_user_id |
| `claimed` | null | `{ user_id }` | owner_id = user_id |
| `blocked` | What's blocking | `{ reason, blocked_by_task_id?, capability_gap? }` | updated_at only |
| `unblocked` | Resolution context | `{ resolved_by? }` | updated_at only |
| `field_changed` | null | `{ field, old_value, new_value }` | update the specified field |
| `completed` | Completion notes | `{}` | status = 'done' |
| `cancelled` | Reason | `{}` | status = 'cancelled' |

### Projection function

```typescript
// src/projection.ts
interface ProjectionResult {
  taskUpdates: Record<string, unknown>;  // fields to SET on the tasks row
  sideEffects: SideEffect[];             // webhooks to fire, unblock checks, etc.
}

function applyEvent(event: Event, currentTask: Task): ProjectionResult {
  // Switch on event_type, return the updates + side effects
  // This is pure logic — no DB calls, easy to test
}
```

The side effects array can include:
- `{ type: 'webhook', eventType: string }` — fire matching webhooks
- `{ type: 'check_unblocks', taskId: string }` — when a task completes, check if other tasks were blocked by it
- `{ type: 'staleness_reset' }` — task got an owner, cancel any pending staleness alert

## API Endpoints — Detailed

### POST /tasks

Create a task. The first event (`created`) is inserted atomically with the task row.

```typescript
// Request
{
  title: string;
  body: string;                    // description — becomes the created event's body
  owner_id?: string;               // claim immediately (skip triage)
  parent_task_id?: string;
  priority?: string;
  due_date?: string;               // ISO 8601
  tags?: string[];
  on_behalf_of?: string;           // user ID if creating on behalf of someone
  idempotency_key: string;
}

// Response 201
{
  task: Task;
  event: Event;                    // the created event
}
```

Validation:
- `actor_id` comes from auth (the authenticated user)
- If `owner_id` is set, that user must exist and be active
- If `parent_task_id` is set, that task must exist
- `idempotency_key` must be unique — if a duplicate is received, return the existing task/event (idempotent retry)

### GET /tasks

List tasks with filters. Returns the materialized task rows (fast reads).

```
GET /tasks?status=open&owner_id=<uuid>
GET /tasks?status=open&owner_id=null        -- unowned tasks (triage pool)
GET /tasks?tags=backend,urgent              -- AND filter on tags
GET /tasks?parent_task_id=<uuid>            -- subtasks of a parent
GET /tasks?creator_id=<uuid>                -- tasks I created
```

Response includes pagination via cursor (task `created_at` + `id`).

```typescript
// Response 200
{
  tasks: Task[];
  cursor?: string;                 // opaque cursor for next page
}
```

### GET /tasks/:id

Single task with its full event history.

```typescript
// Response 200
{
  task: Task;
  events: Event[];                 // ordered by created_at ASC
}
```

### POST /tasks/:id/events

Append an event to a task. This is the primary write operation.

```typescript
// Request
{
  event_type: string;
  body?: string;
  metadata?: Record<string, unknown>;
  idempotency_key: string;
}

// Response 201
{
  event: Event;
  task: Task;                      // updated task state after projection
}
```

Validation:
- Task must exist and not be in a terminal state (done/cancelled) — unless the event is `note` (you can always add notes)
- `event_type` must be valid
- For `handoff`: `metadata.to_user_id` must be a valid active user
- For `claimed`: task must have `owner_id = null`
- For `field_changed`: `metadata.field` must be an allowed field, `metadata.old_value` must match current value (optimistic check)
- For `completed`/`cancelled`: triggers side effect to check for blocked tasks that depend on this one

The version check happens in the projection transaction:
```sql
UPDATE tasks SET ..., version = version + 1
  WHERE id = $task_id AND version = $expected;
```
If 0 rows affected → return 409 Conflict.

### POST /tasks/:id/claim

Convenience endpoint — atomic claim with optimistic locking. Equivalent to appending a `claimed` event, but with an explicit conflict check on `owner_id IS NULL`.

```typescript
// Request
{
  idempotency_key: string;
}

// Response 200 — you got it
{
  event: Event;
  task: Task;
}

// Response 409 — someone else got it
{
  error: "already_claimed";
  owner_id: string;                // who has it now
}
```

### POST /users

Register a new user. Lands in `pending` status for humans.

```typescript
// Request
{
  name: string;
  type: "human" | "agent";
  public_key: string;              // SSH public key
  parent_id?: string;              // required for agents
}

// Response 201
{
  user: User;                      // status = pending (for humans) or active (for agents with active parent)
}
```

Validation:
- `public_key` must be unique
- For agents: `parent_id` must reference an active human or admin
- For agents: status is immediately `active` (parent is trusted)
- For humans: status is `pending`

### GET /users/:id

```typescript
// Response 200
{
  user: User;
  agent_count?: number;            // how many agents this user has (if human)
}
```

### GET /admin/pending

List pending user registrations. Requires `is_admin = true`.

```typescript
// Response 200
{
  users: User[];                   // where status = pending
}
```

### POST /admin/approve/:id

Approve a pending user. Requires `is_admin = true`.

```typescript
// Response 200
{
  user: User;                      // status = active now
}
```

### POST /webhooks

Register a webhook endpoint.

```typescript
// Request
{
  url: string;
  events: string[];                // event types to subscribe to
}

// Response 201
{
  webhook: Webhook;
  secret: string;                  // generated server-side, shown once
}
```

## Auth — SSH Signature Verification

Every request is signed with the user's SSH private key. The server verifies using the registered public key.

### How it works

1. Client constructs a signing payload: `METHOD\nPATH\nTIMESTAMP\nBODY_HASH`
2. Client signs the payload with their SSH private key
3. Client sends headers: `X-CV-User-Id`, `X-CV-Timestamp`, `X-CV-Signature`
4. Server looks up the user's public key, verifies the signature, checks timestamp is within 5 minutes

```typescript
// src/auth.ts — Express middleware
async function authenticate(req, res, next) {
  const userId = req.headers['x-cv-user-id'];
  const timestamp = req.headers['x-cv-timestamp'];
  const signature = req.headers['x-cv-signature'];

  // 1. Look up user, check status = active
  // 2. Verify timestamp is within 5-minute window
  // 3. Reconstruct signing payload
  // 4. Verify signature against user's public_key using ssh-keygen or node crypto
  // 5. Set req.user and continue
}
```

The CLI and MCP server both handle signing transparently — the agent never has to think about it.

### Key format

Standard SSH ed25519 keys. The CLI generates them with `ssh-keygen`. Node's `crypto` module can verify ed25519 signatures natively.

## Webhooks — Dispatch

When a side effect includes `{ type: 'webhook' }`, the system:

1. Queries `webhooks` table for active webhooks matching the event type
2. For each match, POST to the URL with:
   - Body: `{ event, task }` (the event that triggered it + current task state)
   - Header: `X-CV-Signature` — HMAC-SHA256 of the body using the webhook's secret
3. Fire-and-forget for v1 — log failures but don't retry. Retry logic is a future enhancement.

Webhook dispatch happens asynchronously after the transaction commits — it should not block the API response.

## Staleness Alerts

A periodic job (runs every minute via `setInterval`) that:

1. Queries for open tasks where `owner_id IS NULL` and `created_at < now() - interval`
2. For tasks that haven't already been alerted, fires a webhook event of type `stale`
3. Tracks which tasks have been alerted to avoid duplicate notifications

The staleness interval is configurable via environment variable (`CV_STALENESS_INTERVAL_MS`, default 3600000 / 1 hour).

This is a simple in-process check, not a separate worker. If the server restarts, it just re-checks on the next interval.

## Dependency Auto-Unblock

When a `completed` or `cancelled` event is processed:

1. Query events table for `blocked` events where `metadata->>'blocked_by_task_id' = completed_task_id`
2. For each blocked task, check if it has any OTHER unresolved `blocked` events with `blocked_by_task_id` set
3. If no remaining blockers, insert an `unblocked` event with `metadata: { resolved_by: completed_task_id }`

"Unresolved" means: there's a `blocked` event with a `blocked_by_task_id`, and no subsequent `unblocked` event referencing the same blocker.

## MCP Server

The MCP server exposes the same operations as the REST API as MCP tools. It's a thin wrapper.

### Tools

| Tool | Maps to |
|---|---|
| `create_task` | POST /tasks |
| `list_tasks` | GET /tasks |
| `get_task` | GET /tasks/:id |
| `append_event` | POST /tasks/:id/events |
| `claim_task` | POST /tasks/:id/claim |
| `register_user` | POST /users |
| `get_user` | GET /users/:id |
| `admin_pending` | GET /admin/pending |
| `admin_approve` | POST /admin/approve/:id |
| `register_webhook` | POST /webhooks |

The MCP server handles auth by storing the SSH keypair in its configuration. Each agent instance has its own identity.

## CLI (`cv`)

For agents that don't support MCP. The CLI handles SSH key management and request signing transparently.

```bash
cv init                          # generate SSH keypair
cv auth register                 # register public key with server
cv add "Fix the login bug"       # create task (unowned)
cv add "My thing" --owner me     # create and self-assign
cv list --mine                   # my tasks
cv list --unowned                # triage pool
cv claim 47                      # pick up a task
cv progress 47 "Found the root cause"
cv note 47 "Context for whoever picks this up"
cv handoff 47 --to <user_id> --context "Need DB credentials"
cv block 47 --depends-on 32     # dependency
cv done 47
cv cancel 47
cv admin pending                 # list pending registrations (admin only)
cv admin approve <user_id>       # approve user (admin only)
```

Each command maps directly to an API call. The CLI stores the keypair at `~/.cv/id_ed25519` and the server URL at `~/.cv/config`.

## SKILL.md

Shipped with both MCP server and CLI. Explains to agents:
- What Clairvoyant is and the handoff model
- When to use each event type
- What a good task description looks like
- How to report capability gaps vs regular blockers
- Conventions for subtasks and dependencies
- How `on_behalf_of` works for acting on behalf of humans

This document will be written during implementation once the API is stable.

## Testing Strategy

TDD from the start. Tests run against real Postgres — no mocking the data layer.

- **Vitest** — test runner
- **Supertest** — HTTP-level tests against Express
- **Real Postgres** — test DB with migrations, no mocks

### Test isolation

Each test runs inside a transaction that rolls back at the end.

```typescript
// test/setup.ts
import { Pool } from 'pg';

let pool: Pool;

export async function setup() {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  // Run migrations
}

export async function withTransaction(fn: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
```

### What to test (in order)

1. **Projection logic** — unit test `applyEvent()` with no DB. Given event + current task state → assert correct updates and side effects.
2. **Event insertion + projection** — insert event, verify tasks row updated correctly in same transaction.
3. **Optimistic locking** — two concurrent claims, only one succeeds.
4. **Registration flow** — register → pending, admin approve → active, agent creation by active human → immediate active.
5. **Auth middleware** — valid signature passes, expired timestamp rejected, unknown user rejected, pending user rejected.
6. **Task lifecycle** — full flow: create → claim → progress → handoff → claim → complete.
7. **Dependencies** — block B on A → complete A → B gets unblocked event.
8. **Idempotency** — same idempotency_key twice → same response, no duplicate event.
9. **Webhooks** — event fires → matching webhook receives POST with correct signature.
10. **Staleness** — unowned task older than threshold → stale webhook fires.

## Environment & Configuration

```bash
# .env
DATABASE_URL=postgresql://user:pass@localhost:5432/clairvoyant
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/clairvoyant_test
PORT=3000
CV_STALENESS_INTERVAL_MS=3600000   # 1 hour
```

### docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: clairvoyant
      POSTGRES_PASSWORD: clairvoyant
      POSTGRES_DB: clairvoyant
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

Test DB is created by the test setup script: `CREATE DATABASE clairvoyant_test`.

## Implementation Order

1. **Project scaffolding** — package.json, tsconfig, vitest config, docker-compose, test setup
2. **Migrations** — all 4 migration files, migration runner
3. **Projection** — `applyEvent()` with unit tests
4. **Core API** — POST /tasks, GET /tasks, GET /tasks/:id, POST /tasks/:id/events, POST /tasks/:id/claim — with integration tests
5. **Auth** — SSH signature middleware + tests
6. **User management** — POST /users, admin endpoints + tests
7. **Webhooks** — registration, dispatch, signature + tests
8. **Staleness** — periodic check + tests
9. **Dependency auto-unblock** — completion triggers unblock + tests
10. **CLI** — commands wrapping API calls, key management
11. **MCP server** — tools wrapping API calls
12. **SKILL.md** — agent guidance document
