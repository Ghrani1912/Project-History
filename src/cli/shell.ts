import fs from 'node:fs';
import type { Command } from 'commander';
import {
  detectShell,
  installShellHook,
  rcPathFor,
  SHELL_HOOK_SNIPPET,
  shellHookInstalled,
  uninstallShellHook,
  type SupportedShell,
} from '../capture/shellHook.js';
import { readDaemonRecord } from '../capture/client.js';
import { shellEnvFile } from '../util/paths.js';
import { action } from './context.js';
import { c, heading, keyValue, ok, out, printJson, warn } from './output.js';

export function registerShellCommands(program: Command): void {
  const shell = program.command('shell').description('Install the command/file capture shell hook');

  shell
    .command('install')
    .description('Append the capture hook to your shell rc file')
    .option('--shell <shell>', 'bash or zsh (defaults to $SHELL)')
    .option('--rc <file>', 'rc file to modify (defaults to ~/.bashrc or ~/.zshrc)')
    .option('--json', 'machine-readable output')
    .action(
      action((options: { shell?: string; rc?: string; json?: boolean }) => {
        const target = detectShell(options.shell) as SupportedShell;
        const result = installShellHook(target, options.rc);
        if (options.json) {
          printJson(result);
          return;
        }
        if (result.alreadyPresent) out(`hook already present in ${result.rcFile}`);
        else ok(`installed hook for ${result.shell} in ${result.rcFile}`);
        out(c.grey(`  restart your shell or run: source ${result.rcFile}`));
      }),
    );

  shell
    .command('uninstall')
    .description('Remove the capture hook from your shell rc file')
    .option('--shell <shell>', 'bash or zsh (defaults to $SHELL)')
    .option('--rc <file>', 'rc file to modify')
    .action(
      action((options: { shell?: string; rc?: string }) => {
        const target = detectShell(options.shell) as SupportedShell;
        const result = uninstallShellHook(target, options.rc);
        if (result.removed) ok(`removed hook from ${result.rcFile}`);
        else out(`no hook found in ${result.rcFile}`);
      }),
    );

  shell
    .command('print')
    .description('Print the hook snippet (for manual installation)')
    .action(() => {
      process.stdout.write(SHELL_HOOK_SNIPPET);
    });

  shell
    .command('status')
    .description('Show whether the shell hook and daemon env file are in place')
    .option('--json', 'machine-readable output')
    .action(
      action((options: { json?: boolean }) => {
        const target = detectShell() as SupportedShell;
        const rcFile = rcPathFor(target);
        const installed = shellHookInstalled(target);
        const envFile = shellEnvFile();
        const envReady = fs.existsSync(envFile);
        const record = readDaemonRecord();
        const payload = { shell: target, rcFile, installed, envFile, envReady, daemonRunning: Boolean(record) };
        if (options.json) {
          printJson(payload);
          return;
        }
        heading('Shell capture');
        keyValue('shell', target);
        keyValue('rc file', rcFile);
        keyValue('hook', installed ? c.green('installed') : c.yellow('not installed'));
        keyValue('socket env', envReady ? c.green(envFile) : c.yellow('missing (start the daemon)'));
        if (!installed) out(c.grey('  install with: brain shell install'));
        if (!record) warn('daemon not running — commands fall back to a slower spawn-per-command path');
      }),
    );
}
