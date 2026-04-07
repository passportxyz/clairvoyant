
## Environment Setup

On container rebuild, restore the Quest Log CLI config:

```bash
# ql config is persisted at /app/.borg/persistent/ql/
ln -sf /app/.borg/persistent/ql /home/node/.ql

# ql binary (reinstall if lost)
npm install -g questlog-ai
```

## Mim Knowledge

@.claude/knowledge/INSTRUCTIONS.md
@.claude/knowledge/KNOWLEDGE_MAP_CLAUDE.md
