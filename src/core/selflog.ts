import type { BrainConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { insertEvent } from './events.js';
import { resolveProjectForPath } from './projects.js';
import { normalizePath } from '../util/paths.js';

/**
 * Dogfooding: when enabled, every `brain` invocation is recorded as a captured
 * command against the project it ran in. Use the tool for a day and it has
 * written its own development history — which is the fastest way to find its own
 * rough edges, and the best demo material it can have.
 *
 * Two rules keep this from becoming noise: bookkeeping subcommands (`hook`,
 * `self`, the shell's `brief --auto` probe) are never logged, and a failure to
 * write the log never surfaces — the operation the user asked for always wins.
 */

/**
 * Subcommands that exist to talk to the daemon, to this logger itself, or that
 * already record what they ran (`run`) — logging those would double-count.
 */
const NEVER_LOGGED = new Set(['hook', 'self', 'run']);

/** True when self-logging is on, via config or the environment override. */
export function selfLogEnabled(config: BrainConfig): boolean {
  if (config.selfLog.enabled) return true;
  const env = (process.env.BRAIN_SELF_LOG ?? '').toLowerCase();
  return env === '1' || env === 'true' || env === 'yes';
}

/** Whether this specific invocation is worth recording. */
export function shouldSelfLog(args: string[]): boolean {
  const first = args[0];
  if (!first || first.startsWith('-')) return false;
  if (NEVER_LOGGED.has(first)) return false;
  // The shell's cd hook calls this on every directory change; logging it would
  // drown the timeline in the tool's own bookkeeping.
  if (first === 'brief' && args.includes('--auto')) return false;
  return true;
}

export interface SelfLogInput {
  /** Arguments after the program name, exactly as typed. */
  args: string[];
  cwd?: string;
  exitCode?: number | null;
  ts?: number;
}

export interface PruneResult {
  /** Every self-logged row removed. */
  removed: number;
  /** Of those, invocations that exited non-zero. */
  failed: number;
  /** Of those, invocations that succeeded (only removed with `all`). */
  succeeded: number;
}

/**
 * Remove the tool's own bookkeeping from the record.
 *
 * The failed invocations are why this exists: failure reports already filter
 * `source = 'self'` out (see core/errors.ts), so those rows are pure clutter
 * nothing can cite. The successful ones are different — they are the
 * dogfooding trail `brain self status` shows — so they only go when the caller
 * asks for everything.
 *
 * No recall cleanup is needed: `recordSelfInvocation` writes through
 * `insertEvent`, which bypasses the indexer, so self rows are never in
 * `search_docs` or `embeddings`. Deleting them cannot leave a dangling hit.
 */
export function pruneSelfLog(db: Db, options: { all?: boolean } = {}): PruneResult {
  const where = options.all ? "source = 'self'" : "source = 'self' AND exit_code != 0";
  const rows = db.prepare(`SELECT id, exit_code FROM events WHERE ${where}`).all() as Array<{
    id: number;
    exit_code: number | null;
  }>;
  if (rows.length > 0) {
    const remove = db.prepare('DELETE FROM events WHERE id = ?');
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) remove.run(id);
    });
    tx(rows.map((row) => row.id));
  }
  const failed = rows.filter((row) => (row.exit_code ?? 0) !== 0).length;
  return { removed: rows.length, failed, succeeded: rows.length - failed };
}

/**
 * Record one invocation. Returns the event id, or null when it was skipped or
 * could not be written (never throws — logging its own use must not break use).
 */
export function recordSelfInvocation(db: Db, input: SelfLogInput): number | null {
  if (!shouldSelfLog(input.args)) return null;
  const cwd = input.cwd ?? process.cwd();
  const cmd = `brain ${input.args.join(' ')}`.slice(0, 2000);
  try {
    const project = resolveProjectForPath(db, cwd);
    return insertEvent(db, {
      projectId: project?.id ?? null,
      type: 'cmd',
      payload: { cmd, cwd: normalizePath(cwd), self: true },
      exitCode: input.exitCode ?? 0,
      ts: input.ts ?? Date.now(),
      source: 'self',
    });
  } catch {
    return null;
  }
}
