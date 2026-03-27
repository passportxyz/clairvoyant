# Clairvoyant — Agent Guide

## What is Clairvoyant

Clairvoyant is an event-sourced task system where agents pass work back and forth. Every action is an immutable event, and every task has at most one owner — the agent who currently has the ball. You interact with it through MCP tools.

## Core Concepts

**Three task states:** `open`, `done`, `cancelled`. That's it.

**Events are append-only.** Every action (progress, handoff, completion) is recorded as an immutable event. The task's current state is a projection of its event history.

**Ownership = who has the ball.** Every open task has at most one owner. When you own a task, you're expected to work it or hand it off. When you're done, mark it complete or transfer it.

**The triage pool.** Open tasks with no owner sit in the triage pool, waiting to be claimed. Query for them with `list_tasks` using `owner_id: null`.

## MCP Tools Reference

### create_task

Create a new task. Inserts a `created` event atomically.

| Param | Required | Description |
|---|---|---|
| `title` | yes | What needs to be done (imperative voice) |
| `body` | yes | Description, context, acceptance criteria |
| `owner_id` | no | Assign immediately (skip triage pool) |
| `parent_task_id` | no | Make this a subtask |
| `priority` | no | Priority level (integer, 0=highest) |
| `due_date` | no | ISO 8601 datetime |
| `tags` | no | String array |
| `idempotency_key` | yes | UUID for safe retries |

Use when: starting new work, breaking a task into subtasks, recording something to track.

### list_tasks

Query tasks with filters. Returns materialized task rows (fast).

| Param | Required | Description |
|---|---|---|
| `status` | no | `open`, `done`, or `cancelled` |
| `owner_id` | no | Filter by owner. `null` = triage pool |
| `tags` | no | AND filter on tags |
| `parent_task_id` | no | List subtasks of a task |
| `creator_id` | no | Filter by who created them |
| `cursor` | no | Pagination cursor |

Use when: checking your queue, scanning the triage pool, finding related tasks.

### get_task

Get a single task with its full event history.

| Param | Required | Description |
|---|---|---|
| `task_id` | yes | The task UUID |

Use when: you need the full context of a task — all events, who did what, current state.

### append_event

Append an event to a task. This is the primary write operation.

| Param | Required | Description |
|---|---|---|
| `task_id` | yes | Target task |
| `event_type` | yes | See event types below |
| `body` | depends | Text content (required for most types) |
| `metadata` | depends | Structured data (varies by type) |
| `idempotency_key` | yes | UUID for safe retries |

Use when: recording progress, handing off, blocking, completing, or adding notes to a task.

### claim_task

Atomic claim with optimistic locking. Fails if already owned.

| Param | Required | Description |
|---|---|---|
| `task_id` | yes | Task to claim |
| `idempotency_key` | yes | UUID for safe retries |

Use when: picking up an unowned task from the triage pool. Returns `already_claimed` with the current `owner_id` if someone beat you to it.

### register_user

Register a new user. Unauthenticated.

| Param | Required | Description |
|---|---|---|
| `name` | yes | Display name |
| `public_key` | yes | SSH ed25519 public key |

### get_user

Get a user by ID.

| Param | Required | Description |
|---|---|---|
| `user_id` | yes | The user UUID |

### authenticate

Exchange an SSH signature for a JWT token. Two-step flow:

1. `{ user_id, action: "request_challenge" }` — get a nonce
2. `{ user_id, action: "verify", nonce, signature }` — get a token

Use when: initial setup or token refresh. The CLI handles this automatically.

### register_webhook

Register a webhook URL to receive event notifications.

| Param | Required | Description |
|---|---|---|
| `url` | yes | Webhook URL (must be valid URL) |
| `events` | yes | Array of event types to subscribe to |

Returns the webhook record and the HMAC secret for verifying payloads.

## Event Types — When to Use Each

### `note`

Add context without changing state. Use when you want to record something for the history — observations, links, decisions, context that future readers will need. Can be added even to completed/cancelled tasks.

### `progress`

Report what you've done. Use during long-running work to show you're alive and making headway. Include specifics: "Found the root cause in auth.ts line 42" not "Working on it."

### `handoff`

Transfer ownership. Requires `metadata.to_user_id`. Always include context in `body` about what you've done, what remains, and what the recipient needs to know.

### `blocked`

Can't proceed. Two flavors:

- **Blocked by another task:** set `metadata.blocked_by_task_id`. The system will auto-unblock when that task completes.
- **Capability gap:** set `metadata.capability_gap: true`. Use when you literally cannot do something — no API access, wrong tools, need human judgment.

Always explain what's blocking in `body`.

### `field_changed`

Update task metadata (title, priority, due_date, tags). Requires `metadata.field`, `metadata.old_value`, and `metadata.new_value`. The `old_value` is an optimistic concurrency check — if the current value doesn't match, the update fails.

### `completed`

Task is done. Include brief completion notes in `body`. Triggers auto-unblock for any tasks that depend on this one.

### `cancelled`

Task is no longer needed. Include the reason in `body`. Also triggers auto-unblock for dependent tasks.

## Good Task Descriptions

**Title:** what needs to be done, imperative voice.
- Bad: "Login bug" or "Fix the thing"
- Good: "Fix login redirect loop on mobile Safari"

**Body:** context, acceptance criteria, relevant links. Give the person claiming this task enough to start working without asking questions.

## Handoff Etiquette

- Always explain what you did and what remains.
- Include relevant context: error logs, partial work, decisions you made and why.
- Don't hand off empty-handed. Do what you can first, then transfer with a clear picture of where things stand.

## Reporting Capability Gaps

Use `blocked` with `metadata.capability_gap: true` when you can't do something. Examples:

- No access to a required API or service
- Can't send emails, make phone calls, or access a physical system
- Need human judgment on a business decision
- Don't have credentials for a third-party platform

This is not failure. It's a signal for the system to route the task to someone who can handle it.

## Subtasks and Dependencies

**Subtasks:** use `parent_task_id` when creating a task to nest it under a parent. Use `list_tasks` with `parent_task_id` to see all subtasks.

**Dependencies:** use `blocked` with `metadata.blocked_by_task_id` to declare that your task depends on another. When the blocking task completes or is cancelled, the system automatically inserts an `unblocked` event on your task.

## Idempotency

Every write operation (`create_task`, `append_event`, `claim_task`) requires an `idempotency_key` — a UUID you generate. If your request fails and you retry with the same key, the system returns the original result instead of creating a duplicate. Generate the key once, keep it, retry with it.
