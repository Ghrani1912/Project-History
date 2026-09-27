import assert from 'node:assert/strict';
import test from 'node:test';
import { makeIndexer, recordCommand } from '../dist/capture/ingest.js';
import { addDecision } from '../dist/core/decisions.js';
import {
  detectContradictions,
  dismissContradiction,
  listContradictions,
  persistContradictions,
} from '../dist/core/contradictions.js';
import { countOpenFailures, listFailures } from '../dist/core/errors.js';
import { registerProject } from '../dist/core/projects.js';
import { pruneSelfLog, recordSelfInvocation, shouldSelfLog } from '../dist/core/selflog.js';
import { testDb, tmpDir } from './helpers.ts';

function projectDb(): { db: ReturnType<typeof testDb>; projectId: number; dir: string } {
  const dir = tmpDir('secondbrain-hygiene-proj-');
  const db = testDb(tmpDir('secondbrain-hygiene-db-'));
  const { project } = registerProject(db, dir);
  return { db, projectId: project.id, dir };
}

test('a failed command with output becomes its own error event, linked to its fix', async () => {
  const { db, projectId, dir } = projectDb();
  const index = makeIndexer(db, null);
  const t0 = Date.now() - 60_000;

  await recordCommand(db, index, {
    cwd: dir,
    cmd: 'npm test',
    exitCode: 1,
    output: 'TypeError: x is not a function\n    at foo.js:1',
    source: 'test',
    ts: t0,
  });
  await recordCommand(db, index, { cwd: dir, cmd: 'npm test', exitCode: 0, source: 'test', ts: t0 + 30_000 });

  const types = (db.prepare('SELECT type FROM events ORDER BY ts').all() as Array<{ type: string }>).map(
    (row) => row.type,
  );
  assert.deepEqual(types, ['error', 'cmd'], 'the failure is a different event class from a plain command');

  const failures = listFailures(db, { projectId });
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.exitCode, 1);
  assert.match(failures[0]?.output ?? '', /TypeError/);
  assert.ok(failures[0]?.fixedAt, 'the later successful re-run is found as the fix');

  // The error text is indexed, which is what makes the lookup actually work.
  const doc = db
    .prepare("SELECT text FROM search_docs WHERE owner_type = 'event' ORDER BY id LIMIT 1")
    .get() as { text: string };
  assert.match(doc.text, /TypeError/);
  assert.match(doc.text, /npm test/);

  assert.equal(listFailures(db, { projectId, openOnly: true }).length, 0, 'a fixed failure is not open');
  db.close();
});

test('an unresolved failure stays open', async () => {
  const { db, projectId, dir } = projectDb();
  const index = makeIndexer(db, null);
  await recordCommand(db, index, {
    cwd: dir,
    cmd: 'cargo build',
    exitCode: 101,
    output: 'error[E0425]: cannot find value `bar` in this scope',
    source: 'test',
  });
  const open = listFailures(db, { projectId, openOnly: true });
  assert.equal(open.length, 1);
  assert.equal(open[0]?.fixedAt, null);
  db.close();
});

test("the tool's own bookkeeping commands are never reported as failures", async () => {
  const { db, projectId, dir } = projectDb();
  const index = makeIndexer(db, null);

  // Self-logging records the tool's own invocations — including one that failed
  // while the feature was being exercised. That is bookkeeping, not this
  // project's broken run, so it must not read as an open failure.
  recordSelfInvocation(db, { args: ['connect', 'demo', 'C:/nope'], cwd: dir, exitCode: 1 });
  // A failure the user actually hit, by contrast, stays open.
  await recordCommand(db, index, { cwd: dir, cmd: 'npm test', exitCode: 1, output: 'boom', source: 'hook' });

  const logged = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'self' AND exit_code != 0")
    .get() as { n: number };
  assert.equal(logged.n, 1, 'the invocation is still recorded — only the report filters it');

  const open = listFailures(db, { openOnly: true });
  assert.equal(open.length, 1, 'only the real failure is listed');
  assert.match(open[0]?.cmd ?? '', /npm test/);
  assert.equal(open[0]?.projectId, projectId);
  assert.equal(countOpenFailures(db), 1);
  db.close();
});

test('pruning removes the failed bookkeeping rows and keeps the dogfooding trail', async () => {
  const { db, projectId, dir } = projectDb();
  const index = makeIndexer(db, null);
  recordSelfInvocation(db, { args: ['connect', 'demo', 'C:/nope'], cwd: dir, exitCode: 1 });
  recordSelfInvocation(db, { args: ['ask', 'what did i do'], cwd: dir, exitCode: 0 });
  await recordCommand(db, index, { cwd: dir, cmd: 'npm test', exitCode: 1, output: 'boom', source: 'hook' });

  // The default prune takes only what failure reports already ignore.
  assert.deepEqual(pruneSelfLog(db), { removed: 1, failed: 1, succeeded: 0 });
  const left = db.prepare("SELECT exit_code FROM events WHERE source = 'self'").all() as Array<{
    exit_code: number | null;
  }>;
  assert.equal(left.length, 1, 'the successful invocation is still on record');
  assert.equal(left[0]?.exit_code, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 2);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(projectId) as { n: number }).n,
    1,
    'the project row is untouched — only events were pruned',
  );

  // Losing the trail takes asking for it.
  assert.deepEqual(pruneSelfLog(db, { all: true }), { removed: 1, failed: 0, succeeded: 1 });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'self'").get() as { n: number }).n, 0);
  assert.deepEqual(pruneSelfLog(db), { removed: 0, failed: 0, succeeded: 0 }, 'pruning twice is harmless');
  db.close();
});

test('conflicting accepted decisions in one project are flagged', () => {
  const { db, projectId } = projectDb();
  addDecision(db, { projectId, text: 'we use sqlite for the local storage layer' });
  addDecision(db, { projectId, text: 'we use postgres for the storage layer' });
  // A rejected option is not a contradiction — it is an answer already given.
  addDecision(db, { projectId, text: 'rejected mysql for the storage layer because it is heavy' });

  const found = detectContradictions(db, { projectId });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.category, 'database');
  assert.deepEqual([found[0]?.choiceA, found[0]?.choiceB].sort(), ['postgres', 'sqlite']);
  assert.match(found[0]?.reason ?? '', /database/);

  assert.equal(persistContradictions(db, found), 1);
  assert.equal(persistContradictions(db, found), 0, 'the same pair is not stored twice');
  const stored = listContradictions(db, projectId);
  assert.equal(stored.length, 1);
  assert.match(stored[0]?.a.text ?? '', /(sqlite|postgres)/);

  assert.equal(dismissContradiction(db, stored[0]?.id ?? 0), true);
  assert.equal(listContradictions(db, projectId).length, 0);
  db.close();
});

test('decisions that agree are not flagged', () => {
  const { db, projectId } = projectDb();
  addDecision(db, { projectId, text: 'we use sqlite for the storage layer' });
  addDecision(db, { projectId, text: 'sqlite remains the storage layer' });
  assert.equal(detectContradictions(db, { projectId }).length, 0);
  db.close();
});

test('self-logging records invocations but skips bookkeeping', () => {
  const { db, projectId, dir } = projectDb();

  assert.equal(shouldSelfLog(['status']), true);
  assert.equal(shouldSelfLog(['ask', 'what did i do']), true);
  assert.equal(shouldSelfLog(['hook', 'line', 'SB1']), false);
  assert.equal(shouldSelfLog(['self', 'on']), false);
  assert.equal(shouldSelfLog(['run', 'npm test']), false, 'brain run already records what it ran');
  assert.equal(shouldSelfLog(['brief', '--auto', '--cwd', dir]), false);
  assert.equal(shouldSelfLog([]), false);

  const id = recordSelfInvocation(db, { args: ['ask', 'what did i do'], cwd: dir, exitCode: 0 });
  assert.ok(id);
  const row = db.prepare("SELECT * FROM events WHERE source = 'self'").get() as {
    project_id: number | null;
    payload: string;
  };
  assert.equal(row.project_id, projectId);
  assert.match(row.payload, /brain ask what did i do/);
  assert.equal(recordSelfInvocation(db, { args: ['hook', 'line', 'x'], cwd: dir }), null);
  db.close();
});
