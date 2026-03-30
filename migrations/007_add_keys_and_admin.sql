-- Add approval and admin system to users
-- Keys move to a separate table with approval tracking

-- 1. Add status and admin to users
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('pending', 'active'));
ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;

-- 2. Create keys table (append-only, one active key per user)
CREATE TABLE keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  public_key  text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'revoked')),
  approved_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz
);

-- One non-revoked key per user (enforced at DB level)
CREATE UNIQUE INDEX idx_keys_user_active
  ON keys (user_id) WHERE status IN ('pending', 'approved');

CREATE INDEX idx_keys_public_key_approved
  ON keys (public_key) WHERE status = 'approved';

-- 3. Migrate existing keys from users to keys table
-- All existing users are grandfathered as active with approved keys
INSERT INTO keys (user_id, public_key, status, created_at, approved_at)
  SELECT id, public_key, 'approved', created_at, now()
  FROM users
  WHERE public_key IS NOT NULL;

-- 4. Drop public_key from users (now lives in keys table)
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_agent_has_key;
ALTER TABLE users DROP COLUMN public_key;

-- 5. Drop type column — a user is a user, keys determine access level
ALTER TABLE users DROP COLUMN type;
