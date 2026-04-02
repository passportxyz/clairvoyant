-- Allow multiple active keys per user (device pairing support)
DROP INDEX IF EXISTS idx_keys_user_active;

-- Non-unique replacement for query performance
CREATE INDEX idx_keys_user_active_keys
  ON keys (user_id) WHERE status IN ('pending', 'approved');
