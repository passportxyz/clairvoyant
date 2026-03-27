# The Clairvoyant

An event-sourced task management system built for human/agent collaboration. Clairvoyant sees across all the moving pieces — who's working on what, what's blocked, and where things need to go next. The core primitive is the **handoff**: every task has a ball, and it's always in someone's court.

## Why

Tasks pile up in people's heads. Agents can help, but there's no clean way to pass work back and forth between humans and AI. Existing tools don't understand that an agent might do 80% of a task and need a human for the last 20%.

Clairvoyant makes that handoff loop explicit, low-friction, and visible. Over time, more handoffs go agent→done instead of agent→human. The system doesn't force automation — it starts manual and you automate what makes sense, piece by piece.

## Architecture

### Event Sourcing

Every action is an append-only event. The `tasks` table is a materialized view kept in sync via **synchronous projection** — every event insert updates the tasks row in the same Postgres transaction. Reads are always fast (just query `tasks`), and the event log is the full audit trail.

```sql
BEGIN;
INSERT INTO events (...) VALUES (...);
UPDATE tasks SET status = $new, owner_id = $new, version = version + 1 WHERE id = $task_id AND version = $expected;
COMMIT;
```

Every field change is an event — when a bot sets priority and a human overrides it, both are visible in the history. You always know who decided what and when.

### Data Model

**tasks** (materialized current state — updated synchronously on every event)
```
id              uuid
title           text
status          open | done | cancelled
owner_id        uuid?       -- who has the ball (null = unowned, available for pickup)
creator_id      uuid        -- who created it
parent_task_id  uuid?       -- for subtask lineage
priority        text?       -- set by triage bot or human, not required at creation
due_date        timestamp?  -- only for real deadlines, not required at creation
tags            text[]      -- inferred by triage bot or set explicitly
version         integer     -- optimistic locking, incremented on every event
created_at      timestamp
updated_at      timestamp
```

**events** (the source of truth — append only, never edited)
```
id              uuid
task_id         uuid
event_type      created | note | progress | handoff | claimed | blocked | unblocked | field_changed | completed | cancelled
actor_id        uuid        -- who did this (human or agent)
body            text        -- the meat: description, progress update, context
metadata        jsonb       -- structured data (see below)
idempotency_key uuid        -- unique, prevents duplicate events on retry
created_at      timestamp
```

Event types:
- `created` — task created. Body is the description. Metadata: `{ priority?, due_date?, tags?, owner_id?, on_behalf_of? }`
- `note` — context or commentary. No state change.
- `progress` — work update. No state change, just records what was done.
- `handoff` — ownership transfer. Metadata: `{ from_user_id?, to_user_id, reason? }`
- `claimed` — agent/human picks up an unowned task. Metadata: `{ user_id }`
- `blocked` — something is preventing progress. Metadata: `{ reason, blocked_by_task_id?, capability_gap? }`. If `blocked_by_task_id` is set, this is a dependency — automatically resolved when that task completes.
- `unblocked` — dependency resolved or blocker cleared. System-generated when a blocking task completes.
- `field_changed` — priority, tags, due_date, etc. Metadata: `{ field, old_value, new_value }`
- `completed` — task is done. Status → `done`.
- `cancelled` — task is no longer needed. Status → `cancelled`.

"Notes" and "progress" are the same thing conceptually — events with a body. The first event is the description. Subsequent events are the story. An agent picking up a task reads the event stream top to bottom and has full context.

**users** (humans and agents are both users)
```
id              uuid
name            text
type            human | agent
status          pending | active     -- pending until approved by admin
is_admin        boolean              -- set manually in DB for now
public_key      text        -- SSH public key for auth + future encryption
parent_id       uuid?       -- agents link to their parent human
created_at      timestamp
```

### User Registration

Registration is gated — you can't just show up and start using the system.

**Humans:**
1. `cv init` generates an SSH keypair locally
2. `cv auth register` sends the public key + name to the server
3. The user lands in `pending` status
4. An admin runs `cv admin pending` to see pending registrations, then `cv admin approve <user_id>` to activate them

**Agents:**
- Only an active human can create agents. The agent's `parent_id` links to the human who created it.
- Agent registration is immediate — no approval needed, since the parent human is already trusted.
- Community/shared agents (serving multiple people, not owned by one human) can be created by admins.

**Admin status** is an `is_admin` boolean on the users table, set manually in the database for now. The first user bootstraps by setting it directly in Postgres. Admin operations are also exposed via the MCP server for agent-driven workflows.

### Authorization

Open by design. Any authenticated user can modify any task. The audit trail is the safety net — every action is recorded with who did it and when. This keeps agent interactions simple and avoids complex permission logic that would create friction.

### Task States

Three states: **open**, **done**, **cancelled**. That's it.

"Blocked" and "active" aren't states — they're context in the event stream. A task with a recent `blocked` event is blocked. A task with recent `progress` events is active. But the task is still just `open`. The events tell the full story; the status field tells you whether it still needs to be done.

### Task Dependencies

When the triage bot (or anyone) realizes task B can't start until task A is done:

1. Append a `blocked` event to task B with `metadata: { blocked_by_task_id: task_A_id }`
2. When task A completes, the system automatically checks for tasks blocked by A
3. System appends an `unblocked` event to those tasks
4. The triage bot or assigned agent sees the unblocked event and resumes work

Dependencies are expressed as events, not schema fields. Multiple dependencies = multiple blocked events. A task is considered dependency-blocked if it has any unresolved `blocked` events with `blocked_by_task_id` set.

### Concurrent Claims — Optimistic Locking

The `version` column on `tasks` prevents race conditions. When two agents try to claim the same unowned task:

```sql
UPDATE tasks SET owner_id = $agent, version = version + 1
  WHERE id = $task_id AND owner_id IS NULL AND version = $expected;
-- 0 rows affected = someone else got it first
```

The loser gets a conflict response and moves on to the next task.

### Webhooks

The handoff is the core primitive — when ownership changes, consumers need to know. Clairvoyant fires webhooks on ownership changes (handoff, claimed, task creation with owner). Consumers configure endpoints to wire into Telegram, Slack, email, or whatever.

### Staleness Alerts

If tasks sit unowned for too long (configurable, default 1 hour), the system fires a notification. This prevents silent failures when the triage bot is down.

### Task Lifecycle

1. **Someone creates a task** — a human via CLI, an agent on its own, or an agent on behalf of a human (e.g. a community bot that takes requests from Telegram). Rich description in the first event's body. No owner by default (goes to the triage pool). Use `--owner` to claim it immediately if you don't need triage.
2. **Triage bot picks up unowned tasks** — evaluates the task. Can it just do it? Does it, marks done. Need research? Enriches with context, sets priority/tags, assigns to the right person or agent. Need a human? Assigns to creator or whoever fits.
3. **Agent works a task** — appends progress events as it goes
4. **Agent gets stuck** — `blocked` event with context on what's needed, optionally with `blocked_by_task_id` for dependencies
5. **Human or system unblocks** — human provides info/access, or a dependency completes and the system auto-unblocks
6. **Subtasks** — agent spawns child tasks with `parent_task_id` when work is genuinely separate. Parent lifecycle is managed by agents, not automatic.
7. **Capability gaps** — surface as blocked events with `capability_gap` in metadata. Over time, the org closes gaps and more tasks go fully automated.

### What the System Does NOT Do

- **No routing logic** — agents self-select tasks by tag or assignment
- **No domain knowledge** — doesn't know about repos or which agent knows what
- **No offline mode** — always online, single tenant per org
- **No authorization restrictions** — open access, audit trail is the safety net

The system is deliberately dumb. Intelligence lives in the agents, not the data model.

## Interfaces

### MCP Server (primary)

Hosted MCP server — any Claude Code instance or agent installs it and can interact with tasks. This is the primary interface for agents. Paired with a `SKILL.md` that agents can reference for guidance on how to interact with Clairvoyant effectively — when to use which event types, what good task descriptions look like, handoff conventions, etc.

### CLI (`cv`)

Thin wrapper around the same API for non-MCP contexts and scripting:

```bash
cv init                          # generate or link SSH keypair
cv auth register                 # register public key with server
cv add "Fix the login bug"       # create a task (unowned, goes to triage pool)
cv add "My thing" --owner me     # create and claim it yourself
cv list --mine                   # what's on my plate
cv list --unowned                # what's in the triage pool
cv claim 47                      # pick up a task
cv progress 47 "Found the root cause, working on fix"
cv handoff 47 --to lucian --context "Need DB credentials"
cv block 47 --depends-on 32     # task 47 can't start until task 32 is done
cv done 47
cv admin pending                 # list pending registrations (admin only)
cv admin approve <user_id>       # approve a pending user (admin only)
```

### SKILL.md

A companion document shipped alongside the MCP tools and CLI. Any agent can reference it to understand:
- What Clairvoyant is and how it works
- How to create, claim, and hand off tasks
- What good task descriptions look like
- When to use `blocked` vs `progress` vs `note`
- Conventions for dependencies and subtasks
- How to report capability gaps

This is the "how to be a good Clairvoyant citizen" guide for agents.

### Auth

SSH keypairs, managed by the CLI. Public key registered with the server, requests signed with private key. No passwords, no tokens to rotate.

### API Endpoints

```
POST   /tasks                  -- create task
GET    /tasks                  -- list tasks (filterable by status, owner, tags, unowned)
GET    /tasks/:id              -- single task + event history
POST   /tasks/:id/events       -- append event
POST   /tasks/:id/claim        -- atomic claim (optimistic lock)
POST   /users                  -- register user (lands in pending)
GET    /users/:id              -- user info
GET    /admin/pending          -- list pending registrations (admin only)
POST   /admin/approve/:id      -- approve a pending user (admin only)
POST   /webhooks               -- register webhook endpoint
```

## Deployment

- **API server** — Node/TypeScript, Express, TLS
- **Database** — Postgres with migrations (node-pg-migrate or similar)
- **Agent workers** — Claude Code SDK
- **Container** — runs alongside existing infrastructure, uses broker server for GitHub credentials

### The Triage Bot

Not part of the core product — it's a pattern. A triage bot is just another registered user that queries for unowned tasks, evaluates them, and either completes them directly, enriches them with research and game plans, or assigns them to the right person/agent. Deploy it alongside Clairvoyant for the "it just works" experience. Per-user agents are the optional power-user layer.

### Community Agents

Agents that serve a group rather than one person — a Telegram bot that takes task requests from a channel, a Slack bot that lets anyone file work, etc. These are first-class citizens:

- Registered as `type: agent` with an admin as parent (or org-level parent)
- When creating tasks on behalf of a human, set `on_behalf_of` in the `created` event metadata to record who actually requested it
- The `actor_id` on the event is the agent; `on_behalf_of` is the human — full provenance in the audit trail
- Community agents can create tasks, add notes, and hand off work just like any other user

This means a person can say "hey bot, remind the team to update the docs" in Telegram, and the community agent creates a task with itself as `actor_id` and the requester as `on_behalf_of`. The event stream tells the whole story.

## Tech Stack

- TypeScript / Node.js
- PostgreSQL (with migrations)
- Express API (TLS)
- Claude Code SDK (agent workers)
- SSH keypair auth

## Testing Strategy

TDD from the start. Tests run against real Postgres — no mocking the data layer.

- **Vitest** — test runner (fast, native TypeScript)
- **Supertest** — HTTP-level tests against Express endpoints
- **Real Postgres** — test DB with migrations, no mocks (event sourcing is too core to fake)

### Test isolation

Each test runs inside a transaction that rolls back at the end — fast, no cleanup needed, fully isolated.

### TDD flow

1. Write a failing test for the endpoint or behavior
2. `beforeAll` runs migrations on the test DB
3. Implement until green
4. Core loop: append events → assert projected task state is correct

### What to test first

1. **Event projection** — create task event → task row exists with correct state
2. **Optimistic locking** — concurrent claims → only one wins
3. **Registration flow** — register → pending, admin approve → active
4. **Task lifecycle** — create → claim → progress → handoff → complete
5. **Dependencies** — block task B on A → complete A → B auto-unblocked
