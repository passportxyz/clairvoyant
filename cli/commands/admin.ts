import { Command } from 'commander';
import { adminCall } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUser(u: Record<string, unknown>): string {
  const id = String(u.id ?? '');
  const name = u.name ?? '(unknown)';
  const status = u.status ?? 'active';
  const admin = u.is_admin ? ' [admin]' : '';
  const keyStatus = u.key_status ? ` key:${u.key_status}` : ' key:none';
  return `${id}  ${name}  (${status}${keyStatus})${admin}`;
}

function formatWebhook(w: Record<string, unknown>): string {
  const id = String(w.id ?? '');
  const url = w.url ?? '(unknown)';
  const events = Array.isArray(w.events) ? w.events.join(', ') : '(none)';
  const active = w.active ? 'active' : 'inactive';
  const owner = w.owner_id ? String(w.owner_id) : '(none)';
  return `${id}  ${url}\n  events: ${events}  status: ${active}  owner: ${owner}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerAdminCommands(program: Command): void {
  const admin = program
    .command('admin')
    .description('Admin commands: set admins, approve users, revoke keys, manage webhooks');

  // ── ql admin set <user_id> ──────────────────────────────────────

  admin
    .command('set <user_id>')
    .description('Promote a user to admin. First call bootstraps (no auth needed).')
    .action(async (userId) => {
      const result = await adminCall('POST', '/set-admin', { user_id: userId }) as {
        user: Record<string, unknown>;
        warning?: string;
      };
      console.log(`Admin set: ${formatUser(result.user)}`);
      if (result.warning) {
        console.log(`\n  ⚠ ${result.warning}`);
      }
    });

  // ── ql admin step-down ───────────────────────────────────────────

  admin
    .command('step-down')
    .description('Revoke your own admin status (the only way to remove admin)')
    .action(async () => {
      const result = await adminCall('POST', '/revoke-self') as {
        user: Record<string, unknown>;
      };
      console.log(`Admin revoked: ${formatUser(result.user)}`);
    });

  // ── ql admin approve <user_id> ──────────────────────────────────

  admin
    .command('approve <user_id>')
    .description('Approve a pending user registration')
    .action(async (userId) => {
      const result = await adminCall('POST', '/approve', { user_id: userId }) as {
        user: Record<string, unknown>;
        key?: { id: string; status: string };
      };
      console.log(`Approved: ${formatUser(result.user)}`);
      if (result.key) {
        console.log(`  Key ${result.key.id.slice(0, 8)} → ${result.key.status}`);
      }
    });

  // ── ql admin list-pending ───────────────────────────────────────

  admin
    .command('list-pending')
    .description('List users awaiting approval')
    .action(async () => {
      const result = await adminCall('GET', '/pending') as { users: Record<string, unknown>[] };
      const users = result.users ?? [];
      if (users.length === 0) {
        console.log('No pending users.');
        return;
      }
      for (const u of users) {
        console.log(formatUser(u));
      }
    });

  // ── ql admin revoke-key <user_id> ──────────────────────────────

  admin
    .command('revoke-key <user_id>')
    .description('Revoke a user\'s key (they must register a new one)')
    .action(async (userId) => {
      await adminCall('POST', '/revoke-key', { user_id: userId });
      console.log(`Key revoked for user: ${userId.slice(0, 8)}`);
      console.log('User must register a new key and get re-approved.');
    });

  // ── ql admin delete-user <user_id> ─────────────────────────────

  admin
    .command('delete-user <user_id>')
    .description('Delete a user and their keys/webhooks')
    .action(async (userId) => {
      await adminCall('DELETE', `/users/${userId}`);
      console.log(`Deleted user: ${userId}`);
    });

  // ── ql admin add-webhook ─────────────────────────────────────────

  admin
    .command('add-webhook')
    .description('Register a new webhook')
    .requiredOption('--url <url>', 'Webhook endpoint URL')
    .requiredOption('--events <events>', 'Comma-separated event types to subscribe to')
    .action(async (opts) => {
      const events = opts.events.split(',').map((s: string) => s.trim());
      const result = await adminCall('POST', '/webhooks', { url: opts.url, events }) as {
        webhook: Record<string, unknown>;
        secret: string;
      };
      console.log(`Webhook registered: ${result.webhook.id}`);
      console.log(`  URL: ${opts.url}`);
      console.log(`  Events: ${events.join(', ')}`);
      console.log(`  Secret: ${result.secret}`);
      console.log(`\n  Save the secret — it won't be shown again.`);
    });

  // ── ql admin webhooks ──────────────────────────────────────────

  admin
    .command('webhooks')
    .description('List all registered webhooks')
    .action(async () => {
      const result = await adminCall('GET', '/webhooks') as { webhooks: Record<string, unknown>[] };
      const webhooks = result.webhooks ?? [];
      if (webhooks.length === 0) {
        console.log('No webhooks registered.');
        return;
      }
      for (const w of webhooks) {
        console.log(formatWebhook(w));
        console.log();
      }
    });

  // ── ql admin delete-webhook <webhook_id> ───────────────────────

  admin
    .command('delete-webhook <webhook_id>')
    .description('Delete a webhook')
    .action(async (webhookId) => {
      await adminCall('DELETE', `/webhooks/${webhookId}`);
      console.log(`Deleted webhook: ${webhookId}`);
    });

  // ── ql users ────────────────────────────────────────────────────

  program
    .command('users')
    .description('List all users')
    .action(async () => {
      const result = await adminCall('GET', '/users') as { users: Record<string, unknown>[] };
      const users = result.users ?? [];

      if (users.length === 0) {
        console.log('No users found.');
        return;
      }

      for (const u of users) {
        console.log(formatUser(u));
      }
    });
}
