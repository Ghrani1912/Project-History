import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { registerProject } from '../dist/core/projects.js';
import { listCommits } from '../dist/core/commits.js';
import {
  backfillHistory,
  commitStats,
  hasPostCommitHook,
  installPostCommitHook,
  parseGitLog,
  uninstallPostCommitHook,
} from '../dist/git/git.js';
import { hasGit, makeRepo, testDb, tmpDir } from './helpers.ts';

test('parseGitLog reads hash, author, timestamp, message and numstat totals', () => {
  const fixture = [
    '\u0000abc123\u001fAda Lovelace\u001f1700000000\u001ffeat: add parser',
    '12\t3\tsrc/parser.ts',
    '-\t-\tassets/logo.png',
    '',
    '\u0000def456\u001fGrace Hopper\u001f1700003600\u001fchore: tidy',
    '1\t0\tREADME.md',
  ].join('\n');

  const commits = parseGitLog(fixture);
  assert.equal(commits.length, 2);

  const first = commits[0];
  assert.equal(first?.hash, 'abc123');
  assert.equal(first?.author, 'Ada Lovelace');
  assert.equal(first?.ts, 1_700_000_000_000);
  assert.equal(first?.message, 'feat: add parser');
  assert.equal(first?.filesChanged, 2);
  assert.equal(first?.insertions, 12);
  assert.equal(first?.deletions, 3);
  assert.deepEqual(first?.files, ['src/parser.ts', 'assets/logo.png']);

  const second = commits[1];
  assert.equal(second?.insertions, 1);
  assert.equal(second?.deletions, 0);
});

test('parseGitLog ignores malformed records', () => {
  assert.deepEqual(parseGitLog(''), []);
  assert.deepEqual(parseGitLog('\u0000only-a-hash'), []);
});

test('backfillHistory ingests real git history idempotently', { skip: !hasGit() }, async () => {
  const repo = makeRepo();
  const dir = tmpDir();
  const db = testDb(dir);
  const project = registerProject(db, repo.dir).project;

  const first = await backfillHistory(db, project);
  assert.equal(first.scanned, 2);
  assert.equal(first.inserted, 2);
  assert.equal(listCommits(db, project.id).length, 2);
  assert.equal(listCommits(db, project.id)[0]?.message, 'feat: add app');

  const second = await backfillHistory(db, project);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 2);
  assert.equal(listCommits(db, project.id).length, 2, 're-running must not duplicate commits');
  db.close();
});

test('backfillHistory honours the commit limit', { skip: !hasGit() }, async () => {
  const repo = makeRepo();
  const dir = tmpDir();
  const db = testDb(dir);
  const project = registerProject(db, repo.dir).project;
  const result = await backfillHistory(db, project, { limit: 1 });
  assert.equal(result.scanned, 1);
  db.close();
});

test('commitStats returns parsed stats for a single commit', { skip: !hasGit() }, async () => {
  const repo = makeRepo();
  const stats = await commitStats(repo.dir, repo.commits[1] as string);
  assert.ok(stats);
  assert.equal(stats?.filesChanged, 1);
  assert.equal(stats?.files[0], 'app.ts');
});

test('post-commit hook installs, chains and uninstalls cleanly', { skip: !hasGit() }, () => {
  const repo = makeRepo();
  const hookFile = path.join(repo.dir, '.git', 'hooks', 'post-commit');

  const first = installPostCommitHook(repo.dir);
  assert.equal(first.installed, true);
  assert.equal(first.chained, false);
  assert.equal(hasPostCommitHook(repo.dir), true);
  const content = fs.readFileSync(hookFile, 'utf8');
  assert.match(content, /^#!\/bin\/sh/);
  assert.match(content, /brain hook commit/);

  // Second install is a no-op.
  const again = installPostCommitHook(repo.dir);
  assert.equal(again.installed, true);
  assert.equal(fs.readFileSync(hookFile, 'utf8'), content);

  // An existing foreign hook must be preserved and appended to.
  fs.writeFileSync(hookFile, '#!/bin/sh\necho existing\n', 'utf8');
  const chained = installPostCommitHook(repo.dir);
  assert.equal(chained.chained, true);
  const chainedContent = fs.readFileSync(hookFile, 'utf8');
  assert.match(chainedContent, /echo existing/);
  assert.match(chainedContent, /brain hook commit/);

  const removed = uninstallPostCommitHook(repo.dir);
  assert.equal(removed.removed, true);
  assert.equal(hasPostCommitHook(repo.dir), false);
  assert.match(fs.readFileSync(hookFile, 'utf8'), /echo existing/, 'foreign hook survives removal');

  // Removing a hook we do not own is a no-op.
  assert.equal(uninstallPostCommitHook(repo.dir).removed, false);
});

test('installPostCommitHook refuses directories that are not repos', () => {
  const dir = tmpDir();
  const result = installPostCommitHook(dir);
  assert.equal(result.installed, false);
  assert.match(result.reason ?? '', /not a git repository/);
});

test('backfillHistory on a non-repo is a no-op', async () => {
  const dir = tmpDir();
  const db = testDb(dir);
  const projectPath = path.join(dir, 'plain');
  fs.mkdirSync(projectPath, { recursive: true });
  const project = registerProject(db, projectPath).project;
  const result = await backfillHistory(db, project);
  assert.deepEqual({ scanned: result.scanned, inserted: result.inserted }, { scanned: 0, inserted: 0 });
  db.close();
});
