import type { Db } from '../db/index.js';
import type { CommitRow } from './types.js';

export interface CommitInput {
  projectId: number;
  hash: string;
  author?: string | null;
  message?: string | null;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  files?: string[] | null;
  ts: number;
}

export interface UpsertResult {
  id: number;
  created: boolean;
}

export function upsertCommit(db: Db, commit: CommitInput): UpsertResult {
  const existing = db
    .prepare('SELECT id FROM commits WHERE project_id = ? AND hash = ?')
    .get(commit.projectId, commit.hash) as { id: number } | undefined;
  const filesJson = commit.files ? JSON.stringify(commit.files) : null;
  if (existing) {
    db.prepare(
      `UPDATE commits
          SET author = ?, message = ?, files_changed = ?, insertions = ?, deletions = ?, files = ?, ts = ?
        WHERE id = ?`,
    ).run(
      commit.author ?? null,
      commit.message ?? null,
      commit.filesChanged ?? 0,
      commit.insertions ?? 0,
      commit.deletions ?? 0,
      filesJson,
      commit.ts,
      existing.id,
    );
    return { id: existing.id, created: false };
  }
  const info = db
    .prepare(
      `INSERT INTO commits(project_id, hash, author, message, files_changed, insertions, deletions, files, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      commit.projectId,
      commit.hash,
      commit.author ?? null,
      commit.message ?? null,
      commit.filesChanged ?? 0,
      commit.insertions ?? 0,
      commit.deletions ?? 0,
      filesJson,
      commit.ts,
    );
  return { id: Number(info.lastInsertRowid), created: true };
}

export function listCommits(db: Db, projectId: number, limit = 50): CommitRow[] {
  return db
    .prepare('SELECT * FROM commits WHERE project_id = ? ORDER BY ts DESC LIMIT ?')
    .all(projectId, limit) as CommitRow[];
}

export function firstCommitTs(db: Db, projectId: number): number | null {
  const row = db.prepare('SELECT MIN(ts) AS ts FROM commits WHERE project_id = ?').get(projectId) as {
    ts: number | null;
  };
  return row.ts ?? null;
}

export function countCommits(db: Db, projectId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM commits WHERE project_id = ?').get(projectId) as { n: number };
  return row.n;
}

export function lastCommitHash(db: Db, projectId: number): string | null {
  const row = db.prepare('SELECT hash FROM commits WHERE project_id = ? ORDER BY ts DESC LIMIT 1').get(projectId) as
    | { hash: string }
    | undefined;
  return row?.hash ?? null;
}
