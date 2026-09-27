import type { Db } from '../db/index.js';
import type { EventRow, EventType, TimelineEntry } from './types.js';

export interface CaptureEventInput {
  projectId: number | null;
  type: EventType;
  payload: unknown;
  exitCode?: number | null;
  /** Epoch millis parsed from the content itself; defaults to now. */
  ts?: number;
  source: string;
  sessionId?: string | null;
}

export function insertEvent(db: Db, input: CaptureEventInput): number {
  const info = db
    .prepare('INSERT INTO events(project_id, type, payload, exit_code, ts, source, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      input.projectId,
      input.type,
      typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload ?? {}),
      input.exitCode ?? null,
      input.ts ?? Date.now(),
      input.source,
      input.sessionId ?? null,
    );
  return Number(info.lastInsertRowid);
}

export function insertEvents(db: Db, inputs: CaptureEventInput[]): number[] {
  const ids: number[] = [];
  const tx = db.transaction((batch: CaptureEventInput[]) => {
    for (const item of batch) ids.push(insertEvent(db, item));
  });
  tx(inputs);
  return ids;
}

export function recentEvents(db: Db, projectId: number | null, limit = 50, types?: EventType[]): EventRow[] {
  const typeFilter = types && types.length > 0 ? `AND type IN (${types.map(() => '?').join(',')})` : '';
  const projectFilter = projectId === null ? '' : 'AND project_id = ?';
  const params: unknown[] = [];
  if (projectId !== null) params.push(projectId);
  if (types && types.length > 0) params.push(...types);
  params.push(limit);
  return db
    .prepare(`SELECT * FROM events WHERE 1 = 1 ${projectFilter} ${typeFilter} ORDER BY ts DESC LIMIT ?`)
    .all(...params) as EventRow[];
}

export function eventsSince(db: Db, projectId: number | null, sinceTs: number, limit = 500): EventRow[] {
  const projectFilter = projectId === null ? '' : 'AND project_id = ?';
  const params: unknown[] = projectId === null ? [sinceTs, limit] : [projectId, sinceTs, limit];
  return db
    .prepare(`SELECT * FROM events WHERE ts >= ? ${projectFilter} ORDER BY ts ASC LIMIT ?`)
    .all(...params) as EventRow[];
}

export function lastEventId(db: Db, projectId: number | null = null): number {
  const row = (projectId === null
    ? db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get()
    : db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE project_id = ?').get(projectId)) as {
    id: number;
  };
  return row.id;
}

export function countEvents(db: Db, projectId: number | null = null): number {
  const row = (projectId === null
    ? db.prepare('SELECT COUNT(*) AS n FROM events').get()
    : db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').get(projectId)) as { n: number };
  return row.n;
}

/** Human-readable one-liner for an event, used by timelines and briefs. */
/** Parse an event payload, falling back to `{ raw }` for non-JSON rows. */
export function eventPayload(event: EventRow): Record<string, unknown> {
  try {
    return JSON.parse(event.payload) as Record<string, unknown>;
  } catch {
    return { raw: event.payload };
  }
}

/** The command line an event carries, or '' when it has none. */
export function eventCommand(event: EventRow): string {
  return String(eventPayload(event).cmd ?? '').trim();
}

export function describeEvent(event: EventRow): string {
  const payload = eventPayload(event);
  switch (event.type) {
    case 'cmd': {
      const cmd = String(payload.cmd ?? payload.raw ?? '').trim();
      const code = event.exit_code ?? 0;
      return code === 0 ? `$ ${cmd}` : `$ ${cmd}  (exit ${code})`;
    }
    case 'file': {
      const action = String(payload.action ?? 'change');
      const file = String(payload.path ?? '');
      return `${action} ${file}`;
    }
    case 'error': {
      // A failed command plus the error output that followed it. The command
      // and its exit code come first so "how did I fix this error" can match on
      // the same words the terminal showed.
      const cmd = String(payload.cmd ?? payload.raw ?? '').trim();
      const code = event.exit_code ?? 0;
      const raw = String(payload.output ?? '').replace(/\r/g, '');
      const firstLine = raw.split(/\n/).find((line) => line.trim().length > 0) ?? '';
      const hint = firstLine.replace(/\s+/g, ' ').trim().slice(0, 160);
      return `! ${cmd}  (exit ${code})${hint ? `  → ${hint}` : ''}`;
    }
    case 'commit':
      return `commit ${String(payload.hash ?? '').slice(0, 7)}: ${String(payload.message ?? '').split('\n')[0]}`;
    case 'chat': {
      const role = String(payload.role ?? 'chat');
      return `${role}: ${String(payload.text ?? '').slice(0, 200)}`;
    }
    case 'decision':
      return `decided: ${String(payload.text ?? '')}`;
    default:
      return event.payload;
  }
}

export function eventToTimeline(event: EventRow): TimelineEntry {
  return {
    kind: event.type === 'file' ? 'file' : (event.type as TimelineEntry['kind']),
    ts: event.ts,
    projectId: event.project_id,
    text: describeEvent(event),
    source: event.source,
    refId: event.id,
  };
}
