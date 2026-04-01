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

## Add to your agent

If Quest Log is already set up in your org, this is all you need.

### 1. Install the CLI and connect

```sh
npm install -g questlog-ai

ql init --host https://quest-log.your-org.com
```

This generates an ed25519 keypair at `~/.ql/` and saves the server URL.

### 2. Install the MCP server

```sh
ql install
```

This adds Quest Log as a remote MCP server in Claude Code (user scope). Your agent now has access to all Quest Log tools.

### 3. Register your agent

Open Claude Code and tell your agent:

```
"Register yourself with Quest Log"
```

Your agent will call `register_user` via the REST API with its keypair, then authenticate to get a JWT. If an admin has already been set up, your registration will be pending until approved.

### 4. Use it

Once registered and approved, talk naturally:

```
"Create a task to update the API docs before Friday, assign it to me"
"What tasks are open?"
"Mark the API docs task as done"
"Hand the deploy task to Alex with a note about the config change"
```

## First-time setup

One person sets up the server and becomes the first admin. After that, registration is locked down and new users need approval.

### 1. Deploy the server

Quest Log needs a PostgreSQL database and two environment variables:

```sh
DATABASE_URL=postgresql://user:pass@host:5432/quest_log
QL_JWT_SECRET=your-random-secret-here
```

Migrations run automatically on startup.

### 2. Register yourself as admin

```sh
# Install CLI and connect
npm install -g questlog-ai
ql init --host https://quest-log.your-org.com

# Register yourself (ql init generated your keypair)
ql register --name "Your Name"

# Make yourself the first admin — this locks down registration
ql admin set <your-user-id>
```

Users registered via the CLI get a keypair and can authenticate. Users registered via the REST API without a key are assignees only — they can be referenced in tasks but can't call the API directly.

Until you run `ql admin set`, registration is open and everyone is auto-approved. Once the first admin exists, all new registrations are pending.

### 3. Approve new users

When agents or other humans register, they go into a pending queue:

```sh
# See who's waiting
ql admin list-pending

# Approve a user (also approves their key)
ql admin approve <user_id>

# List all users
ql users

# Promote another user to admin
ql admin set <user_id>

# Revoke a user's key (forces re-registration)
ql admin revoke-key <user_id>
```

## MCP tools

Quest Log exposes 5 tools over MCP. These manage **persistent, cross-session work items** — use them for work that needs tracking, handoffs, or an audit trail. They are not for ephemeral to-dos or in-conversation scratch notes.

| Tool | Auth | Description |
|------|------|-------------|
| `create_task` | Yes | Create a tracked work item with title, body, priority, due date, tags |
| `list_tasks` | Yes | List/filter by status (open/done/cancelled), owner, tags, parent, creator |
| `get_task` | Yes | Get a task with its full event history |
| `update_task` | Yes | Add events: note, progress, handoff, completed, cancelled, blocked, etc. |
| `claim_task` | Yes | Claim an unowned task — sets you as the owner |

Auth (registration, authentication) and admin operations are handled via REST endpoints, not MCP.

## How it works

**Event-sourced.** Every action — creation, progress update, handoff, completion — is an immutable event. The task's current state is just a projection of its event history. You always know who did what and when.

**Handoff-first.** The core primitive is ownership transfer. An agent picks up a task, works it, and either finishes it or hands it back with context about what's needed. No work disappears into a void.

**Agents are users.** Humans and agents share the same interface. An agent can create tasks, claim work, report progress, and hand things off — just like a person. Community agents can act on behalf of others.

**Deliberately simple.** Three task states: open, done, cancelled. No workflow engine, no routing rules, no domain logic. Intelligence lives in the agents, not the system.

## Interfaces

Humans talk to their agents. Agents talk to Quest Log. AI is the UI.

- **MCP server** — 5 core task tools
- **REST API** — auth and admin endpoints
- **CLI (`ql`) + Skill** — MCP client for agents that don't natively support MCP

## Install the Skill

Install globally so it's available across all projects:

```bash
npx skills add -g passportxyz/questlog
```

Or via the CLI after authenticating:

```bash
npx questlog-ai install
```

## More

See [docs/implementation-plan.md](docs/implementation-plan.md) for architecture, data model, API endpoints, and testing strategy.
