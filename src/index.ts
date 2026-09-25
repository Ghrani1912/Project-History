#!/usr/bin/env node
import { Command } from 'commander';
import { registerProjectCommands } from './cli/projects.js';
import { registerMemoryCommands } from './cli/memory.js';
import { registerRecallCommands } from './cli/recall.js';
import { registerInsightCommands } from './cli/insight.js';
import { registerDaemonCommands } from './cli/daemon.js';
import { registerShellCommands } from './cli/shell.js';
import { registerMaintenanceCommands } from './cli/maintenance.js';
import { registerUiCommands } from './cli/ui.js';

export const VERSION = '0.3.0';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('brain')
    .description('Second Brain OS — local-first capture and recall for your projects')
    .version(VERSION)
    .enablePositionalOptions()
    .showSuggestionAfterError();

  registerProjectCommands(program);
  registerMemoryCommands(program);
  registerRecallCommands(program);
  registerInsightCommands(program);
  registerDaemonCommands(program);
  registerShellCommands(program);
  registerMaintenanceCommands(program);
  registerUiCommands(program);

  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
  });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
