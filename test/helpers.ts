import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../dist/db/index.js';

export function tmpDir(prefix = 'secondbrain-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testDb(dir: string): Db {
  const db = openDatabase({ path: path.join(dir, 'db.sqlite') });
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface FixtureRepo {
  dir: string;
  commits: string[];
}

/** Create a real git repo with a couple of commits (used for backfill tests). */
export function makeRepo(commits: Array<{ message: string; file: string; content: string }> = [
  { message: 'chore: initial commit', file: 'README.md', content: '# demo\n' },
  { message: 'feat: add app', file: 'app.ts', content: 'export const app = 1;\n' },
]): FixtureRepo {
  const dir = tmpDir('secondbrain-repo-');
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test User']);
  const hashes: string[] = [];
  for (const commit of commits) {
    fs.writeFileSync(path.join(dir, commit.file), commit.content);
    run(['add', '-A']);
    run(['commit', '-q', '-m', commit.message]);
    hashes.push(run(['rev-parse', 'HEAD']).trim());
  }
  return { dir, commits: hashes };
}

export function writeJsonl(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}
