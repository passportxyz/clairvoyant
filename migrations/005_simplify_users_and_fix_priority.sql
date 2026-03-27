-- Remove human/agent distinction, parent hierarchy, and admin approval
ALTER TABLE users DROP COLUMN IF EXISTS type;
ALTER TABLE users DROP COLUMN IF EXISTS status;
ALTER TABLE users DROP COLUMN IF EXISTS is_admin;
ALTER TABLE users DROP COLUMN IF EXISTS parent_id;

DROP INDEX IF EXISTS idx_users_status;
DROP INDEX IF EXISTS idx_users_parent_id;

-- Fix priority column: text → integer
ALTER TABLE tasks ALTER COLUMN priority TYPE integer USING priority::integer;

-- Add missing indexes for query patterns
CREATE INDEX IF NOT EXISTS idx_events_blocked_by ON events ((metadata->>'blocked_by_task_id'))
  WHERE event_type = 'blocked' AND metadata->>'blocked_by_task_id' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_created_at_id ON tasks (created_at, id);

-- Remove redundant index (idempotency_key already has a UNIQUE constraint)
DROP INDEX IF EXISTS idx_events_idempotency;
