import pg from 'pg';
import {
  getUserById,
  getKeyByPublicKey,
  getActiveKeyForUser,
  insertUser,
  insertKey,
  hasAnyAdmin,
  acquireBootstrapLock,
} from '../db/queries.js';
import {
  generateNonce,
  consumeNonce,
  verifySignature,
  signToken,
} from '../auth.js';
import type { User } from '../types.js';

// ── registerUser (unauthenticated) ────────────────────────────────

export interface RegisterUserInput {
  name: string;
  public_key?: string;
  user_id?: string;
}

export async function registerUser(
  client: pg.PoolClient,
  input: RegisterUserInput,
): Promise<{ user: User; key?: { id: string; status: string }; warning?: string }> {
  // Check for duplicate key
  if (input.public_key) {
    const existing = await getKeyByPublicKey(client, input.public_key);
    if (existing) {
      throw new Error('A user with this public key already exists');
    }
  }

  // Serialize bootstrap check to prevent race conditions
  await acquireBootstrapLock(client);

  // Bootstrap logic: if no admin exists, auto-approve
  const adminExists = await hasAnyAdmin(client);
  const autoApprove = !adminExists;

  let user: User;

  if (input.user_id) {
    // Re-registration: add a new key to an existing user
    const existing = await getUserById(client, input.user_id);
    if (!existing) {
      throw new Error(`User not found: ${input.user_id}`);
    }
    // Ensure they don't already have an active key
    const activeKey = await getActiveKeyForUser(client, input.user_id);
    if (activeKey) {
      throw new Error('User already has an active key. Revoke it first before registering a new one.');
    }
    user = existing;
  } else {
    // New user registration
    user = await insertUser(client, {
      name: input.name,
      status: autoApprove ? 'active' : 'pending',
    });
  }

  let keyResult: { id: string; status: string } | undefined;

  if (input.public_key) {
    const key = await insertKey(client, {
      user_id: user.id,
      public_key: input.public_key,
      status: autoApprove ? 'approved' : 'pending',
    });
    keyResult = { id: key.id, status: key.status };
  }

  const result: { user: User; key?: { id: string; status: string }; warning?: string } = { user };
  if (keyResult) result.key = keyResult;

  if (input.user_id) {
    result.warning = autoApprove
      ? 'New key registered and auto-approved.'
      : 'New key registered — pending admin approval.';
  } else {
    result.warning = autoApprove
      ? 'No admin configured — registration is open. Run "ql admin set <user_id>" to lock down.'
      : 'Registration pending admin approval.';
  }

  return result;
}

// ── getUser ───────────────────────────────────────────────────────

export async function getUser(
  client: pg.PoolClient,
  _actorId: string,
  input: { user_id: string },
): Promise<{ user: User }> {
  const user = await getUserById(client, input.user_id);
  if (!user) throw new Error(`User not found: ${input.user_id}`);
  return { user };
}

// ── authenticate (unauthenticated) ────────────────────────────────

export interface AuthenticateInput {
  user_id: string;
  action: 'request_challenge' | 'verify';
  nonce?: string;
  signature?: string;
}

export async function authenticate(
  client: pg.PoolClient,
  input: AuthenticateInput,
): Promise<
  | { nonce: string; expires_at: Date }
  | { token: string; expires_at: Date; user: User }
> {
  if (input.action === 'request_challenge') {
    const { nonce, expiresAt } = generateNonce(input.user_id);
    return { nonce, expires_at: expiresAt };
  }

  // action === 'verify'
  if (!input.nonce || !input.signature) {
    throw new Error('nonce and signature are required for verify');
  }

  const valid = consumeNonce(input.nonce, input.user_id);
  if (!valid) {
    throw new Error('Invalid or expired nonce');
  }

  const user = await getUserById(client, input.user_id);
  if (!user) {
    throw new Error(`User not found: ${input.user_id}`);
  }

  // Check user is approved
  if (user.status !== 'active') {
    throw new Error('Your registration is pending admin approval');
  }

  // Get the user's approved key
  const key = await getActiveKeyForUser(client, user.id);
  if (!key) {
    throw new Error('No key registered for this user');
  }

  if (key.status !== 'approved') {
    throw new Error('Your key is pending admin approval');
  }

  const sigValid = verifySignature(key.public_key, input.nonce, input.signature);
  if (!sigValid) {
    throw new Error('Invalid signature');
  }

  const token = signToken({ sub: user.id, name: user.name });

  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  const expires_at = new Date(payload.exp * 1000);

  return { token, expires_at, user };
}

