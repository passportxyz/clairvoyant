import crypto from 'node:crypto';
import pg from 'pg';
import { getActiveWebhooksByEventType } from './db/queries.js';
import type { Event, Task, SideEffect } from './types.js';

/**
 * Process side effects from a projection result.
 * Dispatches webhooks asynchronously (fire-and-forget).
 */
export async function processSideEffects(
  pool: pg.Pool,
  sideEffects: SideEffect[],
  event: Event,
  task: Task,
): Promise<void> {
  for (const effect of sideEffects) {
    if (effect.type === 'webhook') {
      // Fire-and-forget — don't await, just catch errors
      dispatchWebhooks(pool, effect.eventType, event, task).catch((err) => {
        console.error(`Webhook dispatch error for ${effect.eventType}:`, err);
      });
    }
    // check_unblocks and staleness_reset are handled elsewhere
  }
}

/**
 * Dispatch webhooks for a given event type.
 * Queries active webhooks, POSTs to each with HMAC signature.
 */
async function dispatchWebhooks(
  pool: pg.Pool,
  eventType: string,
  event: Event,
  task: Task,
): Promise<void> {
  const client = await pool.connect();
  try {
    const webhooks = await getActiveWebhooksByEventType(client, eventType);

    const body = JSON.stringify({ event, task });

    const promises = webhooks.map(async (webhook) => {
      try {
        const signature = crypto
          .createHmac('sha256', webhook.secret)
          .update(body)
          .digest('hex');

        await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-QL-Signature': signature,
          },
          body,
          signal: AbortSignal.timeout(10_000), // 10s timeout
        });
      } catch (err) {
        console.error(`Failed to deliver webhook to ${webhook.url}:`, err);
      }
    });

    await Promise.allSettled(promises);
  } finally {
    client.release();
  }
}
