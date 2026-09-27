import type { Db } from '../db/index.js';
import { eventCommand, eventPayload } from './events.js';
import { listProjects } from './projects.js';
import type { EventRow } from './types.js';

/**
 * Failed commands are only half the story. The useful question is "how did I fix
 * this error before" — so a failure is paired with the first later command that
 * ran the same line and succeeded. That pairing is a fact in the record, which
 * is what makes the lookup trustworthy rather than a similarity guess.
 */

export interface FailureRecord {
  id: number;
  projectId: number | null;
  projectName: string | null;
  cmd: string;
  exitCode: number;
  /** Captured stdout/stderr tail, when the capture path had it. */
  output: string;
  ts: number;
  /** When the same command next succeeded, or null while it is still broken. */
  fixedAt: number | null;
}

interface EventWithCmd {
  row: EventRow;
  cmd: string;
}

/**
 * The tool logs its own invocations when dogfooding is on (`source = 'self'`,
 * see core/selflog.ts). Those entries are bookkeeping, not your project's
 * development history: a `brain connect` that exited non-zero while the tool
 * was being exercised must never read as one of *your* broken runs. The events
 * themselves are kept — only the failure reports filter them out.
 */
export const EXCLUDE_SELF = "AND source != 'self'";

export interface FailureOptions {
  /** Only this project (default: across every project). */
  projectId?: number | null;
  limit?: number;
  /** Skip failures that were later re-run successfully. */
  openOnly?: boolean;
}

/** Command lines from the newest N failing events, newest first. */
function failingEvents(db: Db, projectId: number | null, scan: number): EventWithCmd[] {
  const projectFilter = projectId === null ? '' : 'AND project_id = ?';
  const params = projectId === null ? [] : [projectId];
  const rows = db
    .prepare(`SELECT * FROM events WHERE exit_code != 0 ${EXCLUDE_SELF} ${projectFilter} ORDER BY ts DESC LIMIT ?`)
    .all(...params, scan) as EventRow[];
  return rows
    .map((row) => ({ row, cmd: eventCommand(row) }))
    .filter((entry) => entry.cmd.length > 0);
}

/** First later success of the exact same command line, if there is one. */
function firstFixAfter(db: Db, projectId: number | null, cmd: string, ts: number): number | null {
  const projectFilter = projectId === null ? '' : 'AND project_id = ?';
  const params: unknown[] = projectId === null ? [ts] : [ts, projectId];
  const rows = db
    .prepare(
      `SELECT payload, ts FROM events
        WHERE exit_code = 0 AND ts > ? ${projectFilter} ${EXCLUDE_SELF}
        ORDER BY ts ASC LIMIT 200`,
    )
    .all(...params) as Array<{ payload: string; ts: number }>;
  for (const row of rows) {
    let parsed: { cmd?: string } = {};
    try {
      parsed = JSON.parse(row.payload) as { cmd?: string };
    } catch {
      parsed = {};
    }
    if (String(parsed.cmd ?? '').trim() === cmd) return row.ts;
  }
  return null;
}

/** Recent failures, each with the fix that followed it (or null if unresolved). */
export function listFailures(db: Db, options: FailureOptions = {}): FailureRecord[] {
  const projectId = options.projectId ?? null;
  const limit = options.limit ?? 20;
  const names = new Map<number, string>(listProjects(db).map((project) => [project.id, project.name]));
  const out: FailureRecord[] = [];
  for (const { row, cmd } of failingEvents(db, projectId, Math.max(limit * 5, 200))) {
    const fixedAt = firstFixAfter(db, row.project_id, cmd, row.ts);
    if (options.openOnly && fixedAt !== null) continue;
    out.push({
      id: row.id,
      projectId: row.project_id,
      projectName: row.project_id === null ? null : names.get(row.project_id) ?? null,
      cmd,
      exitCode: row.exit_code ?? 0,
      output: String(eventPayload(row).output ?? ''),
      ts: row.ts,
      fixedAt,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function countOpenFailures(db: Db): number {
  // Cheap-ish: the listing already pairs each failure with its fix.
  return listFailures(db, { limit: 200, openOnly: true }).length;
}
