import pg from 'pg';
import {
  getTaskById,
  getTaskByIdForUpdate,
  getUserById,
  insertEvent,
  getEventByIdempotencyKey,
  updateTask,
} from '../db/queries.js';
import { applyEvent } from '../projection.js';
import type { Event, EventType, Task, SideEffect } from '../types.js';

// ── appendEvent ──────────────────────────────────────────────────

export interface AppendEventInput {
  task_id: string;
  event_type: EventType;
  body?: string;
  metadata?: Record<string, unknown>;
  idempotency_key: string;
}

export interface AppendEventResult {
  event: Event;
  task: Task;
  sideEffects: SideEffect[];
}

export interface ClaimErrorResult {
  error: 'already_claimed';
  owner_id: string;
}

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
const FIELD_CHANGED_ALLOWED = new Set(['title', 'priority', 'due_date', 'tags']);

/**
 * Append an event to a task within a transaction.
 * Caller must have already called BEGIN on the client.
 */
export async function appendEvent(
  client: pg.PoolClient,
  actorId: string,
  input: AppendEventInput,
): Promise<AppendEventResult | ClaimErrorResult> {
  const metadata = input.metadata ?? {};

  // Idempotency check
  const existing = await getEventByIdempotencyKey(client, input.idempotency_key);
  if (existing) {
    const task = await getTaskById(client, existing.task_id);
    if (!task) throw new Error(`Idempotent event references missing task ${existing.task_id}`);
    return { event: existing, task, sideEffects: [] };
  }

  // Lock the task row to prevent concurrent modifications
  const task = await getTaskByIdForUpdate(client, input.task_id);
  if (!task) throw new Error(`Task not found: ${input.task_id}`);

  // Terminal state check: only 'note' events allowed on done/cancelled tasks
  if (TERMINAL_STATUSES.has(task.status) && input.event_type !== 'note') {
    throw new Error(
      `Task ${input.task_id} is in terminal state '${task.status}'; only 'note' events are allowed`,
    );
  }

  // Event-specific validation
  switch (input.event_type) {
    case 'handoff': {
      const toUserId = metadata.to_user_id as string | undefined;
      if (!toUserId) throw new Error("handoff event requires metadata.to_user_id");
      const targetUser = await getUserById(client, toUserId);
      if (!targetUser) throw new Error(`Handoff target user not found: ${toUserId}`);
      break;
    }

    case 'claimed': {
      if (task.owner_id) {
        return { error: 'already_claimed', owner_id: task.owner_id };
      }
      break;
    }

    case 'field_changed': {
      const field = metadata.field as string | undefined;
      if (!field || !FIELD_CHANGED_ALLOWED.has(field)) {
        throw new Error(
          `field_changed: field must be one of ${[...FIELD_CHANGED_ALLOWED].join(', ')}`,
        );
      }
      const currentValue = task[field as keyof Task];
      if (metadata.old_value !== currentValue) {
        throw new Error(
          `field_changed: old_value mismatch for '${field}' — ` +
          `expected ${JSON.stringify(currentValue)}, got ${JSON.stringify(metadata.old_value)}`,
        );
      }
      break;
    }
  }

  // Insert the event
  const event = await insertEvent(client, {
    task_id: input.task_id,
    event_type: input.event_type,
    actor_id: actorId,
    body: input.body,
    metadata,
    idempotency_key: input.idempotency_key,
  });

  // Apply projection
  const { taskUpdates, sideEffects } = applyEvent(event);

  // Update task if projection produced updates
  if (Object.keys(taskUpdates).length > 0) {
    const updated = await updateTask(client, task.id, task.version, taskUpdates);
    if (!updated) {
      throw new Error(
        `Version conflict updating task ${task.id}: expected version ${task.version}`,
      );
    }
  }

  // Re-fetch task to return updated state
  const updatedTask = await getTaskById(client, input.task_id);
  if (!updatedTask) throw new Error(`Task disappeared after update: ${input.task_id}`);

  return { event, task: updatedTask, sideEffects };
}

// ── claimTask ────────────────────────────────────────────────────

export interface ClaimTaskInput {
  task_id: string;
  idempotency_key: string;
}

export async function claimTask(
  client: pg.PoolClient,
  actorId: string,
  input: ClaimTaskInput,
): Promise<AppendEventResult | ClaimErrorResult> {
  return appendEvent(client, actorId, {
    task_id: input.task_id,
    event_type: 'claimed',
    metadata: { user_id: actorId },
    idempotency_key: input.idempotency_key,
  });
}
