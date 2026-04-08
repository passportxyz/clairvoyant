
## Environment Setup

On container rebuild, restore the Quest Log CLI config:

```bash
# ql config is persisted at /app/.borg/persistent/ql/
ln -sf /app/.borg/persistent/ql /home/node/.ql

# ql binary (reinstall if lost)
npm install -g questlog-ai
```

## Key Architecture Notes

- **Webhooks are built-in**: `src/webhooks.ts` dispatches HMAC-signed POSTs on task events. Webhooks table in `migrations/004_create_webhooks.sql`. Registration via `src/tools/webhooks.ts`. Fire-and-forget with 10s timeout.
- **Event-sourced**: Tasks use event sourcing with projections (`src/projection.ts`). Side effects (webhooks, unblocks, staleness) are emitted from projections.
- **Auth codes**: Two systems — attachment access codes and board/device auth codes. Both short-lived, both in the `access_codes` table but with different scopes.
- **Board UI**: Server-rendered from `src/board-router.ts` (not static files), light theme, GSAP animations, task detail modal. Auth via 30-day browser tokens.
- **Production runs in Borg**: The questlog service is deployed via Borg's Docker infrastructure. Coordinate with the Borg thread (thread 935) for infra changes like adding new services to docker-compose.
- **No agency in Quest Log**: Quest Log is a dumb task pipe — no AI, no workflows, no bot logic. Agents interact via MCP tools. Keep it simple.
- **Agent-first design**: CLI and MCP tools are primarily used by agents (e.g. Claude Code) on behalf of users, not by humans directly. Tools that target a user (create_task, subscribe_notifications, etc.) accept an optional `user_id`/`owner_id` param so agents can act on behalf of the user they're helping. The `actorId` from the JWT is the agent's identity; `user_id` is who the action is for.


## Mim Knowledge

@.claude/knowledge/INSTRUCTIONS.md
@.claude/knowledge/KNOWLEDGE_MAP_CLAUDE.md
