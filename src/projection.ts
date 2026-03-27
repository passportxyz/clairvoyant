import type { Event, ProjectionResult, SideEffect } from './types.js';

/**
 * Pure projection function: given an event, returns the task field updates
 * and side effects to apply. No DB calls — just logic.
 */
export function applyEvent(event: Event): ProjectionResult {
  const webhook: SideEffect = { type: 'webhook', eventType: event.event_type };

  switch (event.event_type) {
    case 'created': {
      const sideEffects: SideEffect[] = [webhook];
      if (event.metadata.owner_id) {
        sideEffects.push({ type: 'staleness_reset' });
      }
      return { taskUpdates: {}, sideEffects };
    }

    case 'note':
    case 'progress':
      return {
        taskUpdates: { updated_at: event.created_at },
        sideEffects: [webhook],
      };

    case 'handoff':
      return {
        taskUpdates: {
          owner_id: event.metadata.to_user_id,
          updated_at: event.created_at,
        },
        sideEffects: [webhook, { type: 'staleness_reset' }],
      };

    case 'claimed':
      return {
        taskUpdates: {
          owner_id: event.metadata.user_id,
          updated_at: event.created_at,
        },
        sideEffects: [webhook, { type: 'staleness_reset' }],
      };

    case 'blocked':
    case 'unblocked':
      return {
        taskUpdates: { updated_at: event.created_at },
        sideEffects: [webhook],
      };

    case 'field_changed': {
      const field = event.metadata.field as string;
      return {
        taskUpdates: {
          [field]: event.metadata.new_value,
          updated_at: event.created_at,
        },
        sideEffects: [webhook],
      };
    }

    case 'completed':
      return {
        taskUpdates: { status: 'done', updated_at: event.created_at },
        sideEffects: [webhook, { type: 'check_unblocks', taskId: event.task_id }],
      };

    case 'cancelled':
      return {
        taskUpdates: { status: 'cancelled', updated_at: event.created_at },
        sideEffects: [webhook, { type: 'check_unblocks', taskId: event.task_id }],
      };
  }
}
