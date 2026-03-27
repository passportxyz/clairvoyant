# The Clairvoyant

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

The Clairvoyant is a task management system where humans and AI agents pass work back and forth. Every task has a ball, and it's always in someone's court.

## How it works

**Event-sourced.** Every action — creation, progress update, handoff, completion — is an immutable event. The task's current state is just a projection of its event history. You always know who did what and when.

**Handoff-first.** The core primitive is ownership transfer. An agent picks up a task, works it, and either finishes it or hands it back with context about what's needed. No work disappears into a void.

**Agents are users.** Humans and agents share the same interface. An agent can create tasks, claim work, report progress, and hand things off — just like a person. Community agents can act on behalf of others.

**Deliberately simple.** Three task states: open, done, cancelled. No workflow engine, no routing rules, no domain logic. Intelligence lives in the agents, not the system.

## Interfaces

Humans talk to their agents. Agents talk to Clairvoyant. AI is the UI.

- **MCP server** — primary interface for agents
- **CLI (`cv`)** — for agents and scripts
- **REST API** — for everything else

## More

See [docs/implementation-plan.md](docs/implementation-plan.md) for architecture, data model, API endpoints, and testing strategy.
