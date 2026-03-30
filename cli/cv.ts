#!/usr/bin/env node
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerTaskCommands } from './commands/tasks.js';
import { registerAdminCommands } from './commands/admin.js';

const program = new Command();

program
  .name('cv')
  .description('Clairvoyant — task management CLI')
  .version('0.1.0');

// Register all command groups
registerAuthCommands(program);
registerTaskCommands(program);
registerAdminCommands(program);

// Global error handling
program.exitOverride();

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'commander.helpDisplayed') {
      process.exit(0);
    }
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'commander.version') {
      process.exit(0);
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
