import pg from 'pg';
import type { Task } from './types.js';

const alertedTaskIds = new Set<string>();

/**
 * Check for stale unowned tasks and fire webhook notifications.
 * A task is "stale" if it's open, unowned, and older than the staleness interval.
 */
export async function checkStaleTasks(pool: pg.Pool): Promise<Task[]> {
  const intervalMs = parseInt(
    process.env.QL_STALENESS_INTERVAL_MS ?? '3600000',
    10,
  );
  const threshold = new Date(Date.now() - intervalMs);

  const client = await pool.connect();
  try {
    const { rows } = await client.query<Task>(
      `SELECT * FROM tasks
       WHERE status = 'open'
         AND owner_id IS NULL
         AND created_at < $1
       ORDER BY created_at ASC`,
      [threshold],
    );

    const newlyStale: Task[] = [];
    for (const task of rows) {
      if (!alertedTaskIds.has(task.id)) {
        alertedTaskIds.add(task.id);
        newlyStale.push(task);
      }
    }

    return newlyStale;
  } finally {
    client.release();
  }
}

/**
 * Remove a task from the alerted set (e.g., when it gets an owner).
 */
export function clearStaleAlert(taskId: string): void {
  alertedTaskIds.delete(taskId);
}

/**
 * Reset all alerts (for testing).
 */
export function resetAlerts(): void {
  alertedTaskIds.clear();
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic staleness checker.
 * Runs every 60 seconds.
 */
export function startStalenessChecker(
  pool: pg.Pool,
  onStale?: (tasks: Task[]) => void,
): void {
  if (intervalHandle) return; // already running

  intervalHandle = setInterval(async () => {
    try {
      const staleTasks = await checkStaleTasks(pool);
      if (staleTasks.length > 0 && onStale) {
        onStale(staleTasks);
      }
    } catch (err) {
      console.error('Staleness check error:', err);
    }
  }, 60_000);

  // Don't keep process alive just for staleness checks
  intervalHandle.unref();
}

/**
 * Stop the staleness checker.
 */
export function stopStalenessChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
