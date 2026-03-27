import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, withTransaction, createTestUser, createTestTask } from '../setup.js';
import { createTask, getTask } from '../../src/tools/tasks.js';
import { listTasks } from '../../src/db/queries.js';
import { randomUUID } from 'node:crypto';
import type { Task } from '../../src/types.js';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

describe('createTask', () => {
  it('creates a task and initial event', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const result = await createTask(client, user.id, {
      title: 'Test task',
      body: 'Description here',
      idempotency_key: randomUUID(),
    });

    expect(result.task.title).toBe('Test task');
    expect(result.task.status).toBe('open');
    expect(result.task.creator_id).toBe(user.id);
    expect(result.task.tags).toEqual([]);
    expect(result.event.event_type).toBe('created');
    expect(result.event.body).toBe('Description here');
    expect(result.event.actor_id).toBe(user.id);
  }));

  it('creates a task with owner_id', () => withTransaction(async (client) => {
    const creator = await createTestUser(client);
    const owner = await createTestUser(client);
    const result = await createTask(client, creator.id, {
      title: 'Owned task',
      body: 'Has an owner',
      owner_id: owner.id,
      idempotency_key: randomUUID(),
    });

    expect(result.task.owner_id).toBe(owner.id);
    expect(result.event.metadata).toMatchObject({ owner_id: owner.id });
  }));

  it('creates a task with parent_task_id', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const parent = await createTestTask(client, user.id, { title: 'Parent' });
    const result = await createTask(client, user.id, {
      title: 'Child task',
      body: 'Sub-task',
      parent_task_id: parent.id,
      idempotency_key: randomUUID(),
    });

    expect(result.task.parent_task_id).toBe(parent.id);
  }));

  it('returns same result for duplicate idempotency key', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const key = randomUUID();
    const first = await createTask(client, user.id, {
      title: 'Idempotent task',
      body: 'First call',
      idempotency_key: key,
    });
    const second = await createTask(client, user.id, {
      title: 'Different title',
      body: 'Second call',
      idempotency_key: key,
    });

    expect(second.task.id).toBe(first.task.id);
    expect(second.event.id).toBe(first.event.id);
    expect(second.task.title).toBe('Idempotent task');
  }));

  it('throws if owner_id does not exist', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    await expect(createTask(client, user.id, {
      title: 'Bad owner',
      body: 'Owner missing',
      owner_id: '00000000-0000-0000-0000-000000000000',
      idempotency_key: randomUUID(),
    })).rejects.toThrow('Owner not found');
  }));

  it('throws if parent_task_id does not exist', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    await expect(createTask(client, user.id, {
      title: 'Bad parent',
      body: 'Parent missing',
      parent_task_id: '00000000-0000-0000-0000-000000000000',
      idempotency_key: randomUUID(),
    })).rejects.toThrow('Parent task not found');
  }));

  it('stores priority, due_date, and tags in event metadata', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const due = new Date('2026-04-01T00:00:00Z');
    const result = await createTask(client, user.id, {
      title: 'Full metadata task',
      body: 'All fields',
      priority: 3,
      due_date: due,
      tags: ['urgent', 'backend'],
      idempotency_key: randomUUID(),
    });

    expect(result.task.priority).toBe(3);
    expect(result.task.tags).toEqual(['urgent', 'backend']);
    expect(result.event.metadata).toMatchObject({
      priority: 3,
      tags: ['urgent', 'backend'],
    });
  }));
});

describe('listTasks', () => {
  it('returns all open tasks', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    await createTask(client, user.id, { title: 'Task A', body: 'a', idempotency_key: randomUUID() });
    await createTask(client, user.id, { title: 'Task B', body: 'b', idempotency_key: randomUUID() });

    const result = await listTasks(client, {});
    expect(result.tasks.length).toBeGreaterThanOrEqual(2);
    expect(result.tasks.every((t: Task) => t.status === 'open')).toBe(true);
  }));

  it('filters by status', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    await createTestTask(client, user.id, { status: 'open' });
    await createTestTask(client, user.id, { status: 'done' });

    const openResult = await listTasks(client, { status: 'open' });
    expect(openResult.tasks.every((t: Task) => t.status === 'open')).toBe(true);

    const doneResult = await listTasks(client, { status: 'done' });
    expect(doneResult.tasks.every((t: Task) => t.status === 'done')).toBe(true);
  }));

  it('filters by owner_id', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const owner = await createTestUser(client);
    await createTestTask(client, user.id, { owner_id: owner.id });
    await createTestTask(client, user.id); // no owner

    const result = await listTasks(client, { owner_id: owner.id });
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    expect(result.tasks.every((t: Task) => t.owner_id === owner.id)).toBe(true);
  }));

  it('filters by owner_id=null to return unowned tasks', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const owner = await createTestUser(client);
    await createTestTask(client, user.id, { owner_id: owner.id });
    await createTestTask(client, user.id); // no owner

    const result = await listTasks(client, { owner_id: null });
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    expect(result.tasks.every((t: Task) => t.owner_id === null || t.owner_id === undefined)).toBe(true);
  }));

  it('filters by tags', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    await createTestTask(client, user.id, { tags: ['backend', 'urgent'] });
    await createTestTask(client, user.id, { tags: ['frontend'] });

    const result = await listTasks(client, { tags: ['backend'] });
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    expect(result.tasks.every((t: Task) => t.tags.includes('backend'))).toBe(true);
  }));

  it('filters by creator_id', () => withTransaction(async (client) => {
    const userA = await createTestUser(client);
    const userB = await createTestUser(client);
    await createTestTask(client, userA.id);
    await createTestTask(client, userB.id);

    const result = await listTasks(client, { creator_id: userA.id });
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
    expect(result.tasks.every((t: Task) => t.creator_id === userA.id)).toBe(true);
  }));
});

describe('getTask', () => {
  it('returns task with events', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const created = await createTask(client, user.id, {
      title: 'Get me',
      body: 'Task body',
      idempotency_key: randomUUID(),
    });

    const result = await getTask(client, user.id, { task_id: created.task.id });
    expect(result.task.id).toBe(created.task.id);
    expect(result.task.title).toBe('Get me');
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.events[0].event_type).toBe('created');
  }));

  it('throws for non-existent task', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    await expect(
      getTask(client, user.id, { task_id: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toThrow('Task not found');
  }));
});
