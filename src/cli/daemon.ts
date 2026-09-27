import fs from 'node:fs';
import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { listProjects } from '../core/projects.js';
import { CaptureServer } from '../capture/server.js';
import { connect, pingDaemon, readDaemonRecord, request, startDaemonDetached } from '../capture/client.js';
import { parseLine } from '../capture/protocol.js';
import { ProjectWatcher } from '../capture/watcher.js';
import {
  indexProjectCommits,
  makeIndexer,
  recordCommand,
  recordFileTouch,
  recordRepoCommits,
} from '../capture/ingest.js';
import { splitLine } from '../capture/shellHook.js';
import {
  agree,
  daemonSituation,
  describeDaemons,
  strayWarning,
  stopDaemonsForHome,
  stopLeftoverDaemons,
} from '../capture/daemonGuard.js';
import { logPath } from '../util/paths.js';
import { action, createContext, getEmbedder } from './context.js';
import { c, heading, keyValue, ok, out, printJson, warn } from './output.js';

async function waitForDaemonOrThrow(timeoutMs = 6000): Promise<{ port: number; pid: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const record = readDaemonRecord();
    if (record && (await pingDaemon(record))) return { port: record.port, pid: record.pid };
  }
  throw new Error(`daemon did not come up in ${timeoutMs}ms — check ${logPath()}`);
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program.command('daemon').description('Manage the background capture daemon');

  daemon
    .command('start')
    .description('Start the capture daemon (detached unless --foreground)')
    .option('-f, --foreground', 'run in the foreground')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { foreground?: boolean; json?: boolean }) => {
        const config = loadConfig();
        // Adopting a daemon that is already serving this home is the point of the
        // guard: it is doing the job, and a second one would watch the same folders
        // twice while taking over the record the first one is reachable through.
        const situation = await daemonSituation(config);
        if (situation.recorded) {
          const active = situation.recorded;
          if (options.json) {
            printJson({
              alreadyRunning: true,
              port: active.port,
              pid: active.pid,
              extras: situation.unreachable.map((daemon) => daemon.pid),
              unattributed: situation.unattributed.map((daemon) => daemon.pid),
            });
            return;
          }
          ok(`daemon already running (pid ${active.pid}, port ${active.port})`);
          if (situation.unreachable.length > 0) {
            warn(strayWarning(situation.unreachable, 'stop'));
          }
          if (situation.unattributed.length > 0) {
            warn(`also answering: ${describeDaemons(situation.unattributed)} — see brain daemon status`);
          }
          return;
        }
        // A daemon serving this home that the record does not describe cannot be
        // adopted: its token is not in `daemon.json`, so the shell hook has
        // nothing to authenticate with and capture would stay broken while it
        // runs. Replacing it is what "start" is for.
        if (situation.unreachable.length > 0) {
          warn(
            `${describeDaemons(situation.unreachable)} ${agree(situation.unreachable, 'is serving', 'are serving')} this home, but daemon.json does not describe ${agree(situation.unreachable, 'it', 'them')} — the shell hooks have no token for ${agree(situation.unreachable, 'it', 'them')}, so ${agree(situation.unreachable, 'it is', 'they are')} being replaced`,
          );
          await stopDaemonsForHome(config);
        }
        if (situation.unattributed.length > 0) {
          warn(`daemon(s) answering without reporting this home: ${describeDaemons(situation.unattributed)}`);
        }
        if (options.foreground) {
          const server = new CaptureServer({ config });
          const port = await server.start();
          const leftovers = await stopLeftoverDaemons(config, process.pid);
          out(`daemon listening on 127.0.0.1:${port} ${c.grey(`(ctrl-c to stop, log: ${logPath()})`)}`);
          if (leftovers.length > 0) {
            out(c.grey(`  stopped ${leftovers.length} leftover ${leftovers.length === 1 ? 'daemon' : 'daemons'} that were serving the same home`));
          }
          const shutdown = async (): Promise<void> => {
            await server.stop();
            process.exit(0);
          };
          process.on('SIGINT', () => void shutdown());
          process.on('SIGTERM', () => void shutdown());
          return;
        }
        startDaemonDetached();
        const { port, pid } = await waitForDaemonOrThrow();
        // Whoever was already watching this home without a record is a leftover
        // now that this daemon owns it.
        const leftovers = await stopLeftoverDaemons(config, pid);
        if (options.json) {
          printJson({ started: true, port, pid, stoppedLeftovers: leftovers });
          return;
        }
        ok(`daemon started (pid ${pid}, port ${port})`);
        if (leftovers.length > 0) {
          out(c.grey(`  stopped ${leftovers.length} leftover ${leftovers.length === 1 ? 'daemon' : 'daemons'} that were serving the same home`));
        }
        keyValue('log', logPath());
      }),
    );

  daemon
    .command('stop')
    .description('Stop the capture daemon (every daemon serving this home)')
    .option('--force', "also stop daemons that did not report this home (a leftover from an older version)")
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { force?: boolean; json?: boolean }) => {
        const config = loadConfig();
        const report = await stopDaemonsForHome(config, { force: options.force });
        if (options.json) {
          printJson({
            stopped: report.stopped.length > 0,
            pids: report.stopped,
            left: report.left.map((daemon) => daemon.pid),
            untouched: report.untouched.map((daemon) => daemon.pid),
          });
          return;
        }
        if (report.stopped.length > 0) {
          ok(`daemon stopped (${report.stopped.map((pid) => `pid ${pid}`).join(', ')})`);
        } else {
          out('daemon is not running');
        }
        if (report.left.length > 0) warn(`could not stop: ${describeDaemons(report.left)}`);
        if (report.untouched.length > 0) {
          warn(`${describeDaemons(report.untouched)} answered without reporting this home`);
          out(c.grey('  stop them with: brain daemon stop --force'));
        }
      }),
    );

  daemon
    .command('status')
    .description('Show daemon connectivity and capture counters')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { json?: boolean }) => {
        const config = loadConfig();
        const record = readDaemonRecord();
        // A home should have exactly one daemon; anything else answering in the
        // port range is worth naming, because `stop` has to reach all of them.
        const situation = await daemonSituation(config);
        const extras = situation.unreachable;
        const strays = {
          extras: extras.map((d) => d.pid),
          unattributed: situation.unattributed.map((d) => d.pid),
        };
        const reportExtras = (): void => {
          if (extras.length > 0) warn(strayWarning(extras, 'stop'));
          if (situation.unattributed.length > 0) {
            warn(
              `${describeDaemons(situation.unattributed)} answered without reporting this home (started before the guard) — stop ${agree(situation.unattributed, 'it', 'them')} with: brain daemon stop --force`,
            );
          }
        };
        if (!record) {
          const serving = situation.mine.length + situation.unattributed.length;
          if (options.json) {
            printJson({
              running: false,
              pids: situation.mine.map((d) => d.pid),
              unattributed: situation.unattributed.map((d) => d.pid),
            });
            return;
          }
          if (serving > 0) {
            warn(
              `no daemon record, but ${serving} ${serving === 1 ? 'daemon is' : 'daemons are'} serving this home — run: brain daemon start`,
            );
          }
          else warn('daemon is not running');
          reportExtras();
          return;
        }
        try {
          const res = await request<Record<string, unknown>>('status', undefined, { record });
          if (options.json) {
            printJson({ running: true, ...res.result, ...strays });
            return;
          }
          heading(`daemon running (pid ${record.pid}, port ${record.port})`);
          const result = (res.result ?? {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(result)) {
            keyValue(key, Array.isArray(value) ? value.join(', ') : String(value));
          }
          reportExtras();
        } catch (err) {
          if (options.json) printJson({ running: false, error: String(err), ...strays });
          else warn(`daemon record exists but the daemon is unreachable: ${String(err)}`);
          reportExtras();
        }
      }),
    );

  daemon
    .command('restart')
    .description('Restart the daemon')
    .action(
      action(async () => {
        const config = loadConfig();
        // Restart means this home ends up with exactly one daemon: stop every
        // one it has (including duplicates), then start a fresh one.
        const report = await stopDaemonsForHome(config);
        if (report.stopped.length > 0) await new Promise((resolve) => setTimeout(resolve, 400));
        startDaemonDetached();
        const { port, pid } = await waitForDaemonOrThrow();
        const leftovers = await stopLeftoverDaemons(config, pid);
        ok(`daemon restarted (pid ${pid}, port ${port})`);
        if (leftovers.length > 0) {
          out(c.grey(`  stopped ${leftovers.length} leftover ${leftovers.length === 1 ? 'daemon' : 'daemons'} that were serving the same home`));
        }
        if (report.untouched.length > 0) {
          warn(`${describeDaemons(report.untouched)} answered without reporting this home — stop them with: brain daemon stop --force`);
        }
      }),
    );

  program
    .command('watch')
    .description('Watch project directories in the foreground (no daemon socket)')
    .option('--once', 'print what would be watched and exit')
    .action(
      action(async (options: { once?: boolean }) => {
        const { db, config, close } = createContext();
        try {
          const watcher = new ProjectWatcher(
            {
              ignore: config.watch.ignore,
              debounceMs: config.watch.debounceMs,
              maxEventsPerMinute: config.watch.maxEventsPerMinute,
            },
            (touch) => {
              const project = listProjects(db, true).find((p) => p.id === touch.projectId);
              if (!project) return;
              const result = recordFileTouch(db, {
                cwd: project.path,
                path: touch.path,
                action: touch.action,
                ts: touch.ts,
              });
              out(`  ${touch.action.padEnd(6)} ${touch.path} ${c.grey(`#${result.eventId}`)}`);
            },
          );
          const { watching } = watcher.sync(listProjects(db));
          if (options.once) {
            out(`would watch ${watching.length} project(s)`);
            await watcher.close();
            return;
          }
          ok(`watching ${watching.length} project(s) — ctrl-c to stop`);
          const stop = async (): Promise<void> => {
            await watcher.close();
            close();
            process.exit(0);
          };
          process.on('SIGINT', () => void stop());
          process.on('SIGTERM', () => void stop());
        } catch (err) {
          close();
          throw err;
        }
      }),
    );

  const hook = program.command('hook').description('Internal commands called by shell and git hooks');

  hook
    .command('cmd')
    .description('Record a shell command (fallback path for the shell hook)')
    .requiredOption('--cwd <dir>', 'working directory the command ran in')
    .requiredOption('--cmd <command>', 'the command line')
    .option('--exit <code>', 'exit code', (v) => Number(v), 0)
    .option('--session <id>', 'shell session id')
    .option('--shell <shell>', 'originating shell')
    .action(
      action(async (options: { cwd: string; cmd: string; exit: number; session?: string; shell?: string }) => {
        const { db, config, close } = createContext();
        try {
          const embedder = await getEmbedder(config);
          const result = await recordCommand(db, makeIndexer(db, embedder), {
            cwd: options.cwd,
            cmd: options.cmd,
            exitCode: options.exit,
            source: options.shell ?? 'hook',
            sessionId: options.session ?? null,
          });
          if (process.env.SECOND_BRAIN_VERBOSE) out(`captured #${result.eventId} for ${result.projectName ?? 'no project'}`);
        } finally {
          close();
        }
      }),
    );

  hook
    .command('line')
    .description('Record a tab-delimited capture line emitted by the shell hook')
    .argument('<line>', 'the SB1 line')
    .action(
      action(async (line: string) => {
        const parsed = parseLine(splitLine(line).join('\t'));
        if (!parsed) return;
        const { db, config, close } = createContext();
        try {
          const embedder = await getEmbedder(config);
          const index = makeIndexer(db, embedder);
          if (parsed.op === 'cmd') {
            const [, exitCode, ts, cwd, cmd] = parsed.fields;
            if (!cwd || !cmd) return;
            await recordCommand(db, index, {
              cwd,
              cmd,
              exitCode: Number(exitCode ?? 0),
              ts: Number(ts) || Date.now(),
              source: process.env.SECOND_BRAIN_SHELL ?? 'shell',
            });
          } else if (parsed.op === 'file') {
            const [action, cwd, filePath] = parsed.fields;
            if (!cwd || !filePath) return;
            recordFileTouch(db, {
              cwd,
              path: filePath,
              action: action === 'create' || action === 'delete' ? action : 'change',
            });
          }
        } finally {
          close();
        }
      }),
    );

  hook
    .command('commit')
    .description('Ingest new commits for a repo (called by the post-commit git hook)')
    .requiredOption('--repo <path>', 'repository path')
    .action(
      action(async (options: { repo: string }) => {
        const { db, config, close } = createContext();
        try {
          const embedder = await getEmbedder(config);
          const index = makeIndexer(db, embedder);
          const result = await recordRepoCommits(db, options.repo, 50);
          if (result.project) {
            await indexProjectCommits(db, index, result.project.id, 50);
          }
          if (process.env.SECOND_BRAIN_VERBOSE) {
            out(`ingested ${result.inserted} new commit(s) in ${result.project?.name ?? options.repo}`);
          }
        } finally {
          close();
        }
      }),
    );

  program
    .command('emit')
    .description('Record a capture line or command without a running daemon')
    .argument('[line]', 'SB1 line')
    .option('--cmd <command>', 'command to record')
    .option('--cwd <dir>', 'working directory', process.cwd())
    .option('--exit <code>', 'exit code', (v) => Number(v), 0)
    .action(
      action(async (line: string | undefined, options: { cmd?: string; cwd: string; exit: number }) => {
        const { db, config, close } = createContext();
        try {
          let payload: { cwd: string; cmd: string; exitCode: number; ts?: number } | null = null;
          if (line) {
            const parsed = parseLine(splitLine(line).join('\t'));
            if (!parsed) throw new Error('not an SB1 line; use --cmd instead');
            const [, exitCode, ts, cwd, cmd] = parsed.fields;
            payload = {
              cwd: cwd ?? options.cwd,
              cmd: cmd ?? '',
              exitCode: Number(exitCode ?? 0),
              ts: Number(ts) || undefined,
            };
          } else if (options.cmd) {
            payload = { cwd: options.cwd, cmd: options.cmd, exitCode: options.exit };
          } else {
            throw new Error('pass an SB1 line or --cmd');
          }

          // Prefer the daemon so external tools share one writer; fall back to a
          // direct database write when it is not running.
          const daemon = await connect(config).catch(() => null);
          if (daemon) {
            const response = await request('capture', { type: 'cmd', source: 'emit', ...payload }, {
              record: daemon,
            }).catch(() => null);
            if (response?.ok) {
              ok('recorded via daemon');
              return;
            }
          }
          const embedder = await getEmbedder(config);
          await recordCommand(db, makeIndexer(db, embedder), { ...payload, source: 'emit' });
          ok('recorded');
        } finally {
          close();
        }
      }),
    );

  // Autostart helper used right after `brain init` / `brain register`.
  program
    .command('up')
    .description('Ensure the daemon is running (autostart if needed)')
    .action(
      action(async () => {
        const config = loadConfig();
        const record = await connect(config);
        if (record) ok(`daemon running on port ${record.port}`);
        else throw new Error('could not start the daemon');
      }),
    );

  // `brain autostart install` writes a login item for the current platform.
  program
    .command('autostart')
    .argument('<action>', 'install | uninstall | show')
    .description('Install a login item so the daemon starts with your session')
    .action(
      action(async (cmd: string) => {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
        const entry = process.argv[1];
        const nodeBin = process.execPath;
        const command = `${nodeBin} ${entry} daemon start --foreground`;
        const paths = {
          linux: `${home}/.config/systemd/user/secondbrain.service`,
          darwin: `${home}/Library/LaunchAgents/com.secondbrain.daemon.plist`,
          windows: `${process.env.APPDATA ?? home}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\secondbrain.cmd`,
        };
        if (cmd === 'show') {
          out(`linux  ${paths.linux}`);
          out(`darwin ${paths.darwin}`);
          out(`windows ${paths.windows}`);
          out('');
          out(c.grey(`command: ${command}`));
          return;
        }
        if (cmd === 'uninstall') {
          for (const file of Object.values(paths)) {
            if (fs.existsSync(file)) fs.rmSync(file, { force: true });
          }
          ok('removed any installed autostart entry');
          return;
        }
        if (cmd !== 'install') throw new Error('action must be install | uninstall | show');
        if (process.platform === 'win32') {
          fs.mkdirSync(paths.windows.replace(/[^\\/]*$/, ''), { recursive: true });
          fs.writeFileSync(paths.windows, `@echo off\r\nstart "" /min "${nodeBin}" "${entry}" daemon start --foreground\r\n`, 'utf8');
          ok(`installed startup entry: ${paths.windows}`);
        } else if (process.platform === 'darwin') {
          const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.secondbrain.daemon</string>
  <key>ProgramArguments</key><array>${[nodeBin, entry, 'daemon', 'start', '--foreground']
    .map((part) => `<string>${part}</string>`)
    .join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
`;
          fs.mkdirSync(paths.darwin.replace(/[^\\/]*$/, ''), { recursive: true });
          fs.writeFileSync(paths.darwin, plist, 'utf8');
          ok(`installed launch agent: ${paths.darwin}`);
          out(c.grey('  load it with: launchctl load ' + paths.darwin));
        } else {
          const unit = `[Unit]
Description=Second Brain OS capture daemon

[Service]
ExecStart=${command}
Restart=on-failure

[Install]
WantedBy=default.target
`;
          fs.mkdirSync(paths.linux.replace(/[^\\/]*$/, ''), { recursive: true });
          fs.writeFileSync(paths.linux, unit, 'utf8');
          ok(`installed systemd user unit: ${paths.linux}`);
          out(c.grey('  enable it with: systemctl --user enable --now secondbrain'));
        }
      }),
    );

  program
    .command('hook-file')
    .description('Show where the git post-commit hook will be installed')
    .argument('<path>', 'repository path')
    .action(
      action((repoPath: string) => {
        out(`${repoPath}/.git/hooks/post-commit`);
      }),
    );
}
