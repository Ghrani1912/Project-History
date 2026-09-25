import fs from 'node:fs';
import type { Command } from 'commander';
import {
  defaultShells,
  detectInvokingShell,
  HOOK_SNIPPETS,
  installShellHooks,
  rcCandidatesFor,
  SHELL_MARKER_START,
  shellHookFiles,
  SUPPORTED_SHELLS,
  uninstallShellHooks,
  type SupportedShell,
} from '../capture/shellHook.js';
import { readDaemonRecord } from '../capture/client.js';
import { shellEnvFile } from '../util/paths.js';
import { action } from './context.js';
import { c, heading, keyValue, ok, out, printJson, warn } from './output.js';

/** Shells to act on: an explicit `--shell`, otherwise what invoked us + defaults. */
async function targetShells(explicit?: string): Promise<{ shells: SupportedShell[]; explicit: boolean }> {
  if (explicit) {
    const shell = SUPPORTED_SHELLS.find((s) => s === explicit || (explicit === 'pwsh' && s === 'powershell'));
    if (!shell) throw new Error(`unsupported shell "${explicit}" (expected bash, zsh or powershell)`);
    return { shells: [shell], explicit: true };
  }
  return { shells: await defaultShells(), explicit: false };
}

export function registerShellCommands(program: Command): void {
  const shell = program.command('shell').description('Install the command/file capture shell hook');

  shell
    .command('install')
    .description('Install the capture hook for your shell(s) — bash, zsh and PowerShell')
    .option('--shell <shell>', 'bash, zsh or powershell (defaults to detecting the invoking shell)')
    .option('--rc <file>', 'rc/profile file to modify (mainly for testing)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { shell?: string; rc?: string; json?: boolean }) => {
        const { shells, explicit } = await targetShells(options.shell);
        const results = await installShellHooks(shells, options.rc);
        if (options.json) {
          printJson(results);
          return;
        }
        for (const result of results) {
          if (result.alreadyPresent) out(`  ${c.grey('present')} ${result.shell.padEnd(11)} ${result.rcFile}`);
          else ok(`installed ${c.bold(result.shell)} hook in ${result.rcFile}`);
        }
        out('');
        if (!explicit) {
          const invoking = await detectInvokingShell();
          if (invoking) keyValue('detected shell', invoking);
        }
        heading('Activate it');
        for (const result of results) {
          if (result.shell === 'powershell') {
            out(`  ${c.grey('.')} ${result.rcFile}  ${c.grey('→  . $PROFILE   (or open a new terminal)')}`);
          } else {
            out(`  ${c.grey('.')} ${result.rcFile}  ${c.grey('→  source it (or open a new terminal)')}`);
          }
        }
      }),
    );

  shell
    .command('uninstall')
    .description('Remove the capture hook from your shell rc files')
    .option('--shell <shell>', 'bash, zsh or powershell (defaults to every supported shell)')
    .option('--rc <file>', 'rc/profile file to modify (mainly for testing)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { shell?: string; rc?: string; json?: boolean }) => {
        const { shells } = await targetShells(options.shell);
        if (options.rc) {
          // Explicit rc override: act on exactly that file.
          const { uninstallShellHook } = await import('../capture/shellHook.js');
          const rcFile = options.rc;
          const single = shells.map((s) => ({ ...uninstallShellHook(s, rcFile), shell: s }));
          if (options.json) {
            printJson(single);
            return;
          }
          for (const entry of single) {
            if (entry.removed) ok(`removed hook from ${entry.rcFile}`);
            else out(`no hook found in ${entry.rcFile}`);
          }
          return;
        }
        const all = await uninstallShellHooks(shells);
        if (options.json) {
          printJson(all);
          return;
        }
        const removed = all.filter((entry) => entry.removed);
        if (removed.length === 0) out('no shell hooks found');
        else for (const entry of removed) ok(`removed ${entry.shell} hook from ${entry.rcFile}`);
      }),
    );

  shell
    .command('print')
    .description('Print the hook snippet (for manual installation)')
    .option('--shell <shell>', 'bash, zsh or powershell', 'bash')
    .action((options: { shell: string }) => {
      const target = SUPPORTED_SHELLS.find((s) => s === options.shell) ?? 'bash';
      process.stdout.write(HOOK_SNIPPETS[target]);
    });

  shell
    .command('status')
    .description('Show which shell hooks are installed and whether the daemon is up')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { json?: boolean }) => {
        const invoking = await detectInvokingShell();
        const envFile = shellEnvFile();
        const envReady = fs.existsSync(envFile);
        const record = readDaemonRecord();
        const shells = SUPPORTED_SHELLS.map((target) => {
          const installed = shellHookFiles(target);
          return {
            shell: target,
            installed: installed.length > 0,
            files: installed,
            candidates: rcCandidatesFor(target).map((file) => ({
              path: file,
              exists: fs.existsSync(file),
              hasHook: fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(SHELL_MARKER_START),
            })),
          };
        });
        const payload = {
          invokingShell: invoking,
          shells,
          envFile,
          envReady,
          daemonRunning: Boolean(record),
        };
        if (options.json) {
          printJson(payload);
          return;
        }
        heading('Shell capture');
        keyValue('this shell', invoking ? c.bold(invoking) : c.yellow('not detected'));
        for (const entry of shells) {
          keyValue(
            entry.shell,
            entry.installed ? c.green(entry.files.join(', ')) : c.yellow('no hook installed'),
          );
        }
        keyValue('socket env', envReady ? c.green(envFile) : c.yellow('missing (start the daemon)'));
        if (invoking) {
          const active = shells.find((entry) => entry.shell === invoking);
          if (active && !active.installed) {
            warn(
              `your ${invoking} shell has no hook — commands typed there are NOT captured. Fix: brain shell install`,
            );
          }
        }
        if (!record) warn('daemon not running — commands fall back to a slower spawn-per-command path');
      }),
    );
}
