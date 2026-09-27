import type { Command } from 'commander';
import { loadConfig, saveConfig } from '../config.js';
import { pruneSelfLog } from '../core/selflog.js';
import { plural, relativeTime } from '../util/format.js';
import { action, createContext } from './context.js';
import { c, heading, keyValue, ok, out, printJson, warn } from './output.js';

interface SelfOptions {
  limit: number;
  prune?: boolean;
  /** With --prune: remove successful invocations too, not just failures. */
  all?: boolean;
  yes?: boolean;
  json?: boolean;
}

/**
 * Dogfooding controls. With self-logging on, every `brain` command is written to
 * the same record it reads from — so the tool develops a memory of its own use.
 * `brain self status` is the honest answer to "is that actually happening?".
 */
export function registerDogfoodCommands(program: Command): void {
  program
    .command('self')
    .description('Dogfooding: log this tool\'s own commands into its own record')
    .argument('[action]', 'on | off | status (default: status)')
    .option('--prune', "delete this tool's own bookkeeping rows from the record")
    .option('--all', 'with --prune: also delete the successful invocations (the dogfooding trail)')
    .option('--yes', 'with --prune --all: confirm deleting the dogfooding trail')
    .option('--limit <n>', 'how many recent self-logged commands to show', (v) => Number(v), 10)
    .option('--json', 'machine-readable output')
    .action(
      action(async (action_: string | undefined, options: SelfOptions) => {
        if (options.prune) {
          // The default prune only removes rows failure reports already ignore.
          // Widening it to the dogfooding trail is a real loss, so it is gated.
          if (options.all && !options.yes) {
            throw new Error('--prune --all also deletes successful invocations — pass --yes to confirm');
          }
          const { db, close } = createContext();
          try {
            const result = pruneSelfLog(db, { all: options.all });
            if (options.json) {
              printJson(result);
              return;
            }
            if (result.removed === 0) {
              ok('nothing to prune — no self-logged bookkeeping on record');
              return;
            }
            ok(
              `pruned ${plural(result.removed, 'self-logged event')} ` +
                c.grey(`(${result.failed} failed, ${result.succeeded} successful)`),
            );
            if (result.failed > 0) {
              out(c.grey('  failure reports already ignored the failed ones — they are simply gone now'));
            }
          } finally {
            close();
          }
          return;
        }
        const choice = (action_ ?? 'status').toLowerCase();
        if (choice !== 'on' && choice !== 'off' && choice !== 'status') {
          throw new Error(`unknown action "${action_}" — use on, off, status or --prune`);
        }

        if (choice === 'on' || choice === 'off') {
          const config = loadConfig();
          config.selfLog.enabled = choice === 'on';
          const file = saveConfig(config);
          if (options.json) {
            printJson({ selfLog: config.selfLog.enabled, configFile: file });
            return;
          }
          ok(`self-logging ${config.selfLog.enabled ? 'enabled' : 'disabled'} (${file})`);
          if (config.selfLog.enabled) {
            out(c.grey('  every `brain` command from now on is recorded against the project it runs in'));
          }
          return;
        }

        const { db, close } = createContext();
        try {
          const count = (
            db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'self'").get() as { n: number }
          ).n;
          const failed = (
            db
              .prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'self' AND exit_code != 0")
              .get() as { n: number }
          ).n;
          const recent = db
            .prepare("SELECT ts, payload FROM events WHERE source = 'self' ORDER BY ts DESC LIMIT ?")
            .all(options.limit) as Array<{ ts: number; payload: string }>;
          if (options.json) {
            printJson({ enabled: loadConfig().selfLog.enabled, logged: count, failed, recent });
            return;
          }
          heading('Self-logging (dogfooding)');
          keyValue('enabled', loadConfig().selfLog.enabled ? 'yes' : 'no');
          keyValue('logged', String(count));
          if (!loadConfig().selfLog.enabled) {
            warn('off — enable with `brain self on` so the tool records its own use');
          }
          if (failed > 0) {
            out(
              c.grey(
                `  ${plural(failed, 'invocation')} exited non-zero — failure reports ignore them; remove with: brain self --prune`,
              ),
            );
          }
          for (const row of recent) {
            let cmd = '';
            try {
              cmd = String((JSON.parse(row.payload) as { cmd?: string }).cmd ?? '');
            } catch {
              cmd = '';
            }
            out(`  ${c.grey(relativeTime(row.ts).padEnd(14))} ${cmd}`);
          }
        } finally {
          close();
        }
      }),
    );
}
