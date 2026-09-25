import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { normalizePath } from '../util/paths.js';
import type { ProjectRow } from './types.js';

export interface RegisterResult {
  project: ProjectRow;
  created: boolean;
}

export function findProjectByPath(db: Db, projectPath: string): ProjectRow | null {
  const normalized = normalizePath(projectPath);
  const row = db.prepare('SELECT * FROM projects WHERE path = ?').get(normalized) as ProjectRow | undefined;
  return row ?? null;
}

/**
 * Walk up from `cwd` to find the closest registered project containing it.
 * Returns null when the directory lives outside every registered project.
 */
export function resolveProjectForPath(db: Db, cwd: string): ProjectRow | null {
  const normalized = normalizePath(cwd);
  const row = db
    .prepare(
      `SELECT * FROM projects
        WHERE path = ?
           OR ? LIKE path || '/%'
        ORDER BY length(path) DESC
        LIMIT 1`,
    )
    .get(normalized, normalized) as ProjectRow | undefined;
  return row ?? null;
}

export function getProject(db: Db, idOrName: string | number): ProjectRow | null {
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(idOrName)) as ProjectRow | undefined;
    if (row) return row;
  }
  const key = String(idOrName);
  const row = db
    .prepare('SELECT * FROM projects WHERE name = ? OR path = ? LIMIT 1')
    .get(key, normalizePath(key)) as ProjectRow | undefined;
  return row ?? null;
}

/**
 * Registered projects, newest activity first. The synthetic `global://` bucket is
 * hidden unless `includeIgnored` is set, so callers (watcher, listings) only ever
 * see real on-disk directories.
 */
export function listProjects(db: Db, includeIgnored = false): ProjectRow[] {
  const where = includeIgnored ? 'WHERE ignored = 0' : "WHERE ignored = 0 AND path != 'global://'";
  return db
    .prepare(`SELECT * FROM projects ${where} ORDER BY COALESCE(last_seen_at, created_at) DESC`)
    .all() as ProjectRow[];
}

export interface RegisterOptions {
  name?: string;
  ts?: number;
}

/**
 * Register `projectPath` as a project. Idempotent: re-registering refreshes
 * `last_seen_at` (and the name when explicitly provided).
 */
export function registerProject(db: Db, projectPath: string, options: RegisterOptions = {}): RegisterResult {
  const normalized = normalizePath(projectPath);
  if (!fs.existsSync(normalized)) {
    throw new Error(`Cannot register ${normalized}: path does not exist`);
  }
  const ts = options.ts ?? Date.now();
  const existing = findProjectByPath(db, normalized);
  if (existing) {
    db.prepare('UPDATE projects SET last_seen_at = ? WHERE id = ?').run(ts, existing.id);
    if (options.name && options.name !== existing.name) {
      db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(options.name, existing.id);
      return { project: { ...existing, name: options.name, last_seen_at: ts }, created: false };
    }
    return { project: { ...existing, last_seen_at: ts }, created: false };
  }
  const name = options.name ?? (path.basename(normalized) || normalized);
  const info = db
    .prepare('INSERT INTO projects(name, path, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(name, normalized, ts, ts);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(info.lastInsertRowid)) as ProjectRow;
  return { project, created: true };
}

export function touchProject(db: Db, projectId: number, ts: number): void {
  db.prepare('UPDATE projects SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').run(
    ts,
    projectId,
    ts,
  );
}

export function setProjectMeta(
  db: Db,
  projectId: number,
  fields: Partial<Pick<ProjectRow, 'name' | 'git_remote' | 'stack' | 'summary' | 'open_threads' | 'ignored'>>,
): void {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const setSql = entries.map(([k]) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE projects SET ${setSql} WHERE id = ?`).run(...entries.map(([, v]) => v as never), projectId);
}

export function removeProject(db: Db, projectId: number): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
}

/** Ensure the synthetic bucket that holds cross-project ("global") memory. */
export function ensureGlobalProject(db: Db, ts = Date.now()): ProjectRow {
  const existing = db
    .prepare("SELECT * FROM projects WHERE name = 'global' AND path = 'global://'")
    .get() as ProjectRow | undefined;
  if (existing) return existing;
  const info = db
    .prepare('INSERT INTO projects(name, path, created_at, last_seen_at, summary) VALUES (?, ?, ?, ?, ?)')
    .run('global', 'global://', ts, ts, 'Cross-project decisions and memory.');
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(info.lastInsertRowid)) as ProjectRow;
}

export const GLOBAL_PROJECT_PATH = 'global://';
