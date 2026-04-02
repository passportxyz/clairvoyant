-- Cascade delete to keys and webhooks so deleting a user cleans up auth data.
-- Tasks and events are left alone — admin must reassign/close tasks first.

-- keys: cascade delete (auth data, no value without the user)
ALTER TABLE keys DROP CONSTRAINT keys_user_id_fkey;
ALTER TABLE keys ADD CONSTRAINT keys_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- keys.approved_by: set null (preserve key history)
ALTER TABLE keys DROP CONSTRAINT keys_approved_by_fkey;
ALTER TABLE keys ADD CONSTRAINT keys_approved_by_fkey
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;

-- webhooks: cascade delete (no value without the owner)
ALTER TABLE webhooks DROP CONSTRAINT webhooks_owner_id_fkey;
ALTER TABLE webhooks ADD CONSTRAINT webhooks_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE;
