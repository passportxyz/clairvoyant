# MCP Tools Reference

Quest Log exposes 6 tools over MCP. These manage persistent, cross-session work items — use them for work that needs tracking, handoffs, or an audit trail.

## create_task

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

## list_tasks

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

## get_task

Get a single task with its full event history.

| Param | Required | Description |
|---|---|---|
| `task_id` | yes | The task UUID |

Use when: you need the full context of a task — all events, who did what, current state.

## update_task

Update a task by appending an event. This is the primary write operation.

| Param | Required | Description |
|---|---|---|
| `task_id` | yes | Target task |
| `event_type` | yes | See [EVENT_TYPES.md](EVENT_TYPES.md) |
| `body` | depends | Text content (required for most types) |
| `metadata` | depends | Structured data (varies by type) |
| `idempotency_key` | yes | UUID for safe retries |

Use when: recording progress, handing off, blocking, completing, or adding notes to a task.

## claim_task

Atomic claim with optimistic locking. Fails if already owned.

| Param | Required | Description |
|---|---|---|
| `task_id` | yes | Task to claim |
| `idempotency_key` | yes | UUID for safe retries |

Use when: picking up an unowned task from the triage pool. Returns `already_claimed` with the current `owner_id` if someone beat you to it.

## attach_file

Attach a file to a task. Reads a local file from disk, stores it on the server, and records metadata. Max 10MB.

| Param | Required | Description |
|---|---|---|
| `task_id` | yes | The task to attach the file to |
| `file_path` | yes | Absolute path to the file on the local filesystem |
| `description` | yes | What this attachment contains and why it is relevant |

Use when: attaching screenshots, design mockups, logs, configs, or any artifact that provides context for a task. The description is used by AI to reference the attachment without needing to view it directly.

**Note:** The file path must be accessible to the Quest Log server process. For co-located deployments (CLI and server on the same machine), local paths work directly.

## Idempotency

Every write operation requires an `idempotency_key` — a UUID you generate. If your request fails and you retry with the same key, the system returns the original result instead of creating a duplicate. Generate the key once, keep it, retry with it.

## Subtasks and Dependencies

**Subtasks:** use `parent_task_id` when creating a task to nest it under a parent. Use `list_tasks` with `parent_task_id` to see all subtasks.

**Dependencies:** use `blocked` with `metadata.blocked_by_task_id` to declare that your task depends on another. When the blocking task completes or is cancelled, the system automatically inserts an `unblocked` event on your task.
