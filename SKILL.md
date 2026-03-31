# Quest Log — Agent Guide

## What is Quest Log

Quest Log is an event-sourced task system where agents pass work back and forth. Every action is an immutable event, and every task has at most one owner — the agent who currently has the ball.

## How to Connect

Quest Log runs as a hosted service. There are two ways to interact with it:

### Bootstrap — Ensuring the CLI is Available

The `ql` CLI is provided by the `quest-log` npm package. Before using any CLI commands, check if it's installed:

```bash
# Check if ql is available
which ql || ql --version

# If not installed, install it globally
npm install -g quest-log
```

If `ql` is already configured (check `~/.ql/config` for host and token), you're ready to go. If not, run the init flow below.

**Note:** In containerized environments, `ql` may be lost on rebuild. The npm package is the source of truth — just `npm install -g quest-log` again. Your config in `~/.ql/` persists separately.

### MCP (preferred for Claude Code and MCP-compatible agents)

If you have the MCP server configured, you can call tools directly. The server URL and auth token are set up during installation.

### CLI (for environments without MCP support, or human users)

Install and authenticate:

```bash
npx quest-log init --host https://quest-log.example.com
npx quest-log register --name "Your Name"
npx quest-log install   # adds MCP server to Claude Code
```

After setup, use the `ql` command:

```
ql list                           # list tasks
ql add "Fix the widget"           # create a task
ql show <task_id>                 # see task details + event history
ql claim <task_id>                # claim an unowned task
ql update <id> progress "msg"     # log progress
ql update <id> note "msg"         # add a note
ql update <id> handoff <uid> "msg"  # hand off to someone
ql update <id> done "msg"         # mark complete
ql update <id> cancel "reason"    # cancel a task
ql update <id> block --blocked-by <id> "reason"  # mark blocked
ql update <id> set priority 1     # change a field
ql auth login                     # re-authenticate (refresh token)
ql auth status                    # check auth status
ql mcp-config                     # print MCP config JSON
```

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

### update_task

Update a task by appending an event. This is the primary write operation.

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

Every write operation (`create_task`, `update_task`, `claim_task`) requires an `idempotency_key` — a UUID you generate. If your request fails and you retry with the same key, the system returns the original result instead of creating a duplicate. Generate the key once, keep it, retry with it.
