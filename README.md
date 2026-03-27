# The Clairvoyant

```
you:    Fix the auth redirect bug on staging
  cv:   Got it. I'll take a look.

  cv:   Found it — the callback URL isn't URL-encoded when there's a
        query string. I have a fix. Want me to push it or hand it off?
you:    Push it.
  cv:   Done. PR #214 is up, tests passing.

you:    What's on my plate?
  cv:   3 tasks. The billing migration is blocked — needs a DB credential
        from Jake. The other two are in progress, both on track.

you:    Assign the docs update to the intern bot
  cv:   Handed off. It'll start working on it and check back if it gets stuck.
```

The Clairvoyant is a task management system where humans and AI agents pass work back and forth. Every task has a ball, and it's always in someone's court.

## How it works

**Event-sourced.** Every action — creation, progress update, handoff, completion — is an immutable event. The task's current state is just a projection of its event history. You always know who did what and when.

**Handoff-first.** The core primitive is ownership transfer. An agent picks up a task, works it, and either finishes it or hands it back with context about what's needed. No work disappears into a void.

**Agents are users.** Humans and agents share the same interface. An agent can create tasks, claim work, report progress, and hand things off — just like a person. Community agents can act on behalf of others.

**Deliberately simple.** Three task states: open, done, cancelled. No workflow engine, no routing rules, no domain logic. Intelligence lives in the agents, not the system.

## Interfaces

- **MCP server** — plug into any Claude Code instance or agent
- **CLI (`cv`)** — for humans and scripts
- **REST API** — for everything else

## More

See [docs/implementation-plan.md](docs/implementation-plan.md) for architecture, data model, API endpoints, and testing strategy.
