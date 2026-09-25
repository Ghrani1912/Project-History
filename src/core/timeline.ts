import type { Db } from '../db/index.js';
import { parseCommitFiles } from './commits.js';
import { describeEvent } from './events.js';
import type { ChatTurnRow, CommitRow, DecisionRow, EventRow, TimelineEntry } from './types.js';

export interface TimelineOptions {
  projectId?: number | null;
  limit?: number;
  since?: number;
  until?: number;
  kinds?: Array<TimelineEntry['kind']>;
}

/** Commit detail line: diff size, author and the files it touched. */
function commitDetail(row: CommitRow): string {
  const base = `+${row.insertions}/-${row.deletions} in ${row.files_changed} file(s) by ${row.author ?? 'unknown'}`;
  const files = parseCommitFiles(row.files);
  if (files.length === 0) return base;
  // Biggest files first: "what did this commit actually do" at a glance.
  const ranked = [...files].sort((a, b) => b.add + b.del - (a.add + a.del));
  const shown = ranked
    .slice(0, 4)
    .map((file) => (file.add + file.del > 0 ? `${file.path} +${file.add}/-${file.del}` : file.path))
    .join(', ');
  const more = ranked.length > 4 ? `, … ${ranked.length - 4} more` : '';
  return `${base}\n            ${shown}${more}`;
}

interface RawTimeline {
  kind: TimelineEntry['kind'];
  ts: number;
  projectId: number | null;
  text: string;
  detail?: string;
  source: string;
  refId: number;
}

function collect(db: Db, options: TimelineOptions): RawTimeline[] {
  const projectId = options.projectId ?? null;
  const limit = options.limit ?? 200;
  const since = options.since ?? 0;
  const until = options.until ?? Number.MAX_SAFE_INTEGER;
  const kinds = options.kinds ?? (['cmd', 'file', 'commit', 'chat', 'decision'] as const);
  const want = new Set<string>(kinds);
  const out: RawTimeline[] = [];

  if (want.has('cmd') || want.has('file')) {
    const types: string[] = [];
    if (want.has('cmd')) types.push('cmd');
    if (want.has('file')) types.push('file');
    const filters = [`type IN (${types.map(() => '?').join(',')})`, 'ts >= ?', 'ts <= ?'];
    const params: unknown[] = [...types, since, until];
    if (projectId !== null) {
      filters.push('project_id = ?');
      params.push(projectId);
    }
    params.push(limit);
    const rows = db
      .prepare(`SELECT * FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
      .all(...params) as EventRow[];
    for (const row of rows) {
      out.push({
        kind: row.type === 'file' ? 'file' : 'cmd',
        ts: row.ts,
        projectId: row.project_id,
        text: describeEvent(row),
        source: row.source,
        refId: row.id,
      });
    }
  }

  if (want.has('commit')) {
    const filters = ['ts >= ?', 'ts <= ?'];
    const params: unknown[] = [since, until];
    if (projectId !== null) {
      filters.push('project_id = ?');
      params.push(projectId);
    }
    params.push(limit);
    const rows = db
      .prepare(`SELECT * FROM commits WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
      .all(...params) as CommitRow[];
    for (const row of rows) {
      const subject = (row.message ?? '').split('\n')[0] ?? '';
      out.push({
        kind: 'commit',
        ts: row.ts,
        projectId: row.project_id,
        text: `${row.hash.slice(0, 7)} ${subject}`,
        detail: commitDetail(row),
        source: 'git',
        refId: row.id,
      });
    }
  }

  if (want.has('decision')) {
    const filters = ['ts >= ?', 'ts <= ?'];
    const params: unknown[] = [since, until];
    if (projectId !== null) {
      filters.push('project_id = ?');
      params.push(projectId);
    }
    params.push(limit);
    const rows = db
      .prepare(`SELECT * FROM decisions WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
      .all(...params) as DecisionRow[];
    for (const row of rows) {
      out.push({
        kind: 'decision',
        ts: row.ts,
        projectId: row.project_id,
        text: row.text,
        detail: row.tags ? `tags: ${row.tags}` : undefined,
        source: row.source ?? 'manual',
        refId: row.id,
      });
    }
  }

  if (want.has('chat')) {
    const filters = ['ts >= ?', 'ts <= ?'];
    const params: unknown[] = [since, until];
    if (projectId !== null) {
      filters.push('project_id = ?');
      params.push(projectId);
    }
    params.push(limit);
    const rows = db
      .prepare(`SELECT * FROM chat_turns WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
      .all(...params) as ChatTurnRow[];
    for (const row of rows) {
      out.push({
        kind: 'chat',
        ts: row.ts,
        projectId: row.project_id,
        text: `[${row.source_ide}] ${row.role}: ${row.text.slice(0, 220)}`,
        source: row.source_ide,
        refId: row.id,
      });
    }
  }

  return out;
}

/** Timeline sorted newest-first, capped at `limit` entries overall. */
export function buildTimeline(db: Db, options: TimelineOptions = {}): TimelineEntry[] {
  const limit = options.limit ?? 200;
  return collect(db, options)
    .sort((a, b) => b.ts - a.ts || b.refId - a.refId)
    .slice(0, limit)
    .map((entry) => ({
      kind: entry.kind,
      ts: entry.ts,
      projectId: entry.projectId,
      text: entry.text,
      detail: entry.detail,
      source: entry.source,
      refId: entry.refId,
    }));
}

/** Oldest-first timeline, for reading history in chronological order. */
export function buildTimelineAscending(db: Db, options: TimelineOptions = {}): TimelineEntry[] {
  return buildTimeline(db, options).reverse();
}
