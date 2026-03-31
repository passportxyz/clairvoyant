import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  signToken,
  verifyToken,
  extractActorId,
  generateNonce,
  consumeNonce,
  verifySignature,
} from '../src/auth.js';
import { AuthError } from '../src/types.js';

// ── Helpers ────────────────────────────────────────────────────

/** Convert an ed25519 public key to SSH wire format string. */
function toSSHPublicKey(rawPubKey: Buffer): string {
  const typeTag = Buffer.from('ssh-ed25519', 'utf8');
  const typeLenBuf = Buffer.alloc(4);
  typeLenBuf.writeUInt32BE(typeTag.length, 0);
  const keyLenBuf = Buffer.alloc(4);
  keyLenBuf.writeUInt32BE(rawPubKey.length, 0);
  const blob = Buffer.concat([typeLenBuf, typeTag, keyLenBuf, rawPubKey]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

function makeEd25519Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // Extract raw public key bytes from DER/SPKI
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  // ed25519 SPKI DER: 12-byte prefix + 32-byte raw key
  const rawPub = Buffer.from(spkiDer.subarray(12));
  const sshPub = toSSHPublicKey(rawPub);
  return { publicKey, privateKey, sshPub, rawPub };
}

// Set JWT secret for tests
beforeEach(() => {
  process.env.QL_JWT_SECRET = 'test-secret';
});

// ── JWT Tests ──────────────────────────────────────────────────

describe('signToken', () => {
  it('produces a valid JWT string', () => {
    const token = signToken({ sub: 'u1', name: 'Alice' });
    expect(typeof token).toBe('string');
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
  });
});

describe('verifyToken', () => {
  it('decodes a valid token correctly', () => {
    const token = signToken({ sub: 'u1', name: 'Alice' });
    const payload = verifyToken(token);
    expect(payload.sub).toBe('u1');
    expect(payload.name).toBe('Alice');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('throws AuthError with expired_token for expired tokens', () => {
    const token = jwt.sign(
      { sub: 'u2', name: 'Bob' },
      'test-secret',
      { algorithm: 'HS256', expiresIn: '-1s' },
    );
    expect(() => verifyToken(token)).toThrow(AuthError);
    try {
      verifyToken(token);
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('expired_token');
    }
  });

  it('throws AuthError with invalid_token for garbage input', () => {
    expect(() => verifyToken('not.a.token')).toThrow(AuthError);
    try {
      verifyToken('garbage');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).code).toBe('invalid_token');
    }
  });

  it('throws when QL_JWT_SECRET is not set', () => {
    delete process.env.QL_JWT_SECRET;
    expect(() => signToken({ sub: 'u1', name: 'Alice' })).toThrow('QL_JWT_SECRET');
  });
});

describe('extractActorId', () => {
  it('returns the sub field', () => {
    const token = signToken({ sub: 'actor-42', name: 'Bot' });
    expect(extractActorId(token)).toBe('actor-42');
  });
});

// ── Nonce Tests ────────────────────────────────────────────────

describe('generateNonce', () => {
  it('returns a hex string and future expiry', () => {
    const { nonce, expiresAt } = generateNonce('user-1');
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('consumeNonce', () => {
  it('returns true for valid nonce with correct user, false for already-consumed', () => {
    const { nonce } = generateNonce('user-1');
    expect(consumeNonce(nonce, 'user-1')).toBe(true);
    expect(consumeNonce(nonce, 'user-1')).toBe(false);
  });

  it('returns false for wrong user', () => {
    const { nonce } = generateNonce('user-1');
    expect(consumeNonce(nonce, 'user-2')).toBe(false);
  });

  it('returns false for expired nonce', () => {
    const { nonce } = generateNonce('user-1');
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    expect(consumeNonce(nonce, 'user-1')).toBe(false);
    vi.useRealTimers();
  });
});

// ── SSH Signature Tests ────────────────────────────────────────

describe('verifySignature', () => {
  it('verifies a valid ed25519 signature', () => {
    const { privateKey, sshPub } = makeEd25519Keypair();
    const nonce = crypto.randomBytes(32).toString('hex');
    const sig = crypto.sign(null, Buffer.from(nonce, 'utf8'), privateKey);
    const sigB64 = sig.toString('base64');
    expect(verifySignature(sshPub, nonce, sigB64)).toBe(true);
  });

  it('returns false for wrong signature', () => {
    const { sshPub } = makeEd25519Keypair();
    const nonce = crypto.randomBytes(32).toString('hex');
    const wrongSig = crypto.randomBytes(64).toString('base64');
    expect(verifySignature(sshPub, nonce, wrongSig)).toBe(false);
  });
});
