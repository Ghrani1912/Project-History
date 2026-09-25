import type { Db } from '../db/index.js';
import type { BriefRow } from './types.js';

export interface BriefInput {
  projectId: number;
  summaryText: string;
  generatedAt?: number;
  eventWatermark?: number | null;
  generator?: string | null;
}

export function saveBrief(db: Db, input: BriefInput): number {
  const info = db
    .prepare(
      'INSERT INTO briefs(project_id, summary_text, generated_at, event_watermark, generator) VALUES (?, ?, ?, ?, ?)',
    )
    .run(
      input.projectId,
      input.summaryText,
      input.generatedAt ?? Date.now(),
      input.eventWatermark ?? null,
      input.generator ?? null,
    );
  return Number(info.lastInsertRowid);
}

export function latestBrief(db: Db, projectId: number): BriefRow | null {
  const row = db
    .prepare('SELECT * FROM briefs WHERE project_id = ? ORDER BY generated_at DESC, id DESC LIMIT 1')
    .get(projectId) as BriefRow | undefined;
  return row ?? null;
}

export function recentBriefs(db: Db, projectId: number, limit = 10): BriefRow[] {
  return db
    .prepare('SELECT * FROM briefs WHERE project_id = ? ORDER BY generated_at DESC LIMIT ?')
    .all(projectId, limit) as BriefRow[];
}

export function countBriefs(db: Db, projectId?: number): number {
  const row = (projectId === undefined
    ? db.prepare('SELECT COUNT(*) AS n FROM briefs').get()
    : db.prepare('SELECT COUNT(*) AS n FROM briefs WHERE project_id = ?').get(projectId)) as { n: number };
  return row.n;
}
