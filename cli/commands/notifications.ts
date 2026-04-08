import { Command } from 'commander';
import { createMcpClient, callTool } from '../config.js';

const VALID_EVENTS = [
  'assigned_to_me',
  'task_completed',
  'task_blocked',
  'task_unblocked',
  'comment_added',
  'field_changed',
];

export function registerNotificationCommands(program: Command): void {
  const notifications = program
    .command('notifications')
    .alias('notif')
    .description('Manage push notification subscriptions');

  // ── ql notifications subscribe ─────────────────────────────

  notifications
    .command('subscribe')
    .description('Subscribe to push notifications')
    .option('--events <events>', `Comma-separated events: ${VALID_EVENTS.join(', ')}`, VALID_EVENTS.join(','))
    .option('--user-id <id>', 'User ID to subscribe (agents acting on behalf of a user)')
    .action(async (opts) => {
      const events = opts.events.split(',').map((e: string) => e.trim());
      for (const evt of events) {
        if (!VALID_EVENTS.includes(evt)) {
          console.error(`Invalid event: ${evt}`);
          console.error(`Valid events: ${VALID_EVENTS.join(', ')}`);
          process.exit(1);
        }
      }

      const params: Record<string, unknown> = { events };
      if (opts.userId) params.user_id = opts.userId;

      const client = await createMcpClient();
      try {
        const result = await callTool(client, 'subscribe_notifications', params) as {
          ntfy_topic: string;
          setup_instructions: string;
        };

        console.log(result.setup_instructions);
        console.log();
        console.log(`Topic: ${result.ntfy_topic}`);
      } finally {
        await client.close();
      }
    });

  // ── ql notifications list ──────────────────────────────────

  notifications
    .command('list')
    .description('List notification subscriptions')
    .option('--user-id <id>', 'User ID to list subscriptions for')
    .action(async (opts) => {
      const params: Record<string, unknown> = {};
      if (opts.userId) params.user_id = opts.userId;

      const client = await createMcpClient();
      try {
        const result = await callTool(client, 'list_notification_subscriptions', params) as {
          subscriptions: Array<{
            id: string;
            topic: string;
            events: string[];
            active: boolean;
            created_at: string;
          }>;
        };

        if (result.subscriptions.length === 0) {
          console.log('No notification subscriptions.');
          console.log('Run: ql notifications subscribe');
          return;
        }

        for (const sub of result.subscriptions) {
          const status = sub.active ? 'active' : 'paused';
          console.log(`${sub.id}  [${status}]`);
          console.log(`  Topic:  ${sub.topic}`);
          console.log(`  Events: ${sub.events.join(', ')}`);
          console.log();
        }
      } finally {
        await client.close();
      }
    });

  // ── ql notifications remove ────────────────────────────────

  notifications
    .command('remove <id>')
    .description('Remove a notification subscription')
    .action(async (id: string) => {
      const client = await createMcpClient();
      try {
        await callTool(client, 'unsubscribe_notifications', { subscription_id: id });
        console.log('Subscription removed.');
      } finally {
        await client.close();
      }
    });
}
