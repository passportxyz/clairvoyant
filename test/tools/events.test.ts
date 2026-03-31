import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  getTestPool,
  setupTestDb,
  teardownTestDb,
  withTransaction,
  createTestUser,
  createTestTask,
} from '../setup.js';
import { updateTask, claimTask } from '../../src/tools/events.js';
import type { UpdateTaskResult, ClaimErrorResult } from '../../src/tools/events.js';
import { insertEvent } from '../../src/db/queries.js';

// ── Helpers ────────────────────────────────────────────────────

/** Insert a 'created' event for a task (makes the event log realistic). */
async function seedCreatedEvent(
  client: pg.PoolClient,
  taskId: string,
  actorId: string,
): Promise<void> {
  await insertEvent(client, {
    task_id: taskId,
    event_type: 'created',
    actor_id: actorId,
    metadata: {},
    idempotency_key: randomUUID(),
  });
}

function isSuccess(result: UpdateTaskResult | ClaimErrorResult): result is UpdateTaskResult {
  return !('error' in result);
}

// ── Setup ──────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

// ── Tests ──────────────────────────────────────────────────────

describe('updateTask', () => {
  it("'note' updates timestamp", async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id);
      await seedCreatedEvent(client, task.id, user.id);

      const result = await updateTask(client, user.id, {
        task_id: task.id,
        event_type: 'note',
        body: 'A note',
        idempotency_key: randomUUID(),
      });

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.event.event_type).toBe('note');
      expect(result.task.updated_at.getTime()).toBeGreaterThanOrEqual(task.updated_at.getTime());
    });
  });

  it("'progress' updates timestamp", async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id);
      await seedCreatedEvent(client, task.id, user.id);

      const result = await updateTask(client, user.id, {
        task_id: task.id,
        event_type: 'progress',
        body: 'Made progress',
        idempotency_key: randomUUID(),
      });

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.event.event_type).toBe('progress');
      expect(result.task.updated_at.getTime()).toBeGreaterThanOrEqual(task.updated_at.getTime());
    });
  });

  it("'handoff' changes owner", async () => {
    await withTransaction(async (client) => {
      const user1 = await createTestUser(client, { name: 'owner-1' });
      const user2 = await createTestUser(client, { name: 'owner-2' });
      const task = await createTestTask(client, user1.id, { owner_id: user1.id });
      await seedCreatedEvent(client, task.id, user1.id);

      const result = await updateTask(client, user1.id, {
        task_id: task.id,
        event_type: 'handoff',
        metadata: { to_user_id: user2.id },
        idempotency_key: randomUUID(),
      });

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.task.owner_id).toBe(user2.id);
    });
  });

  it("'completed' sets status to done", async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id);
      await seedCreatedEvent(client, task.id, user.id);

      const result = await updateTask(client, user.id, {
        task_id: task.id,
        event_type: 'completed',
        idempotency_key: randomUUID(),
      });

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.task.status).toBe('done');
      expect(result.sideEffects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'check_unblocks' }),
        ]),
      );
    });
  });

  it("'cancelled' sets status to cancelled", async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id);
      await seedCreatedEvent(client, task.id, user.id);

      const result = await updateTask(client, user.id, {
        task_id: task.id,
        event_type: 'cancelled',
        idempotency_key: randomUUID(),
      });

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.task.status).toBe('cancelled');
    });
  });

  it('rejects events on terminal tasks (except note)', async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id, { status: 'done' });
      await seedCreatedEvent(client, task.id, user.id);

      // 'progress' should be rejected on a done task
      await expect(
        updateTask(client, user.id, {
          task_id: task.id,
          event_type: 'progress',
          idempotency_key: randomUUID(),
        }),
      ).rejects.toThrow(/terminal state/);

      // 'note' should still work
      const noteResult = await updateTask(client, user.id, {
        task_id: task.id,
        event_type: 'note',
        body: 'Post-mortem note',
        idempotency_key: randomUUID(),
      });
      expect(isSuccess(noteResult)).toBe(true);
    });
  });

  it("'claimed' fails if task already owned", async () => {
    await withTransaction(async (client) => {
      const owner = await createTestUser(client, { name: 'existing-owner' });
      const claimer = await createTestUser(client, { name: 'claimer' });
      const task = await createTestTask(client, owner.id, { owner_id: owner.id });
      await seedCreatedEvent(client, task.id, owner.id);

      const result = await updateTask(client, claimer.id, {
        task_id: task.id,
        event_type: 'claimed',
        metadata: { user_id: claimer.id },
        idempotency_key: randomUUID(),
      });

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('already_claimed');
      expect(result.owner_id).toBe(owner.id);
    });
  });

  it("'field_changed' updates the specified field", async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id, { priority: 3 });
      await seedCreatedEvent(client, task.id, user.id);

      const result = await updateTask(client, user.id, {
        task_id: task.id,
        event_type: 'field_changed',
        metadata: { field: 'priority', old_value: 3, new_value: 5 },
        idempotency_key: randomUUID(),
      });

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.task.priority).toBe(5);
    });
  });

  it("'field_changed' rejects if old_value doesn't match", async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id, { priority: 3 });
      await seedCreatedEvent(client, task.id, user.id);

      await expect(
        updateTask(client, user.id, {
          task_id: task.id,
          event_type: 'field_changed',
          metadata: { field: 'priority', old_value: 999, new_value: 5 },
          idempotency_key: randomUUID(),
        }),
      ).rejects.toThrow(/old_value mismatch/);
    });
  });

  it('idempotency: same key returns same result', async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id);
      await seedCreatedEvent(client, task.id, user.id);

      const key = randomUUID();
      const result1 = await updateTask(client, user.id, {
        task_id: task.id,
        event_type: 'note',
        body: 'Idempotent note',
        idempotency_key: key,
      });

      const result2 = await updateTask(client, user.id, {
        task_id: task.id,
        event_type: 'note',
        body: 'Idempotent note',
        idempotency_key: key,
      });

      expect(isSuccess(result1)).toBe(true);
      expect(isSuccess(result2)).toBe(true);
      if (!isSuccess(result1) || !isSuccess(result2)) return;
      expect(result1.event.id).toBe(result2.event.id);
      // Idempotent replay produces no side effects
      expect(result2.sideEffects).toEqual([]);
    });
  });

  it('version conflict detection', async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id);
      await seedCreatedEvent(client, task.id, user.id);

      // Simulate a concurrent version bump by directly updating the version
      await client.query('UPDATE tasks SET version = version + 1 WHERE id = $1', [task.id]);

      // Now updateTask should fail because the task version has changed
      await expect(
        updateTask(client, user.id, {
          task_id: task.id,
          event_type: 'completed',
          idempotency_key: randomUUID(),
        }),
      ).rejects.toThrow(/Version conflict/);
    });
  });
});

describe('claimTask', () => {
  it('claims an unowned task', async () => {
    await withTransaction(async (client) => {
      const user = await createTestUser(client);
      const task = await createTestTask(client, user.id);
      await seedCreatedEvent(client, task.id, user.id);

      const result = await claimTask(client, user.id, {
        task_id: task.id,
        idempotency_key: randomUUID(),
      });

      expect(isSuccess(result)).toBe(true);
      if (!isSuccess(result)) return;
      expect(result.task.owner_id).toBe(user.id);
      expect(result.event.event_type).toBe('claimed');
    });
  });

  it('returns error for already-claimed task', async () => {
    await withTransaction(async (client) => {
      const owner = await createTestUser(client, { name: 'task-owner' });
      const claimer = await createTestUser(client, { name: 'late-claimer' });
      const task = await createTestTask(client, owner.id, { owner_id: owner.id });
      await seedCreatedEvent(client, task.id, owner.id);

      const result = await claimTask(client, claimer.id, {
        task_id: task.id,
        idempotency_key: randomUUID(),
      });

      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.error).toBe('already_claimed');
      expect(result.owner_id).toBe(owner.id);
    });
  });
});
