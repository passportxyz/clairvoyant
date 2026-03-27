import { describe, it, expect } from 'vitest';
import { applyEvent } from '../src/projection.js';
import type { Event } from '../src/types.js';

// ── Helpers ────────────────────────────────────────────────────

function makeEvent(overrides: Partial<Event> & { event_type: Event['event_type'] }): Event {
  return {
    id: 'evt-1',
    task_id: 'task-1',
    actor_id: 'user-1',
    body: undefined,
    metadata: {},
    idempotency_key: 'idem-1',
    created_at: new Date('2026-03-27T12:00:00Z'),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe('applyEvent', () => {
  describe('created', () => {
    it('returns empty taskUpdates and a webhook side effect', () => {
      const event = makeEvent({ event_type: 'created' });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({});
      expect(result.sideEffects).toEqual([{ type: 'webhook', eventType: 'created' }]);
    });

    it('adds staleness_reset when metadata.owner_id exists', () => {
      const event = makeEvent({
        event_type: 'created',
        metadata: { owner_id: 'user-2' },
      });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({});
      expect(result.sideEffects).toEqual([
        { type: 'webhook', eventType: 'created' },
        { type: 'staleness_reset' },
      ]);
    });
  });

  describe('note', () => {
    it('sets updated_at and produces webhook', () => {
      const event = makeEvent({ event_type: 'note', body: 'some note' });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({ updated_at: event.created_at });
      expect(result.sideEffects).toEqual([{ type: 'webhook', eventType: 'note' }]);
    });
  });

  describe('progress', () => {
    it('sets updated_at and produces webhook', () => {
      const event = makeEvent({ event_type: 'progress' });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({ updated_at: event.created_at });
      expect(result.sideEffects).toEqual([{ type: 'webhook', eventType: 'progress' }]);
    });
  });

  describe('handoff', () => {
    it('sets owner_id from metadata.to_user_id and produces staleness_reset', () => {
      const event = makeEvent({
        event_type: 'handoff',
        metadata: { to_user_id: 'user-3' },
      });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({
        owner_id: 'user-3',
        updated_at: event.created_at,
      });
      expect(result.sideEffects).toEqual([
        { type: 'webhook', eventType: 'handoff' },
        { type: 'staleness_reset' },
      ]);
    });
  });

  describe('claimed', () => {
    it('sets owner_id from metadata.user_id and produces staleness_reset', () => {
      const event = makeEvent({
        event_type: 'claimed',
        metadata: { user_id: 'user-4' },
      });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({
        owner_id: 'user-4',
        updated_at: event.created_at,
      });
      expect(result.sideEffects).toEqual([
        { type: 'webhook', eventType: 'claimed' },
        { type: 'staleness_reset' },
      ]);
    });
  });

  describe('blocked', () => {
    it('sets updated_at and produces webhook', () => {
      const event = makeEvent({ event_type: 'blocked' });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({ updated_at: event.created_at });
      expect(result.sideEffects).toEqual([{ type: 'webhook', eventType: 'blocked' }]);
    });
  });

  describe('unblocked', () => {
    it('sets updated_at and produces webhook', () => {
      const event = makeEvent({ event_type: 'unblocked' });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({ updated_at: event.created_at });
      expect(result.sideEffects).toEqual([{ type: 'webhook', eventType: 'unblocked' }]);
    });
  });

  describe('field_changed', () => {
    it('dynamically uses metadata.field as the update key', () => {
      const event = makeEvent({
        event_type: 'field_changed',
        metadata: { field: 'priority', new_value: 5 },
      });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({
        priority: 5,
        updated_at: event.created_at,
      });
      expect(result.sideEffects).toEqual([{ type: 'webhook', eventType: 'field_changed' }]);
    });

    it('works with string field values', () => {
      const event = makeEvent({
        event_type: 'field_changed',
        metadata: { field: 'title', new_value: 'New title' },
      });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({
        title: 'New title',
        updated_at: event.created_at,
      });
    });
  });

  describe('completed', () => {
    it('sets status to done and produces check_unblocks', () => {
      const event = makeEvent({ event_type: 'completed' });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({
        status: 'done',
        updated_at: event.created_at,
      });
      expect(result.sideEffects).toEqual([
        { type: 'webhook', eventType: 'completed' },
        { type: 'check_unblocks', taskId: 'task-1' },
      ]);
    });
  });

  describe('cancelled', () => {
    it('sets status to cancelled and produces check_unblocks', () => {
      const event = makeEvent({ event_type: 'cancelled' });
      const result = applyEvent(event);

      expect(result.taskUpdates).toEqual({
        status: 'cancelled',
        updated_at: event.created_at,
      });
      expect(result.sideEffects).toEqual([
        { type: 'webhook', eventType: 'cancelled' },
        { type: 'check_unblocks', taskId: 'task-1' },
      ]);
    });
  });

  describe('side effect guarantees', () => {
    it('every event type produces at least a webhook side effect', () => {
      const eventTypes = [
        'created', 'note', 'progress', 'handoff', 'claimed',
        'blocked', 'unblocked', 'field_changed', 'completed', 'cancelled',
      ] as const;

      for (const eventType of eventTypes) {
        const metadata: Record<string, unknown> = {};
        if (eventType === 'handoff') metadata.to_user_id = 'u';
        if (eventType === 'claimed') metadata.user_id = 'u';
        if (eventType === 'field_changed') {
          metadata.field = 'title';
          metadata.new_value = 'x';
        }

        const event = makeEvent({ event_type: eventType, metadata });
        const result = applyEvent(event);

        expect(
          result.sideEffects.some((e) => e.type === 'webhook'),
          `${eventType} should produce a webhook side effect`,
        ).toBe(true);
      }
    });
  });
});
