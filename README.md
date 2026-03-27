# Clairvoyant

> *The AI that sees clearly on your behalf.*

Named after the Skyrim spell that reveals a glowing trail to your objective — Clairvoyant is an event-sourced task management system built for human/agent collaboration. The core primitive is the **handoff**: every task has a ball, and it's always in someone's court.

## Why

Tasks pile up in people's heads. Agents can help, but there's no clean way to pass work back and forth between humans and AI. Existing tools don't understand that an agent might do 80% of a task and need a human for the last 20%.

Clairvoyant makes that handoff loop explicit, low-friction, and visible. Over time, more handoffs go agent→done instead of agent→human. The system doesn't force automation — it starts manual and you automate what makes sense, piece by piece.

## Architecture

### Event Sourcing

There are no edits. Every action is an append-only event. The current state of a task is derived by replaying its event history. This gives you full audit trails, clean progress tracking, and the ability to reconstruct any task's journey from creation to completion.

### Data Model

**tasks** (materialized current state — derived from events)
```
id              uuid
title           text
status          pending | active | blocked | done | cancelled
owner_id        uuid        -- who has the ball right now
creator_id      uuid        -- who created it, defaults as responsible human
parent_task_id  uuid?       -- for subtask lineage
priority        text?
due_date        timestamp?
tags            text[]
created_at      timestamp
updated_at      timestamp
```

**events** (the source of truth — append only, never edited)
```
id              uuid
task_id         uuid
event_type      created | note | progress | handoff | blocked | completed | cancelled
actor_id        uuid        -- who did this (human or agent)
body            text        -- the meat: description, progress update, context
metadata        jsonb       -- structured data (gap descriptions, handoff reasons, etc.)
created_at      timestamp
```

"Notes" and "progress" are the same thing — events with a body. The first event is the description. Subsequent events are progress updates. An agent picking up a task reads the event stream top to bottom and has full context.

**users** (humans and agents are both users)
```
id              uuid
name            text
type            human | agent
public_key      text        -- SSH public key for auth + future encryption
parent_id       uuid?       -- agents link to their parent human
created_at      timestamp
```

### How It Works

1. **Human creates a task** — first event's body is the description, as rich as needed
2. **Triage bot picks it up** — researches, appends progress events with context/game plans, hands back to owner
3. **Agent claims and works a task** — appends progress events as it goes
4. **Agent gets stuck** — `blocked` event with handoff to human, body explains why and what's needed
5. **Human unblocks** — does the thing, provides info, grants access, hands back or completes
6. **Subtasks** — agent spawns child tasks with `parent_task_id` when work is genuinely separate
7. **Capability gaps** — surface as blocked events. Over time, the org closes gaps and more tasks go fully automated

### What the System Does NOT Do

- **No routing logic** — agents self-select tasks by tag or assignment
- **No domain knowledge** — doesn't know about repos or which agent knows what
- **No built-in notifications** — consumers set up their own polling (scheduled tasks, cron, etc.)
- **No offline mode** — always online, single tenant per org

The system is deliberately dumb. Intelligence lives in the agents, not the data model.

## Interfaces

### MCP Server (primary)

Hosted MCP server — any Claude Code instance or agent installs it and can interact with tasks. This is the primary interface for agents.

### CLI (`cv`)

Thin wrapper around the same API for non-MCP contexts and scripting:

```bash
cv init                          # generate or link SSH keypair
cv auth register                 # register public key with server
cv add "Fix the login bug"       # create a task
cv list --mine                   # what's on my plate
cv claim 47                      # pick up a task
cv progress 47 "Found the root cause, working on fix"
cv handoff 47 --to lucian --context "Need DB credentials"
cv done 47
```

### Auth

SSH keypairs, managed by the CLI. Public key registered with the server, requests signed with private key. No passwords, no tokens to rotate.

Future: encrypt task bodies with recipient's public key for private tasks.

## Deployment

- **API server** — Node/TypeScript, Express
- **Database** — Postgres
- **Agent workers** — Claude Code SDK
- **Container** — runs alongside existing infrastructure, uses broker server for GitHub credentials

### The Triage Bot

Not part of the core product — it's a pattern. A triage bot is just another registered user that queries for untriaged tasks, does research/prep, and hands them back enriched. Deploy it alongside Clairvoyant for the "it just works" experience. Per-user agents are the optional power-user layer.

## The Automation Spectrum

Any task can live anywhere on this spectrum:

1. **Fully manual** — human does it, system just tracks
2. **Agent-prepped** — agent does the homework, human executes
3. **Agent-executed, human-approved** — agent does it, human reviews
4. **Fully automated** — agent does it, no human needed

The system doesn't assume where you are. It just makes each handoff point clean and lets you tighten the loop when you're ready. Start manual, automate what makes sense.

## Tech Stack

- TypeScript / Node.js
- PostgreSQL
- Express API
- Claude Code SDK (agent workers)
- SSH keypair auth
