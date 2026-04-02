#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerTaskCommands } from './commands/tasks.js';
import { registerAdminCommands } from './commands/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('ql')
  .description('Quest Log — task management CLI')
  .version(pkg.version);

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
    const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : '';
    if (code === 'commander.helpDisplayed' || code === 'commander.help' || code === 'commander.version') {
      process.exit(0);
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
