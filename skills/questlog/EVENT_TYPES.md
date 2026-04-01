# Event Types

Events are the core write primitive in Quest Log. Every action on a task appends an immutable event. Use these with the `update_task` MCP tool or `ql update` CLI command.

## note

Add context without changing state. Use when you want to record something for the history — observations, links, decisions, context that future readers will need. Can be added even to completed/cancelled tasks.

## progress

Report what you've done. Use during long-running work to show you're alive and making headway. Include specifics: "Found the root cause in auth.ts line 42" not "Working on it."

## handoff

Transfer ownership. Requires `metadata.to_user_id`. Always include context in `body` about what you've done, what remains, and what the recipient needs to know.

## blocked

Can't proceed. Two flavors:

- **Blocked by another task:** set `metadata.blocked_by_task_id`. The system will auto-unblock when that task completes.
- **Capability gap:** set `metadata.capability_gap: true`. Use when you literally cannot do something — no API access, wrong tools, need human judgment.

Always explain what's blocking in `body`.

## field_changed

Update task metadata (title, priority, due_date, tags). Requires `metadata.field`, `metadata.old_value`, and `metadata.new_value`. The `old_value` is an optimistic concurrency check — if the current value doesn't match, the update fails.

## completed

Task is done. Include brief completion notes in `body`. Triggers auto-unblock for any tasks that depend on this one.

## cancelled

Task is no longer needed. Include the reason in `body`. Also triggers auto-unblock for dependent tasks.
