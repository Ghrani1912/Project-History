import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { upsertCommit, type CommitFile, type CommitInput } from '../core/commits.js';
import type { CommitRow, ProjectRow } from '../core/types.js';
import { log } from '../util/logger.js';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(
  args: string[],
  cwd: string,
  maxBuffer = 64 * 1024 * 1024,
  env: Record<string, string> = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer, windowsHide: true, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : error ? 1 : 0;
        resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
      },
    );
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  if (!fs.existsSync(cwd)) return false;
  const res = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (res.code === 0 && res.stdout.trim() === 'true') return true;
  // Bare clones (our remote-source cache) have no work tree but do have history.
  const bare = await git(['rev-parse', '--is-bare-repository'], cwd);
  return bare.code === 0 && bare.stdout.trim() === 'true';
}

export async function gitToplevel(cwd: string): Promise<string | null> {
  const res = await git(['rev-parse', '--show-toplevel'], cwd);
  if (res.code !== 0) return null;
  const out = res.stdout.trim();
  return out.length > 0 ? out.replace(/\\/g, '/') : null;
}

export async function gitRemote(cwd: string): Promise<string | null> {
  const res = await git(['remote', 'get-url', 'origin'], cwd);
  const out = res.stdout.trim();
  return res.code === 0 && out.length > 0 ? out : null;
}

export async function currentHead(cwd: string): Promise<string | null> {
  const res = await git(['rev-parse', 'HEAD'], cwd);
  const out = res.stdout.trim();
  return res.code === 0 && out.length > 0 ? out : null;
}

/** Porcelain status, first column only (e.g. "M src/x.ts"). */
export async function gitStatusShort(cwd: string): Promise<string[]> {
  const res = await git(['status', '--porcelain'], cwd);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export interface ParsedCommit {
  hash: string;
  author: string;
  ts: number;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Per-file line counts, which is what lets briefs say *what* changed. */
  files: CommitFile[];
}

/**
 * Parse `git log --numstat --format=%x00%H%x1f%an%x1f%at%x1f%s` output.
 * A NUL byte starts each commit record, so multi-line numstat blocks can't be
 * confused with commit bodies.
 */
export function parseGitLog(stdout: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  const chunks = stdout.split('\u0000');
  for (const chunk of chunks) {
    if (chunk.trim().length === 0) continue;
    const lines = chunk.split('\n');
    const header = lines.shift();
    if (!header) continue;
    const [hash, author, tsRaw, ...messageParts] = header.split('\u001f');
    if (!hash || !tsRaw) continue;
    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;
    const files: CommitFile[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [added, removed, ...pathParts] = parts;
      const filePath = pathParts.join('\t').trim();
      if (filePath.length === 0) continue;
      // Binary files report `-` instead of a count.
      const add = added && added !== '-' ? Number(added) || 0 : 0;
      const del = removed && removed !== '-' ? Number(removed) || 0 : 0;
      filesChanged++;
      files.push({ path: filePath, add, del });
      insertions += add;
      deletions += del;
    }
    commits.push({
      hash,
      author: author ?? 'unknown',
      ts: Number(tsRaw) * 1000,
      message: messageParts.join('\u001f').trim(),
      filesChanged,
      insertions,
      deletions,
      files,
    });
  }
  return commits;
}

export interface BackfillOptions {
  /** Cap commits ingested (backfill triangle for huge repos). */
  limit?: number;
  /** Only commits newer than this epoch-ms timestamp. */
  since?: number;
  /** Restrict to HEAD history instead of --all. */
  headOnly?: boolean;
}

export interface BackfillResult {
  scanned: number;
  inserted: number;
  updated: number;
  commits: Array<{ id: number; created: boolean }>;
}

/** Ingest git history for a project. Idempotent — safe to re-run on every commit. */
export async function backfillHistory(
  db: Db,
  project: ProjectRow,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const cwd = project.path;
  if (!(await isGitRepo(cwd))) {
    return { scanned: 0, inserted: 0, updated: 0, commits: [] };
  }
  const args = ['log', '--numstat', '--format=%x00%H%x1f%an%x1f%at%x1f%s'];
  if (!options.headOnly) args.push('--all');
  if (options.since) args.push(`--since=${new Date(options.since).toISOString()}`);
  if (options.limit) args.push(`--max-count=${options.limit}`);
  args.push('--date-order');

  const res = await git(args, cwd);
  if (res.code !== 0) {
    log.warn(`git log failed in ${cwd}: ${res.stderr.trim()}`);
    return { scanned: 0, inserted: 0, updated: 0, commits: [] };
  }
  const parsed = parseGitLog(res.stdout);
  const result: BackfillResult = { scanned: parsed.length, inserted: 0, updated: 0, commits: [] };
  const tx = db.transaction((rows: ParsedCommit[]) => {
    for (const row of rows) {
      const input: CommitInput = {
        projectId: project.id,
        hash: row.hash,
        author: row.author,
        message: row.message,
        filesChanged: row.filesChanged,
        insertions: row.insertions,
        deletions: row.deletions,
        files: row.files,
        ts: row.ts,
      };
      const { id, created } = upsertCommit(db, input);
      if (created) result.inserted++;
      else result.updated++;
      result.commits.push({ id, created });
    }
  });
  tx(parsed);
  return result;
}

/* ------------------------------------------------------------------ *
 * post-commit hook
 * ------------------------------------------------------------------ */

const HOOK_START = '# >>> secondbrain >>>';
const HOOK_END = '# <<< secondbrain <<<';

export function hookPath(projectPath: string): string {
  return path.join(projectPath, '.git', 'hooks', 'post-commit');
}

export function hookScript(): string {
  return `${HOOK_START}
# Capture the new commit into the Second Brain timeline (non-blocking).
if command -v brain >/dev/null 2>&1; then
  brain hook commit --repo "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" >/dev/null 2>&1 &
fi
${HOOK_END}
`;
}

export interface HookResult {
  installed: boolean;
  path: string;
  reason?: string;
  /** True when an existing foreign hook was preserved and ours appended. */
  chained: boolean;
}

export function installPostCommitHook(projectPath: string): HookResult {
  const target = hookPath(projectPath);
  const dir = path.dirname(target);
  if (!fs.existsSync(path.join(projectPath, '.git'))) {
    return { installed: false, path: target, reason: 'not a git repository', chained: false };
  }
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (existing.includes(HOOK_START)) {
    return { installed: true, path: target, chained: true, reason: 'already installed' };
  }
  const chained = existing.trim().length > 0;
  const body = chained
    ? `${existing.replace(/\s*$/, '\n')}\n# --- added by secondbrain ---\n${hookScript()}`
    : `#!/bin/sh\n${hookScript()}`;
  fs.writeFileSync(target, body, 'utf8');
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // Windows: the executable bit is not meaningful.
  }
  return { installed: true, path: target, chained };
}

export function uninstallPostCommitHook(projectPath: string): { removed: boolean; path: string } {
  const target = hookPath(projectPath);
  if (!fs.existsSync(target)) return { removed: false, path: target };
  const content = fs.readFileSync(target, 'utf8');
  const start = content.indexOf(HOOK_START);
  const end = content.indexOf(HOOK_END);
  if (start === -1 || end === -1) return { removed: false, path: target };
  const cleaned = `${content.slice(0, start)}${content.slice(end + HOOK_END.length)}`
    .replace(/\n# --- added by secondbrain ---\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned === '' || cleaned === '#!/bin/sh' || cleaned === '#!') {
    fs.rmSync(target, { force: true });
    return { removed: true, path: target };
  }
  fs.writeFileSync(target, `${cleaned}\n`, 'utf8');
  return { removed: true, path: target };
}

export function hasPostCommitHook(projectPath: string): boolean {
  const target = hookPath(projectPath);
  if (!fs.existsSync(target)) return false;
  return fs.readFileSync(target, 'utf8').includes(HOOK_START);
}

/** Diff stats for a single commit, used when a hook reports one commit. */
export async function commitStats(cwd: string, hash: string): Promise<ParsedCommit | null> {
  // NB: no `-s` here — it suppresses the numstat lines we need.
  const res = await git(['show', '--numstat', '--format=%x00%H%x1f%an%x1f%at%x1f%s', hash], cwd);
  if (res.code !== 0) return null;
  const parsed = parseGitLog(res.stdout);
  return parsed[0] ?? null;
}

export function commitRowToTimelineText(row: CommitRow): string {
  return `${row.hash.slice(0, 7)} ${(row.message ?? '').split('\n')[0] ?? ''}`.trim();
}
