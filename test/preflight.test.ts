import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { upsertCommit } from '../dist/core/commits.js';
import { addDecision } from '../dist/core/decisions.js';
import { checkProposal, decisionStatus, explainFinding } from '../dist/core/preflight.js';
import { registerProject } from '../dist/core/projects.js';
import { testDb, tmpDir } from './helpers.ts';

const YEAR = 365 * 86_400_000;

function seed() {
  const dir = tmpDir('secondbrain-preflight-');
  const projectPath = path.join(dir, 'vera');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(tmpDir('secondbrain-preflight-db-'));
  const project = registerProject(db, projectPath).project;

  // A decision you rejected five months ago, with the reason you gave.
  addDecision(db, {
    projectId: project.id,
    text: 'rejected redis session caching because the write path bypasses the cache and users saw stale sessions',
    tags: ['caching', 'rejected'],
    ts: Date.now() - 5 * 30 * 86_400_000,
  });
  // A decision you accepted, further back.
  addDecision(db, {
    projectId: project.id,
    text: 'decided to keep postgres over mongodb because the reporting queries need joins',
    tags: ['database'],
    ts: Date.now() - 9 * 30 * 86_400_000,
  });
  // Something you tried and reverted in git.
  upsertCommit(db, {
    projectId: project.id,
    hash: 'e'.repeat(40),
    author: 'T',
    message: 'Revert "add redis caching layer for sessions"',
    filesChanged: 2,
    insertions: 5,
    deletions: 180,
    files: [
      { path: 'src/cache/session_cache.ts', add: 0, del: 150 },
      { path: 'src/auth/session.ts', add: 5, del: 30 },
    ],
    ts: Date.now() - 4 * 30 * 86_400_000,
  });
  return { db, project };
}

test('decisionStatus separates rejections from approvals', () => {
  assert.equal(decisionStatus('rejected redis because stale reads'), 'rejected');
  assert.equal(decisionStatus('decided to keep postgres because joins'), 'accepted');
  assert.equal(decisionStatus('switched to sqlite', ['reverted']), 'rejected');
  assert.equal(decisionStatus('tried redis and it did not work'), 'rejected');
});

test('checkProposal flags work you already rejected, with the original reason', () => {
  const { db } = seed();
  const result = checkProposal(db, 'add redis caching for the session lookup path');
  assert.equal(result.verdict, 'rejected-before');
  assert.ok(result.findings.length > 0);

  const decision = result.findings.find((finding) => finding.source === 'decision' && finding.status === 'rejected');
  assert.ok(decision, `expected the rejected decision: ${JSON.stringify(result.findings)}`);
  assert.match(decision?.reason ?? '', /write path bypasses the cache/);
  assert.match(explainFinding(decision as never), /caching\/perf|session|redis/);
  db.close();
});

test('checkProposal treats a git revert as evidence of something you tried', () => {
  const { db } = seed();
  // Phrase it so the wording overlaps the revert commit more than the decision.
  const result = checkProposal(db, 'add a redis caching layer');
  assert.ok(
    result.findings.some((finding) => finding.source === 'revert' && (finding.hash ?? '').startsWith('eeeeeee')),
    `expected the revert commit: ${JSON.stringify(result.findings.map((finding) => finding.source))}`,
  );
  db.close();
});

test('checkProposal reports an accepted decision as already decided', () => {
  const { db } = seed();
  const result = checkProposal(db, 'move the reporting queries to mongodb');
  assert.equal(result.verdict, 'decided-before');
  assert.ok(result.findings.some((finding) => finding.status === 'accepted'));
  db.close();
});

test('checkProposal stays quiet on an unrelated proposal', () => {
  const { db } = seed();
  const result = checkProposal(db, 'restyle the marketing landing page hero');
  assert.equal(result.verdict, 'clear');
  assert.deepEqual(result.findings, []);
  assert.ok(result.considered >= 3, 'it should have looked at the history');
  db.close();
});

test('checkProposal can be scoped to one project', () => {
  const { db, project } = seed();
  const otherPath = path.join(tmpDir('secondbrain-preflight-other-'), 'other');
  fs.mkdirSync(otherPath, { recursive: true });
  const other = registerProject(db, otherPath).project;
  addDecision(db, {
    projectId: other.id,
    text: 'rejected redis caching because our ops team does not run redis in production',
    ts: Date.now() - YEAR,
  });

  const all = checkProposal(db, 'add redis caching for sessions');
  assert.ok(all.findings.some((finding) => finding.projectName === 'other'), 'cross-project findings by default');

  const scoped = checkProposal(db, 'add redis caching for sessions', { projectId: other.id });
  assert.ok(scoped.findings.every((finding) => finding.projectId === other.id || finding.projectId === null));
  assert.ok(scoped.findings.some((finding) => finding.projectName === 'other'));
  assert.ok(!scoped.findings.some((finding) => finding.projectId === project.id));
  db.close();
});
