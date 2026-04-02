import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { AuthError, type JwtPayload, type DeviceCode } from './types.js';

// ── Internal State ─────────────────────────────────────────────

// Nonces are bound to user_id to prevent cross-user replay
const nonceStore: Map<string, { expiresAt: Date; userId: string }> = new Map();

// Device pairing codes — short-lived, single-use
const deviceCodeStore: Map<string, DeviceCode> = new Map();

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

/** Extract the expiry date from a signed JWT without full verification. */
export function getTokenExpiry(token: string): Date {
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as JwtPayload;
  return new Date(payload.exp * 1000);
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

// ── Device Code Management ────────────────────────────────────

// Charset excludes 0/O/1/I/L to avoid ambiguity
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const DEVICE_CODE_TTL_MS = 10 * 60_000; // 10 minutes
const MAX_FAILURES = 5;
const MAX_CODES_PER_USER = 3;

function cleanExpiredDeviceCodes(): void {
  const now = new Date();
  for (const [code, entry] of deviceCodeStore) {
    if (entry.expiresAt <= now) {
      deviceCodeStore.delete(code);
    }
  }
}

function normalizeCode(code: string): string {
  return code.replace(/[-\s]/g, '').toUpperCase();
}

/** Generate a uniform random index into a charset, avoiding modulo bias. */
function uniformCharIndex(charsetLen: number): number {
  const limit = 256 - (256 % charsetLen);
  let b: number;
  do { b = crypto.randomBytes(1)[0]; } while (b >= limit);
  return b % charsetLen;
}

export function generateDeviceCode(userId: string): { code: string; expiresAt: Date } {
  cleanExpiredDeviceCodes();

  // Cap active codes per user
  let userCodeCount = 0;
  for (const entry of deviceCodeStore.values()) {
    if (entry.userId === userId) userCodeCount++;
  }
  if (userCodeCount >= MAX_CODES_PER_USER) {
    throw new Error(`Too many active device codes (max ${MAX_CODES_PER_USER}). Wait for existing codes to expire.`);
  }

  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += CODE_CHARS[uniformCharIndex(CODE_CHARS.length)];
  }

  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS);
  deviceCodeStore.set(raw, { code: raw, userId, expiresAt, failures: 0 });

  // Format as XXXX-XXXX for display
  const formatted = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return { code: formatted, expiresAt };
}

/**
 * Look up a device code without consuming it. Returns null if invalid/expired/locked out.
 * Call consumeDeviceCode after successful key registration to finalize.
 */
export function lookupDeviceCode(code: string): { userId: string } | null {
  cleanExpiredDeviceCodes();

  const normalized = normalizeCode(code);
  const entry = deviceCodeStore.get(normalized);
  if (!entry) return null;

  if (entry.failures >= MAX_FAILURES) {
    deviceCodeStore.delete(normalized);
    return null;
  }

  return { userId: entry.userId };
}

/** Consume (delete) a device code after successful claim. */
export function consumeDeviceCode(code: string): void {
  deviceCodeStore.delete(normalizeCode(code));
}

/** Record a failed claim attempt. Invalidates after MAX_FAILURES. */
export function recordDeviceCodeFailure(code: string): void {
  const normalized = normalizeCode(code);
  const entry = deviceCodeStore.get(normalized);
  if (entry) {
    entry.failures++;
    if (entry.failures >= MAX_FAILURES) {
      deviceCodeStore.delete(normalized);
    }
  }
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
