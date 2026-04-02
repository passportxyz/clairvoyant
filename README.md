# Quest Log

Task management where humans and AI agents pass work back and forth. Every task has a ball, and it's always in someone's court.

## Install

```bash
npx skills add -g passportxyz/questlog
```

Then tell your agent:

```
"Register yourself with Quest Log"
```

## Use it

Talk naturally:

```
"Create a task to update the API docs before Friday, assign it to me"
"What's in my quest log?"
"What tasks are open in the quest log?"
"Mark the API docs task as done"
"Hand the deploy task to Alex with a note about the config change"
"What did I get done this week?"
```

## MCP Tools

Quest Log exposes 5 tools over MCP for persistent, cross-session work items.

| Tool | Description |
|------|-------------|
| `create_task` | Create a tracked work item with title, body, priority, due date, tags |
| `list_tasks` | List/filter by status (open/done/cancelled), owner, tags, parent, creator |
| `get_task` | Get a task with its full event history |
| `update_task` | Add events: note, progress, handoff, completed, cancelled, blocked, etc. |
| `claim_task` | Claim an unowned task — sets you as the owner |

## More

See [docs/implementation-plan.md](docs/implementation-plan.md) for architecture, data model, API endpoints, and testing strategy.
