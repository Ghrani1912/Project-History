import type { Db } from '../db/index.js';
import type { DecisionRow } from './types.js';

export interface DecisionInput {
  projectId: number | null;
  text: string;
  tags?: string[];
  source?: string | null;
  ts?: number;
}

/** Pull `#tags` out of a decision sentence and return the cleaned text. */
export function parseDecisionText(raw: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const text = raw
    .replace(/(^|\s)#([\p{L}\p{N}_-]+)/gu, (_match, _prefix: string, tag: string) => {
      tags.push(tag.toLowerCase());
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { text, tags };
}

export function addDecision(db: Db, input: DecisionInput): number {
  const parsed = parseDecisionText(input.text);
  const tags = new Set([...(input.tags ?? []).map((t) => t.replace(/^#/, '').toLowerCase()), ...parsed.tags]);
  const info = db
    .prepare('INSERT INTO decisions(project_id, text, tags, source, ts) VALUES (?, ?, ?, ?, ?)')
    .run(
      input.projectId,
      parsed.text.length > 0 ? parsed.text : input.text,
      tags.size > 0 ? [...tags].join(',') : null,
      input.source ?? 'manual',
      input.ts ?? Date.now(),
    );
  return Number(info.lastInsertRowid);
}

export function listDecisions(db: Db, projectId: number | null, limit = 50): DecisionRow[] {
  if (projectId === null) {
    return db.prepare('SELECT * FROM decisions ORDER BY ts DESC LIMIT ?').all(limit) as DecisionRow[];
  }
  return db
    .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY ts DESC LIMIT ?')
    .all(projectId, limit) as DecisionRow[];
}

export function countDecisions(db: Db, projectId: number | null = null): number {
  const row = (projectId === null
    ? db.prepare('SELECT COUNT(*) AS n FROM decisions').get()
    : db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE project_id = ?').get(projectId)) as { n: number };
  return row.n;
}

/**
 * Heuristic extraction of "decided X because Y / rejected Z" sentences from
 * free text (commit messages, chat turns). Used to auto-suggest decision entries.
 */
const DECISION_MARKERS = [
  /\bdecided?\s+to\b/i,
  /\bwe\s+(?:will|'ll|should)\s+use\b/i,
  /\bwent\s+with\b/i,
  /\brejected\b/i,
  /\binstead\s+of\b/i,
  /\bchose\s+\w+\s+over\b/i,
  /\bswitched?\s+(?:from|to)\b/i,
  /\bdecision:/i,
  /\btrade-?off\b/i,
];

export function extractDecisionCandidates(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 400);
  const out: string[] = [];
  for (const sentence of sentences) {
    if (DECISION_MARKERS.some((re) => re.test(sentence))) out.push(sentence);
  }
  return out;
}
