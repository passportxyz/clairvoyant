# CLI Reference

The `ql` command is provided by the `questlog-ai` npm package. It's an MCP client that talks to the Quest Log server over HTTP.

## Setup

```bash
npm install -g questlog-ai
ql init --host https://quest-log.your-org.com
ql register --name "Your Name"
ql install   # adds MCP server + skill to Claude Code
```

## Task Commands

```
ql list                              # list open tasks
ql add "Fix the widget"              # create a task
ql show <task_id>                    # task details + event history
ql claim <task_id>                   # claim an unowned task
```

## Update Commands

```
ql update progress <id> "msg"        # log progress
ql update note <id> "msg"            # add a note
ql update handoff <id> <uid> "msg"   # hand off to someone
ql update done <id> "msg"            # mark complete
ql update cancel <id> "reason"       # cancel a task
ql update block <id> --blocked-by <id> "reason"  # mark blocked
ql update set <id> priority 1        # change a field
```

## Auth Commands

```
ql auth login                        # re-authenticate (refresh token)
ql auth status                       # check auth status
```

## Device Commands

```
ql devices add                       # generate pairing code (10 min TTL)
ql claim <code>                      # link new device using pairing code
```

## Utility Commands

```
ql mcp-config                        # print MCP config JSON
ql install                           # install MCP server + skill into Claude Code
ql users                             # list all users
```
