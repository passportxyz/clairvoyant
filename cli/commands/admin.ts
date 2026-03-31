import { Command } from 'commander';
import { createMcpClient, callTool, loadConfig, quickCall } from '../config.js';

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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerAdminCommands(program: Command): void {
  const admin = program
    .command('admin')
    .description('Admin commands: set admins, approve users, revoke keys');

  // ── cv admin set <user_id> ──────────────────────────────────────

  admin
    .command('set <user_id>')
    .description('Promote a user to admin. First call bootstraps (no auth needed).')
    .action(async (userId) => {
      // set_admin supports optional auth — try with token, fall back to no-auth
      try {
        const result = await quickCall('set_admin', { user_id: userId }) as {
          user: Record<string, unknown>;
          warning?: string;
        };
        console.log(`Admin set: ${formatUser(result.user)}`);
        if (result.warning) {
          console.log(`\n  ⚠ ${result.warning}`);
        }
      } catch {
        // If auth fails, try without auth (bootstrap case)
        const result = await quickCall('set_admin', { user_id: userId }, { noAuth: true }) as {
          user: Record<string, unknown>;
          warning?: string;
        };
        console.log(`Admin set: ${formatUser(result.user)}`);
        if (result.warning) {
          console.log(`\n  ⚠ ${result.warning}`);
        }
      }
    });

  // ── cv admin approve <user_id> ──────────────────────────────────

  admin
    .command('approve <user_id>')
    .description('Approve a pending user registration')
    .action(async (userId) => {
      const result = await quickCall('approve_user', { user_id: userId }) as {
        user: Record<string, unknown>;
        key?: { id: string; status: string };
      };
      console.log(`Approved: ${formatUser(result.user)}`);
      if (result.key) {
        console.log(`  Key ${result.key.id.slice(0, 8)} → ${result.key.status}`);
      }
    });

  // ── cv admin list-pending ───────────────────────────────────────

  admin
    .command('list-pending')
    .description('List users awaiting approval')
    .action(async () => {
      const result = await quickCall('list_pending') as { users: Record<string, unknown>[] };
      const users = result.users ?? [];
      if (users.length === 0) {
        console.log('No pending users.');
        return;
      }
      for (const u of users) {
        console.log(formatUser(u));
      }
    });

  // ── cv admin revoke-key <user_id> ──────────────────────────────

  admin
    .command('revoke-key <user_id>')
    .description('Revoke a user\'s key (they must register a new one)')
    .action(async (userId) => {
      await quickCall('revoke_key', { user_id: userId });
      console.log(`Key revoked for user: ${userId.slice(0, 8)}`);
      console.log('User must register a new key and get re-approved.');
    });

  // ── cv users ────────────────────────────────────────────────────

  program
    .command('users')
    .description('List all users')
    .action(async () => {
      const result = await quickCall('list_users') as { users: Record<string, unknown>[] };
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
