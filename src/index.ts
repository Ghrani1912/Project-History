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
import { registerErrorCommands } from './cli/errors.js';
import { registerContradictionCommands } from './cli/contradictions.js';
import { registerDogfoodCommands } from './cli/dogfood.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { recordSelfInvocation, selfLogEnabled, shouldSelfLog } from './core/selflog.js';

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
  registerErrorCommands(program);
  registerContradictionCommands(program);
  registerDogfoodCommands(program);

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
  const args = process.argv.slice(2);
  try {
    await program.parseAsync(process.argv);
  } finally {
    logOwnInvocation(args);
  }
}

/**
 * Dogfooding: write this invocation into the record the tool just read from.
 * Best-effort by design — a logging failure must never change the user's exit
 * status or hide the result of the command they actually ran.
 */
function logOwnInvocation(args: string[]): void {
  try {
    const config = loadConfig();
    if (!selfLogEnabled(config) || !shouldSelfLog(args)) return;
    const db = openDatabase();
    try {
      recordSelfInvocation(db, { args, exitCode: Number(process.exitCode ?? 0) || 0 });
    } finally {
      db.close();
    }
  } catch {
    // Never let self-logging break a command.
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
