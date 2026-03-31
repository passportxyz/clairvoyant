import crypto from 'node:crypto';
import { Command } from 'commander';
import { createMcpClient, callTool, loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function idemKey(): string {
  return crypto.randomUUID();
}

function formatTask(t: Record<string, unknown>): string {
  const lines: string[] = [];
  const id = String(t.id ?? '');
  const status = String(t.status ?? 'open');
  const priority = t.priority != null ? ` P${t.priority}` : '';
  const tags = Array.isArray(t.tags) && t.tags.length > 0 ? ` [${t.tags.join(', ')}]` : '';
  const owner = t.owner_id ? ` owner:${String(t.owner_id)}` : ' unowned';

  lines.push(`${id}  ${status}${priority}${owner}${tags}`);
  lines.push(`  ${t.title}`);
  return lines.join('\n');
}

function formatTaskDetail(t: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`Task: ${t.id}`);
  lines.push(`Title: ${t.title}`);
  lines.push(`Status: ${t.status}`);
  lines.push(`Owner: ${t.owner_id ?? '(none)'}`);
  lines.push(`Creator: ${t.creator_id}`);
  if (t.parent_task_id) lines.push(`Parent: ${t.parent_task_id}`);
  if (t.priority != null) lines.push(`Priority: ${t.priority}`);
  if (t.due_date) lines.push(`Due: ${t.due_date}`);
  if (Array.isArray(t.tags) && t.tags.length > 0) lines.push(`Tags: ${t.tags.join(', ')}`);
  lines.push(`Version: ${t.version}`);
  lines.push(`Created: ${t.created_at}`);
  lines.push(`Updated: ${t.updated_at}`);

  if (Array.isArray(t.events) && t.events.length > 0) {
    lines.push('');
    lines.push('Events:');
    for (const e of t.events as Record<string, unknown>[]) {
      const ts = String(e.created_at ?? '').slice(0, 19);
      const actor = String(e.actor_id ?? '').slice(0, 8);
      const body = e.body ? `: ${e.body}` : '';
      lines.push(`  ${ts}  ${e.event_type}  by ${actor}${body}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerTaskCommands(program: Command): void {
  // ── ql add ───────────────────────────────────────────────────

  program
    .command('add <title>')
    .description('Create a new task')
    .option('--body <body>', 'Task description', '')
    .option('--owner <id>', 'Owner user ID')
    .option('--parent <id>', 'Parent task ID')
    .option('--priority <n>', 'Priority (0=highest)', parseInt)
    .option('--due <date>', 'Due date (ISO 8601)')
    .option('--tags <tags>', 'Comma-separated tags')
    .action(async (title, opts) => {
      const args: Record<string, unknown> = {
        title,
        body: opts.body || '',
        idempotency_key: idemKey(),
      };
      if (opts.owner) args.owner_id = opts.owner;
      if (opts.parent) args.parent_task_id = opts.parent;
      if (opts.priority != null) args.priority = opts.priority;
      if (opts.due) args.due_date = opts.due;
      if (opts.tags) args.tags = opts.tags.split(',').map((s: string) => s.trim());

      const client = await createMcpClient();
      try {
        const result = await callTool(client, 'create_task', args) as { task: Record<string, unknown> };
        const task = result.task;
        console.log(`Created task: ${task.id}`);
        console.log(`  Title: ${title}`);
        if (task.status) console.log(`  Status: ${task.status}`);
      } finally {
        await client.close();
      }
    });

  // ── ql list ──────────────────────────────────────────────────

  program
    .command('list')
    .description('List tasks')
    .option('--mine', 'Only tasks owned by me')
    .option('--unowned', 'Only unowned tasks')
    .option('--status <status>', 'Filter by status (open/done/cancelled)')
    .option('--tags <tags>', 'Filter by tags (comma-separated)')
    .option('--parent <id>', 'Filter by parent task')
    .option('--creator <id>', 'Filter by creator')
    .action(async (opts) => {
      const args: Record<string, unknown> = {};
      if (opts.status) args.status = opts.status;
      if (opts.tags) args.tags = opts.tags.split(',').map((s: string) => s.trim());
      if (opts.parent) args.parent_task_id = opts.parent;
      if (opts.creator) args.creator_id = opts.creator;
      if (opts.unowned) args.owner_id = null;

      if (opts.mine) {
        const config = await loadConfig();
        if (config.user_id) {
          args.owner_id = config.user_id;
        } else {
          console.error('Warning: --mine requires user_id in config. Run "ql register" first.');
        }
      }

      const client = await createMcpClient();
      try {
        const result = await callTool(client, 'list_tasks', args) as { tasks: Record<string, unknown>[]; cursor?: string };
        const tasks = result.tasks ?? [];

        if (tasks.length === 0) {
          console.log('No tasks found.');
          return;
        }

        for (const task of tasks) {
          console.log(formatTask(task));
          console.log();
        }

        if (result.cursor) {
          console.log(`(more results available, cursor: ${result.cursor})`);
        }
      } finally {
        await client.close();
      }
    });

  // ── ql show ──────────────────────────────────────────────────

  program
    .command('show <task_id>')
    .description('Show task details and event history')
    .action(async (taskId) => {
      const client = await createMcpClient();
      try {
        const result = await callTool(client, 'get_task', { task_id: taskId }) as Record<string, unknown>;
        console.log(formatTaskDetail(result));
      } finally {
        await client.close();
      }
    });

  // ── ql claim ─────────────────────────────────────────────────

  program
    .command('claim <task_id>')
    .description('Claim an unowned task')
    .action(async (taskId) => {
      const client = await createMcpClient();
      try {
        const result = await callTool(client, 'claim_task', {
          task_id: taskId,
          idempotency_key: idemKey(),
        }) as Record<string, unknown>;
        if (result.error === 'already_claimed') {
          console.error(`Task ${taskId} is already claimed by ${result.owner_id}`);
          process.exit(1);
        }
        console.log(`Claimed task: ${taskId}`);
      } finally {
        await client.close();
      }
    });

  // ── ql update <task_id> <subcommand> ─────────────────────────

  const update = program
    .command('update <task_id>')
    .description('Update a task (use a subcommand: note, progress, done, cancel, block, handoff, set)');

  // ── ql update <id> progress <message> ────────────────────────

  update
    .command('progress <message>')
    .description('Log progress on a task')
    .action(async (message, _opts, cmd) => {
      const taskId = cmd.parent!.args[0];
      const client = await createMcpClient();
      try {
        await callTool(client, 'update_task', {
          task_id: taskId,
          event_type: 'progress',
          body: message,
          idempotency_key: idemKey(),
        });
        console.log(`Progress logged on: ${taskId}`);
      } finally {
        await client.close();
      }
    });

  // ── ql update <id> note <message> ────────────────────────────

  update
    .command('note <message>')
    .description('Add a note to a task')
    .action(async (message, _opts, cmd) => {
      const taskId = cmd.parent!.args[0];
      const client = await createMcpClient();
      try {
        await callTool(client, 'update_task', {
          task_id: taskId,
          event_type: 'note',
          body: message,
          idempotency_key: idemKey(),
        });
        console.log(`Note added to: ${taskId}`);
      } finally {
        await client.close();
      }
    });

  // ── ql update <id> handoff <user_id> [message] ──────────────

  update
    .command('handoff <user_id> [message]')
    .description('Hand off a task to another user')
    .action(async (userId, message, _opts, cmd) => {
      const taskId = cmd.parent!.args[0];
      const client = await createMcpClient();
      try {
        await callTool(client, 'update_task', {
          task_id: taskId,
          event_type: 'handoff',
          body: message ?? '',
          metadata: { to_user_id: userId },
          idempotency_key: idemKey(),
        });
        console.log(`Task ${taskId} handed off to ${userId}`);
      } finally {
        await client.close();
      }
    });

  // ── ql update <id> block [reason] ────────────────────────────

  update
    .command('block [reason]')
    .description('Mark a task as blocked')
    .option('--blocked-by <id>', 'Blocking task ID')
    .action(async (reason, opts, cmd) => {
      const taskId = cmd.parent!.args[0];
      const metadata: Record<string, unknown> = {};
      if (opts.blockedBy) metadata.blocked_by_task_id = opts.blockedBy;

      const client = await createMcpClient();
      try {
        await callTool(client, 'update_task', {
          task_id: taskId,
          event_type: 'blocked',
          body: reason ?? '',
          metadata,
          idempotency_key: idemKey(),
        });
        console.log(`Task ${taskId} marked as blocked.`);
      } finally {
        await client.close();
      }
    });

  // ── ql update <id> done [message] ────────────────────────────

  update
    .command('done [message]')
    .description('Mark a task as completed')
    .action(async (message, _opts, cmd) => {
      const taskId = cmd.parent!.args[0];
      const client = await createMcpClient();
      try {
        await callTool(client, 'update_task', {
          task_id: taskId,
          event_type: 'completed',
          body: message ?? '',
          idempotency_key: idemKey(),
        });
        console.log(`Task ${taskId} completed.`);
      } finally {
        await client.close();
      }
    });

  // ── ql update <id> cancel [reason] ───────────────────────────

  update
    .command('cancel [reason]')
    .description('Cancel a task')
    .action(async (reason, _opts, cmd) => {
      const taskId = cmd.parent!.args[0];
      const client = await createMcpClient();
      try {
        await callTool(client, 'update_task', {
          task_id: taskId,
          event_type: 'cancelled',
          body: reason ?? '',
          idempotency_key: idemKey(),
        });
        console.log(`Task ${taskId} cancelled.`);
      } finally {
        await client.close();
      }
    });

  // ── ql update <id> set <field> <value> ───────────────────────

  update
    .command('set <field> <value>')
    .description('Change a task field (title, priority, due_date, tags)')
    .action(async (field, value, _opts, cmd) => {
      const taskId = cmd.parent!.args[0];

      // First get the current task to obtain old_value
      const client = await createMcpClient();
      try {
        const result = await callTool(client, 'get_task', { task_id: taskId }) as Record<string, unknown>;
        const currentValue = result[field];

        let newValue: unknown = value;
        if (field === 'priority') newValue = parseInt(value, 10);
        if (field === 'tags') newValue = value.split(',').map((s: string) => s.trim());

        await callTool(client, 'update_task', {
          task_id: taskId,
          event_type: 'field_changed',
          metadata: { field, old_value: currentValue, new_value: newValue },
          idempotency_key: idemKey(),
        });
        console.log(`Task ${taskId}: ${field} updated.`);
      } finally {
        await client.close();
      }
    });
}
