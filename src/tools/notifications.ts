import pg from 'pg';
import crypto from 'node:crypto';
import {
  insertNotificationSubscription,
  getNotificationSubscriptionsByUserId,
  deleteNotificationSubscription,
  updateNotificationSubscription,
} from '../db/queries.js';
import { NOTIFICATION_EVENTS } from '../ntfy.js';
import type { NotificationSubscription } from '../types.js';

/**
 * Generate a unique, unguessable topic name.
 * 128 bits of entropy (32 hex chars) — the topic name IS the credential.
 * No separate ntfy auth needed; unguessable = secure.
 */
function generateTopic(): string {
  const random = crypto.randomBytes(16).toString('hex'); // 32 hex chars, 128 bits
  return `ql-${random}`;
}

export async function subscribeNotifications(
  client: pg.PoolClient,
  actorId: string,
  input: { events: string[]; user_id?: string },
): Promise<{ subscription: NotificationSubscription; ntfy_topic: string; setup_instructions: string }> {
  // Agents can create subscriptions on behalf of other users
  const targetUserId = input.user_id || actorId;

  // Validate events
  for (const evt of input.events) {
    if (!NOTIFICATION_EVENTS.includes(evt as any)) {
      throw new Error(`Invalid notification event: ${evt}. Valid events: ${NOTIFICATION_EVENTS.join(', ')}`);
    }
  }

  // Check if target user already has a subscription — update it instead of creating duplicate
  const existing = await getNotificationSubscriptionsByUserId(client, targetUserId);
  if (existing.length > 0) {
    const sub = await updateNotificationSubscription(client, existing[0].id, targetUserId, {
      events: input.events,
      active: true,
    });
    const ntfyUrl = process.env.NTFY_URL || 'http://ntfy:80';
    return {
      subscription: sub,
      ntfy_topic: sub.topic,
      setup_instructions: `Subscribe to notifications in the ntfy app:\n1. Open ntfy app\n2. Add subscription to: ${ntfyUrl}/${sub.topic}\n3. You'll receive push notifications for: ${input.events.join(', ')}`,
    };
  }

  const topic = generateTopic();
  const subscription = await insertNotificationSubscription(client, {
    user_id: targetUserId,
    topic,
    events: input.events,
  });

  const ntfyUrl = process.env.NTFY_URL || 'http://ntfy:80';
  return {
    subscription,
    ntfy_topic: topic,
    setup_instructions: `Subscribe to notifications in the ntfy app:\n1. Open ntfy app\n2. Add subscription to: ${ntfyUrl}/${topic}\n3. You'll receive push notifications for: ${input.events.join(', ')}`,
  };
}

export async function listNotificationSubscriptions(
  client: pg.PoolClient,
  actorId: string,
  input: { user_id?: string },
): Promise<{ subscriptions: NotificationSubscription[] }> {
  const targetUserId = input.user_id || actorId;
  const subscriptions = await getNotificationSubscriptionsByUserId(client, targetUserId);
  return { subscriptions };
}

export async function unsubscribeNotifications(
  client: pg.PoolClient,
  actorId: string,
  input: { subscription_id: string; user_id?: string },
): Promise<{ deleted: true }> {
  const targetUserId = input.user_id || actorId;
  await deleteNotificationSubscription(client, input.subscription_id, targetUserId);
  return { deleted: true };
}
