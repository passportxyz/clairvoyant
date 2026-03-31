# Quest Log — Implementation Plan

An event-sourced task management system for human/agent collaboration. This document covers everything needed to build the core system. AI is the UI — humans talk to agents, agents talk to Quest Log.

## Scope

**In scope:** MCP server (the sole interface), database, CLI (MCP client), SKILL.md, webhooks, auth, staleness alerts.

**Out of scope:** Triage bot, community agents, per-user agents. These are consumers of the system built in separate repos. The core system just needs to support them well — the right events, the right queries, the right webhooks. A separate spec will be provided for agent implementors.

## Architecture

### MCP-Only Interface

There is no REST API. The MCP server is the only way to talk to Quest Log. The CLI is an MCP client — it connects to the MCP server and calls tools, same as any agent. This means:

- One server implementation, one set of tool handlers
- Auth uses standard bearer tokens (JWT) — env var for stdio, header for HTTP
- Every consumer — agents, CLI, future integrations — speaks MCP
- If a REST API is ever needed, it can be added as a thin layer on top of the same core logic

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
quest-log/
├── src/
│   ├── server.ts              -- MCP server entry point, tool registration
│   ├── tools/
│   │   ├── tasks.ts           -- create_task, list_tasks, get_task
│   │   ├── events.ts          -- update_task, claim_task
│   │   ├── users.ts           -- register_user, get_user, admin_pending, admin_approve
│   │   └── webhooks.ts        -- register_webhook
│   ├── db/
│   │   ├── pool.ts            -- pg Pool setup, connection config
│   │   ├── queries.ts         -- raw SQL queries as named exports
│   │   └── migrate.ts         -- migration runner
│   ├── projection.ts          -- applyEvent() — event → task state changes
│   ├── webhooks.ts            -- webhook dispatch logic
│   ├── staleness.ts           -- periodic check for unowned tasks
│   ├── auth.ts                -- JWT verification, token issuance, SSH challenge/response
│   └── types.ts               -- shared TypeScript types
├── migrations/
│   ├── 001_create_users.sql
│   ├── 002_create_tasks.sql
│   ├── 003_create_events.sql
│   └── 004_create_webhooks.sql
├── cli/
│   ├── ql.ts                  -- CLI entry point (MCP client)
│   └── commands/              -- one file per command group
├── SKILL.md                   -- agent guidance document
├── test/
│   ├── setup.ts               -- test DB, migrations, transaction wrapper
│   ├── projection.test.ts
│   ├── tools/
│   │   ├── tasks.test.ts
│   │   ├── events.test.ts
│   │   ├── users.test.ts
│   │   └── webhooks.test.ts
│   ├── auth.test.ts
│   └── staleness.test.ts
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

The partial index on `(status, owner_id) WHERE status = 'open' AND owner_id IS NULL` is specifically for the triage query — "give me all unowned open tasks" needs to be fast.

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

## MCP Tools — Detailed

The MCP server is the sole interface. All tool handlers follow the same pattern: validate input, run DB operations, return structured result. Auth is handled at connection time (see Auth section).

### create_task

Create a task. The first event (`created`) is inserted atomically with the task row.

```typescript
// Input
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

// Result
{
  task: Task;
  event: Event;                    // the created event
}
```

Validation:
- `actor_id` comes from the authenticated MCP connection
- If `owner_id` is set, that user must exist and be active
- If `parent_task_id` is set, that task must exist
- `idempotency_key` must be unique — if a duplicate is received, return the existing task/event (idempotent retry)

### list_tasks

List tasks with filters. Returns the materialized task rows (fast reads).

```typescript
// Input
{
  status?: "open" | "done" | "cancelled";
  owner_id?: string | null;        // null = unowned tasks (triage pool)
  tags?: string[];                 // AND filter
  parent_task_id?: string;
  creator_id?: string;
  cursor?: string;                 // opaque cursor for pagination
}

// Result
{
  tasks: Task[];
  cursor?: string;                 // next page cursor
}
```

### get_task

Single task with its full event history.

```typescript
// Input
{ task_id: string; }

// Result
{
  task: Task;
  events: Event[];                 // ordered by created_at ASC
}
```

### update_task

Append an event to a task. This is the primary write operation.

```typescript
// Input
{
  task_id: string;
  event_type: string;
  body?: string;
  metadata?: Record<string, unknown>;
  idempotency_key: string;
}

// Result
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
If 0 rows affected → return error with conflict info.

### claim_task

Convenience tool — atomic claim with optimistic locking.

```typescript
// Input
{
  task_id: string;
  idempotency_key: string;
}

// Result (success)
{
  event: Event;
  task: Task;
}

// Result (conflict)
{
  error: "already_claimed";
  owner_id: string;
}
```

### register_user

Register a new user. Lands in `pending` status for humans.

```typescript
// Input
{
  name: string;
  type: "human" | "agent";
  public_key: string;
  parent_id?: string;              // required for agents
}

// Result
{
  user: User;                      // status = pending (humans) or active (agents with active parent)
}
```

Validation:
- `public_key` must be unique
- For agents: `parent_id` must reference an active human or admin
- For agents: status is immediately `active` (parent is trusted)
- For humans: status is `pending`

### get_user

```typescript
// Input
{ user_id: string; }

// Result
{
  user: User;
  agent_count?: number;
}
```

### admin_pending

List pending registrations. Requires `is_admin = true` on the authenticated user.

```typescript
// Input: none

// Result
{ users: User[]; }
```

### admin_approve

Approve a pending user. Requires `is_admin = true`.

```typescript
// Input
{ user_id: string; }

// Result
{ user: User; }                    // status = active
```

### register_webhook

```typescript
// Input
{
  url: string;
  events: string[];
}

// Result
{
  webhook: Webhook;
  secret: string;                  // shown once
}
```

## Auth — Token-Based, SSH Keys for Identity

Auth uses standard bearer tokens that fit how MCP actually works. SSH keys are the identity layer — the CLI uses them to obtain tokens, and tokens are what MCP clients pass to the server.

### Why not SSH challenge/response at connection time?

The MCP spec doesn't support custom auth handshakes. Claude Code agents run in sandboxes that can't read `~/.ssh/`. Every real MCP server today uses either environment variables (stdio) or bearer tokens (HTTP). We follow that pattern.

### How it works

1. **CLI generates an ed25519 keypair** during `ql init` — stored at `~/.ql/id_ed25519`
2. **CLI registers the public key** via `register_user` (unauthenticated tool)
3. **CLI obtains a token** via `authenticate` tool — signs a server nonce with the private key, gets back a JWT
4. **Token is passed to MCP** via the standard mechanisms:
   - **stdio transport:** `QL_TOKEN` environment variable
   - **HTTP transport:** `Authorization: Bearer <token>` header
5. **Server validates the token** on every tool call, extracts `actor_id`
6. Tokens are long-lived (configurable, default 90 days) with refresh

### Token issuance flow

```
# First time setup (CLI handles this)
ql init                        → generates ~/.ql/id_ed25519
ql register --name "Lucian"    → calls register_user(name, public_key)
                                 admin approves (or auto-approve for agents)
ql auth login                  → calls authenticate tool:

Client → Server:  authenticate { user_id, action: "request_challenge" }
Server → Client:  { nonce: "random-bytes-hex" }
Client → Server:  authenticate { user_id, nonce, signature: sign(nonce, private_key) }
Server → Client:  { token: "eyJhbG...", expires_at: "..." }

# Token stored at ~/.ql/token
```

### How agents connect

Agents never touch SSH keys. Their parent (human) provisions them:

```bash
# Human registers an agent identity
ql agent create --name "my-build-bot"
# → Generates keypair, registers with parent_id = human's user_id
# → Agent is auto-approved (parent is trusted)
# → Returns a token for the agent

# Agent's MCP config (e.g. .mcp.json or claude mcp add)
claude mcp add --transport stdio \
  --env QL_TOKEN=eyJhbG... \
  quest-log -- npx @quest-log/mcp

# Or for HTTP transport
claude mcp add --transport http \
  --header "Authorization: Bearer eyJhbG..." \
  quest-log https://quest-log.example.com/mcp
```

### Token format

JWTs signed with a server-side secret (HS256 for v1, RS256 if we need distributed verification later).

```typescript
// JWT payload
{
  sub: string;        // user_id (uuid)
  name: string;       // user name
  type: "human" | "agent";
  iat: number;        // issued at
  exp: number;        // expiry
}
```

### MCP server auth middleware

Every tool call except `register_user` and `authenticate` requires a valid token. The server extracts the token from:

- **stdio:** `QL_TOKEN` env var, read once at connection startup
- **HTTP:** `Authorization: Bearer <token>` header on each request

```typescript
// src/auth.ts
function extractActorId(context: McpContext): string {
  const token = context.token; // from env var or header
  const payload = verifyJwt(token, SERVER_SECRET);
  if (!payload) throw new AuthError("invalid_token");
  return payload.sub;
}
```

### The `authenticate` tool

This is the only tool that uses SSH key crypto. It exists solely for the CLI's `ql auth login` flow.

```typescript
// Input (step 1 — request challenge)
{ user_id: string; action: "request_challenge" }
// Result
{ nonce: string; expires_at: string; }  // nonce valid for 60 seconds

// Input (step 2 — verify signature, issue token)
{ user_id: string; action: "verify"; nonce: string; signature: string; }
// Result
{ token: string; expires_at: string; user: User; }
```

The nonce is stored server-side (in-memory with TTL, or a `nonces` table). The signature is verified against the user's registered `public_key`.

### Key format

Standard SSH ed25519 keys. Node's `crypto` module verifies ed25519 signatures natively.

### Unauthenticated tools

- `register_user` — how new users register their public key
- `authenticate` — how the CLI exchanges an SSH signature for a token

All other tools require a valid token.

## Webhooks — Dispatch

When a side effect includes `{ type: 'webhook' }`, the system:

1. Queries `webhooks` table for active webhooks matching the event type
2. For each match, POST to the URL with:
   - Body: `{ event, task }` (the event that triggered it + current task state)
   - Header: `X-QL-Signature` — HMAC-SHA256 of the body using the webhook's secret
3. Fire-and-forget for v1 — log failures but don't retry. Retry logic is a future enhancement.

Webhook dispatch happens asynchronously after the transaction commits — it should not block the tool response.

## Staleness Alerts

A periodic job (runs every minute via `setInterval`) that:

1. Queries for open tasks where `owner_id IS NULL` and `created_at < now() - interval`
2. For tasks that haven't already been alerted, fires a webhook event of type `stale`
3. Tracks which tasks have been alerted to avoid duplicate notifications

The staleness interval is configurable via environment variable (`QL_STALENESS_INTERVAL_MS`, default 3600000 / 1 hour).

This is a simple in-process check, not a separate worker. If the server restarts, it just re-checks on the next interval.

## Dependency Auto-Unblock

When a `completed` or `cancelled` event is processed:

1. Query events table for `blocked` events where `metadata->>'blocked_by_task_id' = completed_task_id`
2. For each blocked task, check if it has any OTHER unresolved `blocked` events with `blocked_by_task_id` set
3. If no remaining blockers, insert an `unblocked` event with `metadata: { resolved_by: completed_task_id }`

"Unresolved" means: there's a `blocked` event with a `blocked_by_task_id`, and no subsequent `unblocked` event referencing the same blocker.

## CLI (`ql`)

The CLI is an MCP client — it connects to the Quest Log MCP server and calls tools. It handles SSH key management, token issuance, and auth transparently.

### Auth & setup commands

```bash
ql init                          # generate ed25519 keypair at ~/.ql/id_ed25519
ql register --name "Lucian"      # register public key with server (calls register_user)
ql auth login                    # SSH challenge/response → gets JWT, stores at ~/.ql/token
ql auth status                   # show current user, token expiry
ql agent create --name "bot"     # register an agent under your identity, returns its token
ql mcp-config                    # print the MCP config snippet for agents to use
```

### Task commands

```bash
ql add "Fix the login bug"                    # calls create_task
ql add "My thing" --owner me                  # calls create_task with owner_id
ql list --mine                                # calls list_tasks with owner_id=me
ql list --unowned                             # calls list_tasks with owner_id=null
ql claim 47                                   # calls claim_task
ql update 47 progress "Found the root cause"  # calls update_task(progress)
ql update 47 note "Context for whoever"       # calls update_task(note)
ql update 47 handoff <user_id> "Need creds"   # calls update_task(handoff)
ql update 47 block --blocked-by 32            # calls update_task(blocked)
ql update 47 done                             # calls update_task(completed)
ql update 47 cancel "reason"                  # calls update_task(cancelled)
ql admin list-pending                         # list pending users
ql admin approve <user_id>                    # approve a user
```

### Config files

```
~/.ql/
├── id_ed25519       # private key
├── id_ed25519.pub   # public key
├── token            # current JWT
└── config           # server URL, user_id
```

### `ql mcp-config`

Outputs a ready-to-paste MCP config for agents:

```json
{
  "mcpServers": {
    "quest-log": {
      "command": "npx",
      "args": ["@quest-log/mcp"],
      "env": {
        "QL_TOKEN": "eyJhbG...",
        "QL_SERVER_URL": "https://quest-log.example.com"
      }
    }
  }
}
```

This is what goes into `.mcp.json` (project-scoped) or gets added via `claude mcp add`.

## SKILL.md

Shipped alongside the MCP server. Explains to agents:
- What Quest Log is and the handoff model
- When to use each event type
- What a good task description looks like
- How to report capability gaps vs regular blockers
- Conventions for subtasks and dependencies
- How `on_behalf_of` works for acting on behalf of humans

This document will be written during implementation once the tools are stable.

## Tech Stack

- TypeScript / Node.js
- PostgreSQL (with migrations)
- MCP SDK (`@modelcontextprotocol/sdk`) — server and client
- SSH keypair auth (ed25519, Node `crypto` module) for identity
- JWT (jsonwebtoken) for bearer tokens

No Express, no HTTP framework. The MCP server runs over stdio (for local agents) or streamable HTTP (for remote connections).

## Testing Strategy

TDD from the start. Tests run against real Postgres — no mocking the data layer.

- **Vitest** — test runner
- **Real Postgres** — test DB with migrations, no mocks
- **Direct tool handler calls** — tests call the tool handler functions directly, passing in a DB client. No need for Supertest since there's no HTTP layer.

### Test isolation

Each test runs inside a transaction that rolls back at the end.

```typescript
// test/setup.ts
import { Pool, PoolClient } from 'pg';

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
2. **Event insertion + projection** — insert event via tool handler, verify tasks row updated correctly in same transaction.
3. **Optimistic locking** — two concurrent claims, only one succeeds.
4. **Registration flow** — register → pending, admin approve → active, agent creation by active human → immediate active.
5. **Auth** — valid JWT accepted, expired JWT rejected, authenticate tool: valid SSH signature → token issued, expired nonce rejected, unknown user rejected, pending user can register but not use other tools.
6. **Task lifecycle** — full flow: create → claim → progress → handoff → claim → complete.
7. **Dependencies** — block B on A → complete A → B gets unblocked event.
8. **Idempotency** — same idempotency_key twice → same response, no duplicate event.
9. **Webhooks** — event fires → matching webhook receives POST with correct signature.
10. **Staleness** — unowned task older than threshold → stale webhook fires.

## Environment & Configuration

```bash
# .env
DATABASE_URL=postgresql://user:pass@localhost:5432/quest_log
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/quest_log_test
QL_JWT_SECRET=your-secret-here     # signs/verifies tokens
QL_TOKEN_EXPIRY_DAYS=90            # token lifetime
QL_STALENESS_INTERVAL_MS=3600000   # 1 hour
QL_TRANSPORT=stdio                 # or http
QL_HTTP_PORT=3000                  # only if transport=http
```

### docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: quest_log
      POSTGRES_PASSWORD: quest_log
      POSTGRES_DB: quest_log
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

Test DB is created by the test setup script: `CREATE DATABASE quest_log_test`.

## Implementation Order

1. **Project scaffolding** — package.json, tsconfig, vitest config, docker-compose, test setup
2. **Migrations** — all 4 migration files, migration runner
3. **Projection** — `applyEvent()` with unit tests
4. **Core tools** — create_task, list_tasks, get_task, update_task, claim_task — with integration tests calling handlers directly
5. **MCP server wiring** — register tools, stdio/SSE transport
6. **Auth** — JWT verification middleware, `authenticate` tool (nonce + SSH signature → token) + tests
7. **User management** — register_user, admin tools, `ql agent create` + tests
8. **Webhooks** — registration, dispatch, signature + tests
9. **Staleness** — periodic check + tests
10. **Dependency auto-unblock** — completion triggers unblock + tests
11. **CLI** — MCP client wrapping tool calls, key management
12. **SKILL.md** — agent guidance document
