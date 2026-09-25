import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { listCommits } from '../dist/core/commits.js';
import { registerProject } from '../dist/core/projects.js';
import { backfillHistory, git } from '../dist/git/git.js';
import { heuristicBrief } from '../dist/summarize/brief.js';
import { analyzeProjectState, projectStateNarrative } from '../dist/summarize/state.js';
import { hasGit, testDb, tmpDir } from './helpers.ts';

/**
 * A project shaped like a real one: it documents its own progress, keeps a
 * checklist of what is left, and has an unfinished marker in the code.
 */
function makeStateRepo(): string {
  const dir = tmpDir('secondbrain-state-');
  const write = (rel: string, text: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
  };

  write('README.md', '# Demo\n\nA demo service.\n');
  write(
    'PROJECT_STATUS.md',
    [
      '# Project status',
      '',
      '**Overall Project:** 100% Complete (all phases done, ready for deployment)',
      '**Remaining:** email alerts and scheduled retraining',
      '',
      '- [x] ingestion',
      '- [ ] email alerts',
      '- [ ] scheduled retraining',
      '',
    ].join('\n'),
  );
  write('src/detector.py', 'def detect(row):\n    # TODO: handle the cold-start case\n    return row\n');
  write('src/legacy.py', 'def old_thing():\n    return 1\n');
  return dir;
}

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'chore: initial'], { cwd: dir, stdio: 'ignore' });
}

function commitAll(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, stdio: 'ignore' });
}

/** A second session: a new module with its test, an untested module, and a tweak. */
function addSecondSession(dir: string): void {
  fs.writeFileSync(path.join(dir, 'src', 'online_learning.py'), 'def learn(rows):\n    return rows\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'test_online_learning.py'), 'def test_learn():\n    assert True\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'streamer.py'), 'def stream():\n    return []\n', 'utf8');
  fs.appendFileSync(path.join(dir, 'src', 'legacy.py'), '\ndef helper():\n    return 2\n');
  commitAll(dir, 'idk anymore');
}

test('analyzeProjectState reads the last session off git', { skip: !hasGit() }, async () => {
  const dir = makeStateRepo();
  initRepo(dir);
  addSecondSession(dir);

  const db = testDb(tmpDir());
  const project = registerProject(db, dir).project;
  await backfillHistory(db, project);
  const commits = listCommits(db, project.id, 20);
  const state = await analyzeProjectState(project, commits);

  assert.ok(state.session);
  assert.deepEqual(state.session?.added.slice().sort(), [
    'src/online_learning.py',
    'src/streamer.py',
    'src/test_online_learning.py',
  ]);
  assert.deepEqual(state.session?.modified, ['src/legacy.py']);
  assert.equal(state.session?.area, 'src');
  assert.equal(state.session?.addedWithTests, true, 'the new module shipped with a test');

  // Unfinished markers come from the code, not from the commit message.
  assert.ok(state.markers.some((marker) => marker.file === 'src/detector.py' && marker.kind === 'TODO'));

  // The repository's own progress claims and checklist.
  const status = state.statusDocs.find((doc) => doc.file === 'PROJECT_STATUS.md');
  assert.ok(status, 'the status document should be found');
  assert.ok(status?.claims.some((claim) => /100% Complete/.test(claim)));
  // The doc's claim is dated by the last commit that touched it.
  assert.equal(status?.lastTouchedHash, commits[commits.length - 1]?.hash);
  assert.ok((status?.lastTouchedTs ?? 0) > 0);
  const checklist = state.checklists.find((entry) => entry.file === 'PROJECT_STATUS.md');
  assert.equal(checklist?.open, 2);
  assert.equal(checklist?.done, 1);
  assert.equal(checklist?.kind, 'remaining', 'a status document lists remaining work');
  assert.match(checklist?.remaining[0] ?? '', /email alerts/);

  // Newly added code with no test anywhere is flagged; tested code is not, and
  // merely modified files are not mislabelled as untested modules.
  assert.deepEqual(state.untested, ['src/streamer.py']);
  db.close();
});

test('projectStateNarrative says whether work stopped finished or interrupted', { skip: !hasGit() }, async () => {
  const dir = makeStateRepo();
  initRepo(dir);
  addSecondSession(dir);
  // Leave something uncommitted so "work in progress" is visible too.
  fs.appendFileSync(path.join(dir, 'README.md'), '\nhalf-written paragraph\n');

  const db = testDb(tmpDir());
  const project = registerProject(db, dir).project;
  await backfillHistory(db, project);
  const state = await analyzeProjectState(project, listCommits(db, project.id, 20));
  const prose = projectStateNarrative(state, {
    generatedAt: Date.now(),
    projectName: project.name,
    dirtyFiles: [' M README.md'],
    totalCommits: 2,
    events: 0,
  }).join('\n\n');

  assert.match(prose, /created 3 new files/, 'names what the last session added');
  assert.match(prose, /test landed together/, 'says whether it looks finished');
  assert.match(prose, /100% Complete/, 'quotes what the repo claims about progress');
  assert.match(prose, /\*\*2 unchecked backlog items\*\*/, 'counts the open checklist items');
  assert.match(prose, /documentation says the planned work is finished/, 'reconciles claims with what is left');
  assert.match(prose, /uncommitted/, 'flags work in progress on disk');
  assert.match(prose, /\*\*The likely next step:\*\*/, 'ends with a concrete next task');
  db.close();
});

test('heuristicBrief leads with where the project stands', { skip: !hasGit() }, async () => {
  const dir = makeStateRepo();
  initRepo(dir);
  const db = testDb(tmpDir());
  const project = registerProject(db, dir).project;
  await backfillHistory(db, project);
  const commits = listCommits(db, project.id, 20);
  const state = await analyzeProjectState(project, commits);

  const text = heuristicBrief({
    project,
    generatedAt: Date.now(),
    timeline: [],
    commits,
    decisions: [],
    recentCommands: [],
    recentChat: [],
    touchedFiles: [],
    dirtyFiles: [],
    failingCommands: [],
    stack: [],
    testCommand: null,
    stats: { events: 0, commits: commits.length, chatTurns: 0, firstTs: null },
    watermark: 0,
    state,
  } as never);

  assert.match(text, /## Where the project stands/);
  assert.match(text, /## Where you left off/);
  assert.ok(
    text.indexOf('## Where the project stands') < text.indexOf('## Where you left off'),
    'the state section must come first',
  );
  assert.match(text, /email alerts/);
  db.close();
});

test('analyzeProjectState survives a project with no commits', async () => {
  const dir = makeStateRepo();
  const db = testDb(tmpDir());
  const project = registerProject(db, dir).project;
  const state = await analyzeProjectState(project, []);
  assert.equal(state.session, null);
  assert.ok(state.checklists.length > 0, 'checklists are found without any git history');
  const prose = projectStateNarrative(state, {
    generatedAt: Date.now(),
    projectName: project.name,
    dirtyFiles: [],
    totalCommits: 0,
    events: 0,
  });
  assert.ok(prose.length > 0);
  db.close();
});

test('analyzeProjectState is quiet on a directory that is not a repo', async () => {
  const dir = tmpDir('secondbrain-plain-');
  fs.writeFileSync(path.join(dir, 'notes.md'), '# notes\n\nnothing to see\n', 'utf8');
  const db = testDb(tmpDir());
  const project = registerProject(db, dir).project;
  const state = await analyzeProjectState(project, []);
  assert.equal(state.session, null);
  assert.deepEqual(state.markers, []);
  assert.equal((await git(['--version'], dir)).code, 0);
  db.close();
});
