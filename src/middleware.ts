import type { Request, Response } from 'express';
import { verifyToken } from './auth.js';

// ---------------------------------------------------------------------------
// Shared auth middleware for REST routes
// ---------------------------------------------------------------------------

export interface AuthedRequest extends Request {
  actorId: string;
}

export function getActorId(req: Request): string {
  return (req as unknown as AuthedRequest).actorId;
}

export function requireAuth(req: Request, res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const payload = verifyToken(authHeader.slice(7));
    (req as unknown as AuthedRequest).actorId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function optionalAuth(req: Request, _res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(authHeader.slice(7));
      (req as unknown as AuthedRequest).actorId = payload.sub;
    } catch {
      // Ignore invalid token — bootstrap may not have one
    }
  }
  next();
}
