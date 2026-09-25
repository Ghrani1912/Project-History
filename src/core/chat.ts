import type { Db } from '../db/index.js';
import type { ChatTurnRow } from './types.js';

export interface ChatTurnInput {
  projectId: number | null;
  sourceIde: string;
  role: string;
  text: string;
  ts: number;
  /** Stable pointer such as `<transcript file>#<index>`; enables idempotent re-ingest. */
  sourceRef?: string | null;
}

export interface ChatInsertResult {
  id: number;
  created: boolean;
}

export function insertChatTurn(db: Db, turn: ChatTurnInput): ChatInsertResult {
  const existing = turn.sourceRef
    ? (db
        .prepare('SELECT id FROM chat_turns WHERE source_ide = ? AND source_ref = ?')
        .get(turn.sourceIde, turn.sourceRef) as { id: number } | undefined)
    : undefined;
  if (existing) return { id: existing.id, created: false };
  const info = db
    .prepare('INSERT INTO chat_turns(project_id, source_ide, role, text, ts, source_ref) VALUES (?, ?, ?, ?, ?, ?)')
    .run(turn.projectId, turn.sourceIde, turn.role, turn.text, turn.ts, turn.sourceRef ?? null);
  return { id: Number(info.lastInsertRowid), created: true };
}

export function listChatTurns(db: Db, projectId: number | null, limit = 50): ChatTurnRow[] {
  if (projectId === null) {
    return db.prepare('SELECT * FROM chat_turns ORDER BY ts DESC LIMIT ?').all(limit) as ChatTurnRow[];
  }
  return db
    .prepare('SELECT * FROM chat_turns WHERE project_id = ? ORDER BY ts DESC LIMIT ?')
    .all(projectId, limit) as ChatTurnRow[];
}

export function lastChatSourceRef(db: Db, sourceIde: string): string | null {
  const row = db
    .prepare('SELECT source_ref FROM chat_turns WHERE source_ide = ? AND source_ref IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(sourceIde) as { source_ref: string } | undefined;
  return row?.source_ref ?? null;
}

export function countChatTurns(db: Db, projectId: number | null = null): number {
  const row = (projectId === null
    ? db.prepare('SELECT COUNT(*) AS n FROM chat_turns').get()
    : db.prepare('SELECT COUNT(*) AS n FROM chat_turns WHERE project_id = ?').get(projectId)) as { n: number };
  return row.n;
}
