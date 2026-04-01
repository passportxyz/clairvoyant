# Quest Log

```
me:       What did you get done last night?

claude:   Morning! I finished the webhook retry logic — it backs off
          exponentially now and dead-letters after 5 failures. PR is up
          and tests are green. I couldn't figure out how to publish the
          newsletter draft though — I don't have access to the mailing
          platform. Want me to create a follow-up task to figure out
          how to automate that?

me:       Yeah go ahead, but hand that one to me. I'll sort it out.
          I also need to get the API docs updated before Friday and
          set up a meeting with the Acme team.

claude:   Created the newsletter automation task and assigned it to you.
          I knocked out the API docs — updated the endpoint reference
          and added the new webhook examples, PR #218.
          For Acme, I already coordinated with their PM — you're
          meeting Thursday at 2pm. Created a task to prep the agenda.
```

Quest Log is a task management system where humans and AI agents pass work back and forth. Every task has a ball, and it's always in someone's court.

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
