import pg from 'pg';
import {
  insertTask,
  getTaskById,
  listTasks as listTasksQuery,
  insertEvent,
  getEventsByTaskId,
  getEventByIdempotencyKey,
  getUserById,
  getAttachmentsByTaskId,
} from '../db/queries.js';
import { applyEvent } from '../projection.js';
import type { Task, Event, Attachment, SideEffect } from '../types.js';

// ── createTask ────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  body: string;
  owner_id?: string;
  parent_task_id?: string;
  priority?: number;
  due_date?: Date;
  tags?: string[];
  idempotency_key: string;
}

/**
 * Create a new task within a transaction.
 * Caller must have already called BEGIN on the client.
 */
export async function createTask(
  client: pg.PoolClient,
  actorId: string,
  input: CreateTaskInput,
): Promise<{ task: Task; event: Event; sideEffects: SideEffect[] }> {
  // Idempotency check
  const existing = await getEventByIdempotencyKey(client, input.idempotency_key);
  if (existing) {
    const task = await getTaskById(client, existing.task_id);
    if (!task) throw new Error(`Idempotent event references missing task ${existing.task_id}`);
    return { task, event: existing, sideEffects: [] };
  }

  // Validate owner_id if provided
  if (input.owner_id) {
    const owner = await getUserById(client, input.owner_id);
    if (!owner) throw new Error(`Owner not found: ${input.owner_id}`);
  }

  // Validate parent_task_id if provided
  if (input.parent_task_id) {
    const parent = await getTaskById(client, input.parent_task_id);
    if (!parent) throw new Error(`Parent task not found: ${input.parent_task_id}`);
  }

  // Insert the task
  const task = await insertTask(client, {
    title: input.title,
    status: 'open',
    owner_id: input.owner_id,
    creator_id: actorId,
    parent_task_id: input.parent_task_id,
    priority: input.priority,
    due_date: input.due_date,
    tags: input.tags ?? [],
  });

  // Build event metadata
  const metadata: Record<string, unknown> = {};
  if (input.priority !== undefined) metadata.priority = input.priority;
  if (input.due_date !== undefined) metadata.due_date = input.due_date;
  if (input.tags !== undefined) metadata.tags = input.tags;
  if (input.owner_id !== undefined) metadata.owner_id = input.owner_id;

  // Insert the created event
  const event = await insertEvent(client, {
    task_id: task.id,
    event_type: 'created',
    actor_id: actorId,
    body: input.body,
    metadata,
    idempotency_key: input.idempotency_key,
  });

  // Apply projection for side effects (webhooks, staleness reset)
  const { sideEffects } = applyEvent(event);

  return { task, event, sideEffects };
}

// ── getTask ───────────────────────────────────────────────────────

export async function getTask(
  client: pg.PoolClient,
  _actorId: string,
  input: { task_id: string },
): Promise<{ task: Task; events: Event[]; attachments: Attachment[] }> {
  const task = await getTaskById(client, input.task_id);
  if (!task) throw new Error(`Task not found: ${input.task_id}`);

  const events = await getEventsByTaskId(client, input.task_id);
  const attachments = await getAttachmentsByTaskId(client, input.task_id);
  return { task, events, attachments };
}
