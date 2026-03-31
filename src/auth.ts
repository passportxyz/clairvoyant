import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { AuthError, type JwtPayload } from './types.js';

// ── Internal State ─────────────────────────────────────────────

// Nonces are bound to user_id to prevent cross-user replay
const nonceStore: Map<string, { expiresAt: Date; userId: string }> = new Map();

function getSecret(): string {
  const secret = process.env.QL_JWT_SECRET;
  if (!secret) {
    throw new Error('QL_JWT_SECRET environment variable is required');
  }
  return secret;
}

function getExpiryDays(): number {
  const raw = process.env.QL_TOKEN_EXPIRY_DAYS;
  return raw ? parseInt(raw, 10) : 90;
}

// ── JWT Functions ──────────────────────────────────────────────

export function signToken(payload: {
  sub: string;
  name: string;
}): string {
  const secret = getSecret();
  const expiryDays = getExpiryDays();
  return jwt.sign(
    { sub: payload.sub, name: payload.name },
    secret,
    { algorithm: 'HS256', expiresIn: `${expiryDays}d` },
  );
}

export function verifyToken(token: string): JwtPayload {
  const secret = getSecret();
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
    return decoded;
  } catch (err: unknown) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new AuthError('Token has expired', 'expired_token');
    }
    throw new AuthError('Invalid token', 'invalid_token');
  }
}

export function extractActorId(token: string): string {
  const payload = verifyToken(token);
  return payload.sub;
}

// ── Nonce Management ───────────────────────────────────────────

function cleanExpiredNonces(): void {
  const now = new Date();
  for (const [nonce, entry] of nonceStore) {
    if (entry.expiresAt <= now) {
      nonceStore.delete(nonce);
    }
  }
}

export function generateNonce(userId: string): { nonce: string; expiresAt: Date } {
  cleanExpiredNonces();
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60_000); // 60s TTL
  nonceStore.set(nonce, { expiresAt, userId });
  return { nonce, expiresAt };
}

export function consumeNonce(nonce: string, userId: string): boolean {
  cleanExpiredNonces();
  const entry = nonceStore.get(nonce);
  if (!entry) return false;
  if (entry.expiresAt <= new Date()) {
    nonceStore.delete(nonce);
    return false;
  }
  if (entry.userId !== userId) return false;
  nonceStore.delete(nonce);
  return true;
}

// ── SSH Signature Verification ─────────────────────────────────

/**
 * Parse an SSH ed25519 public key string ("ssh-ed25519 AAAA...") into
 * a raw 32-byte ed25519 public key buffer.
 */
function parseSSHEd25519PublicKey(sshKey: string): Buffer {
  const parts = sshKey.trim().split(/\s+/);
  if (parts[0] !== 'ssh-ed25519') {
    throw new Error('Not an ed25519 SSH public key');
  }
  const decoded = Buffer.from(parts[1], 'base64');
  // SSH wire format: uint32 length + "ssh-ed25519" + uint32 length + raw key bytes
  let offset = 0;
  const typeLen = decoded.readUInt32BE(offset);
  offset += 4;
  const typeStr = decoded.subarray(offset, offset + typeLen).toString('utf8');
  offset += typeLen;
  if (typeStr !== 'ssh-ed25519') {
    throw new Error('Unexpected key type in SSH blob');
  }
  const keyLen = decoded.readUInt32BE(offset);
  offset += 4;
  const rawKey = decoded.subarray(offset, offset + keyLen);
  return Buffer.from(rawKey);
}

export function verifySignature(
  publicKey: string,
  nonce: string,
  signature: string,
): boolean {
  try {
    const rawKeyBytes = parseSSHEd25519PublicKey(publicKey);
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([
        // DER prefix for ed25519 public key (from RFC 8410)
        Buffer.from('302a300506032b6570032100', 'hex'),
        rawKeyBytes,
      ]),
      format: 'der',
      type: 'spki',
    });
    const sigBuffer = Buffer.from(signature, 'base64');
    return crypto.verify(null, Buffer.from(nonce, 'utf8'), keyObject, sigBuffer);
  } catch {
    return false;
  }
}
