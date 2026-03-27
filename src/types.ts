// ── Enums / Unions ──────────────────────────────────────────────

export type EventType =
  | 'created'
  | 'note'
  | 'progress'
  | 'handoff'
  | 'claimed'
  | 'blocked'
  | 'unblocked'
  | 'field_changed'
  | 'completed'
  | 'cancelled';

export type TaskStatus = 'open' | 'done' | 'cancelled';

// ── Core Entities ───────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  public_key: string;
  created_at: Date;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  owner_id?: string;
  creator_id: string;
  parent_task_id?: string;
  priority?: number;
  due_date?: Date;
  tags: string[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface Event {
  id: string;
  task_id: string;
  event_type: EventType;
  actor_id: string;
  body?: string;
  metadata: Record<string, unknown>;
  idempotency_key: string;
  created_at: Date;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret: string;
  owner_id: string;
  active: boolean;
  created_at: Date;
}

// ── Side Effects ────────────────────────────────────────────────

export type SideEffect =
  | { type: 'webhook'; eventType: string }
  | { type: 'check_unblocks'; taskId: string }
  | { type: 'staleness_reset' };

// ── Projection ──────────────────────────────────────────────────

export interface ProjectionResult {
  taskUpdates: Record<string, unknown>;
  sideEffects: SideEffect[];
}

// ── Auth ────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;
  name: string;
  iat: number;
  exp: number;
}

export class AuthError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}
