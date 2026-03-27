import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  setupTestDb,
  teardownTestDb,
  withTransaction,
  createTestUser,
} from '../setup.js';
import {
  registerUser,
  getUser,
  authenticate,
} from '../../src/tools/users.js';

// ── Helpers ────────────────────────────────────────────────────

function generateTestKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  const typeBytes = Buffer.from('ssh-ed25519');
  const typeLenBuf = Buffer.alloc(4);
  typeLenBuf.writeUInt32BE(typeBytes.length);
  const keyLenBuf = Buffer.alloc(4);
  keyLenBuf.writeUInt32BE(rawPub.length);
  const blob = Buffer.concat([typeLenBuf, typeBytes, keyLenBuf, rawPub]);
  const sshPubKey = `ssh-ed25519 ${blob.toString('base64')}`;
  return { sshPubKey, privateKey };
}

function signNonce(nonce: string, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(nonce, 'utf8'), privateKey).toString('base64');
}

// ── Setup ──────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
});

beforeEach(() => {
  process.env.CV_JWT_SECRET = 'test-secret';
});

afterAll(async () => {
  await teardownTestDb();
});

// ── registerUser ───────────────────────────────────────────────

describe('registerUser', () => {
  it('creates a user', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey } = generateTestKeypair();
      const { user } = await registerUser(client, {
        name: 'Alice',
        public_key: sshPubKey,
      });

      expect(user.name).toBe('Alice');
      expect(user.public_key).toBe(sshPubKey);
      expect(user.id).toBeDefined();
    });
  });

  it('rejects duplicate public_key', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey } = generateTestKeypair();
      await registerUser(client, {
        name: 'First',
        public_key: sshPubKey,
      });

      await expect(
        registerUser(client, {
          name: 'Second',
          public_key: sshPubKey,
        }),
      ).rejects.toThrow('A user with this public key already exists');
    });
  });
});

// ── getUser ────────────────────────────────────────────────────

describe('getUser', () => {
  it('returns user by id', async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client, { name: 'GetMe' });

      const result = await getUser(client, user.id, { user_id: user.id });
      expect(result.user.id).toBe(user.id);
      expect(result.user.name).toBe('GetMe');
    });
  });
});

// ── authenticate ───────────────────────────────────────────────

describe('authenticate', () => {
  it('request_challenge returns nonce', async () => {
    await withTransaction(async (client) => {
      const result = await authenticate(client, {
        user_id: 'any',
        action: 'request_challenge',
      });

      expect('nonce' in result).toBe(true);
      if ('nonce' in result) {
        expect(typeof result.nonce).toBe('string');
        expect(result.expires_at.getTime()).toBeGreaterThan(Date.now());
      }
    });
  });

  it('verify with valid signature returns token', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey, privateKey } = generateTestKeypair();
      const user = await createTestUser(client, {
        name: 'AuthUser',
        public_key: sshPubKey,
      });

      // Request challenge
      const challenge = await authenticate(client, {
        user_id: user.id,
        action: 'request_challenge',
      });

      if (!('nonce' in challenge)) throw new Error('Expected nonce');

      // Sign the nonce
      const signature = signNonce(challenge.nonce, privateKey);

      // Verify
      const result = await authenticate(client, {
        user_id: user.id,
        action: 'verify',
        nonce: challenge.nonce,
        signature,
      });

      expect('token' in result).toBe(true);
      if ('token' in result) {
        expect(typeof result.token).toBe('string');
        expect(result.user.id).toBe(user.id);
        expect(result.expires_at.getTime()).toBeGreaterThan(Date.now());
      }
    });
  });

  it('verify rejects invalid signature', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey } = generateTestKeypair();
      const user = await createTestUser(client, {
        name: 'AuthUser2',
        public_key: sshPubKey,
      });

      const challenge = await authenticate(client, {
        user_id: user.id,
        action: 'request_challenge',
      });

      if (!('nonce' in challenge)) throw new Error('Expected nonce');

      // Use a different key to sign (wrong signature)
      const { privateKey: wrongKey } = generateTestKeypair();
      const badSignature = signNonce(challenge.nonce, wrongKey);

      await expect(
        authenticate(client, {
          user_id: user.id,
          action: 'verify',
          nonce: challenge.nonce,
          signature: badSignature,
        }),
      ).rejects.toThrow('Invalid signature');
    });
  });

  it('verify rejects nonce from different user', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey, privateKey } = generateTestKeypair();
      const user = await createTestUser(client, {
        name: 'AuthUser3',
        public_key: sshPubKey,
      });

      // Request challenge for user A
      const challenge = await authenticate(client, {
        user_id: 'different-user-id',
        action: 'request_challenge',
      });

      if (!('nonce' in challenge)) throw new Error('Expected nonce');

      const signature = signNonce(challenge.nonce, privateKey);

      // Try to verify as user B (nonce was bound to user A)
      await expect(
        authenticate(client, {
          user_id: user.id,
          action: 'verify',
          nonce: challenge.nonce,
          signature,
        }),
      ).rejects.toThrow('Invalid or expired nonce');
    });
  });
});
