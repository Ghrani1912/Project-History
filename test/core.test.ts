import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { addDecision, countDecisions, parseDecisionText } from '../dist/core/decisions.js';
import { parseCommitFiles, serializeCommitFiles, upsertCommit } from '../dist/core/commits.js';
import { countEvents } from '../dist/core/events.js';
import { registerProject, resolveProjectForPath, ensureGlobalProject, listProjects } from '../dist/core/projects.js';
import { ask, rebuildIndex, toFtsQuery } from '../dist/core/recall.js';
import { buildTimeline, buildTimelineAscending } from '../dist/core/timeline.js';
import { makeIndexer, recordCommand, recordDecision, recordFileTouch, isNoteworthyCommand } from '../dist/capture/ingest.js';
import { createHashEmbedder } from '../dist/embeddings/embedder.js';
import { countEmbeddings } from '../dist/embeddings/store.js';
import {
  activityNarrative,
  aggregateChangedFiles,
  generateBrief,
  groupAreas,
  heuristicBrief,
  isVagueSubject,
  suggestDecisionsFromCommits,
} from '../dist/summarize/brief.js';
import { testDb, tmpDir } from './helpers.ts';

const embedder = createHashEmbedder(256);

test('schema is created and migrations are idempotent', () => {
  const dir = tmpDir();
  const db = testDb(dir);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((t) => t.name);
  for (const expected of ['projects', 'events', 'commits', 'chat_turns', 'decisions', 'briefs', 'embeddings', 'search_fts']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(version.value, '1');
  db.close();

  // Re-opening must not throw or duplicate tables.
  const again = testDb(dir);
  const count = again.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?').get('projects') as { n: number };
  assert.equal(count.n, 1);
  again.close();
});

test('registerProject resolves nested directories and refreshes on re-register', () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(path.join(projectPath, 'src', 'deep'), { recursive: true });
  const db = testDb(dir);

  const first = registerProject(db, projectPath, { ts: 1000 });
  assert.equal(first.created, true);
  assert.equal(first.project.name, 'project');

  const nested = resolveProjectForPath(db, path.join(projectPath, 'src', 'deep'));
  assert.equal(nested?.id, first.project.id);

  assert.equal(resolveProjectForPath(db, dir), null, 'parent directory is not part of the project');

  const second = registerProject(db, projectPath, { ts: 2000 });
  assert.equal(second.created, false);
  assert.equal(second.project.last_seen_at, 2000);
  db.close();
});

test('the global bucket is hidden from project listings', () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(dir);
  registerProject(db, projectPath);
  ensureGlobalProject(db);
  assert.equal(listProjects(db).length, 1);
  assert.equal(listProjects(db, true).length, 2);
  db.close();
});

test('recordCommand attributes events to the enclosing project with exit codes', async () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(dir);
  const project = registerProject(db, projectPath).project;
  const index = makeIndexer(db, embedder);

  const ok = await recordCommand(db, index, { cwd: projectPath, cmd: 'npm test', exitCode: 0, source: 'zsh' });
  assert.equal(ok.projectId, project.id);
  assert.equal(ok.indexed, true);

  const failed = await recordCommand(db, index, {
    cwd: projectPath,
    cmd: 'npm run build',
    exitCode: 2,
    source: 'zsh',
    ts: 5000,
  });
  assert.equal(failed.indexed, true, 'failing commands are always noteworthy');

  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(failed.eventId) as { exit_code: number; ts: number };
  assert.equal(row.exit_code, 2);
  assert.equal(row.ts, 5000);
  assert.equal(countEvents(db, project.id), 2);

  const outside = await recordCommand(db, index, { cwd: dir, cmd: 'echo hi', exitCode: 0, source: 'zsh' });
  assert.equal(outside.projectId, null);
  assert.equal(outside.indexed, false, 'trivial commands are not indexed');
  db.close();
});

test('isNoteworthyCommand filters navigation and our own CLI', () => {
  assert.equal(isNoteworthyCommand('ls'), false);
  assert.equal(isNoteworthyCommand('cd /tmp'), false);
  assert.equal(isNoteworthyCommand('brain ask "x"'), false);
  assert.equal(isNoteworthyCommand('ls | grep x'), true);
  assert.equal(isNoteworthyCommand('npm test'), true);
  assert.equal(isNoteworthyCommand('anything', 1), true);
});

test('parseDecisionText extracts #tags and cleans the sentence', () => {
  const parsed = parseDecisionText('decided to use SQLite over Postgres #storage #Architecture');
  assert.equal(parsed.text, 'decided to use SQLite over Postgres');
  assert.deepEqual(parsed.tags, ['storage', 'architecture']);
});

test('ask fuses lexical and vector recall and prefers the right answer', async () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(dir);
  const project = registerProject(db, projectPath).project;
  const index = makeIndexer(db, embedder);

  await recordDecision(db, index, {
    projectId: project.id,
    text: 'decided to use SQLite over Postgres because the dataset is tiny and local-first matters',
    ts: 1000,
  });
  await recordDecision(db, index, {
    projectId: project.id,
    text: 'decided to use Tailwind instead of hand-written CSS for speed',
    ts: 2000,
  });
  await recordCommand(db, index, { cwd: projectPath, cmd: 'sqlite3 db.sqlite ".tables"', exitCode: 0, source: 'bash' });

  const result = await ask(db, embedder, 'why did I choose sqlite over postgres', { projectId: project.id });
  assert.ok(result.hits.length > 0);
  assert.match(result.hits[0]?.text ?? '', /SQLite over Postgres/);
  assert.ok(result.hits[0]?.via.includes('lexical'));

  const empty = await ask(db, embedder, 'zzzzz-nothing-matches-this', { projectId: project.id });
  assert.equal(empty.hits.length, 0);
  db.close();
});

test('project-scoped ask still surfaces global decisions', async () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(dir);
  const project = registerProject(db, projectPath).project;
  const global = ensureGlobalProject(db);
  const index = makeIndexer(db, embedder);
  await recordDecision(db, index, {
    projectId: global.id,
    text: 'decided all repos use conventional commits',
    ts: 1000,
  });
  const result = await ask(db, embedder, 'conventional commits rule', { projectId: project.id });
  assert.ok(result.hits.some((hit) => hit.projectId === global.id));
  db.close();
});

test('toFtsQuery never emits raw FTS syntax', () => {
  assert.equal(toFtsQuery('   '), null);
  // Every token is quoted, so FTS operators in user input are inert.
  assert.equal(toFtsQuery('sqlite "OR" AND'), '"sqlite" OR "or" OR "and"');
});

test('timeline merges commits, decisions and events in timestamp order', async () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(dir);
  const project = registerProject(db, projectPath).project;
  const index = makeIndexer(db, embedder);

  upsertCommit(db, {
    projectId: project.id,
    hash: 'a'.repeat(40),
    author: 'Test',
    message: 'feat: first',
    filesChanged: 1,
    insertions: 10,
    deletions: 2,
    ts: 3000,
  });
  await recordDecision(db, index, { projectId: project.id, text: 'decided X because Y', ts: 1000 });
  await recordCommand(db, index, { cwd: projectPath, cmd: 'npm test', exitCode: 0, source: 'bash', ts: 2000 });
  recordFileTouch(db, { cwd: projectPath, path: 'src/a.ts', action: 'change', ts: 2500 });

  const timeline = buildTimeline(db, { projectId: project.id, limit: 20 });
  assert.deepEqual(
    timeline.map((entry) => entry.ts),
    [3000, 2500, 2000, 1000],
  );
  assert.deepEqual(timeline.map((entry) => entry.kind), ['commit', 'file', 'cmd', 'decision']);

  const ascending = buildTimelineAscending(db, { projectId: project.id, limit: 20 });
  assert.deepEqual(ascending.map((entry) => entry.ts), [1000, 2000, 2500, 3000]);

  const onlyCommits = buildTimeline(db, { projectId: project.id, kinds: ['commit'] });
  assert.equal(onlyCommits.length, 1);
  db.close();
});

test('heuristic brief reports failing commands and open threads', async () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(dir);
  const project = registerProject(db, projectPath).project;
  const index = makeIndexer(db, embedder);

  await recordCommand(db, index, { cwd: projectPath, cmd: 'npm run build', exitCode: 1, source: 'bash', ts: 1000 });
  await recordCommand(db, index, { cwd: projectPath, cmd: 'npm test', exitCode: 0, source: 'bash', ts: 2000 });
  await recordDecision(db, index, { projectId: project.id, text: 'decided to pin node 20', ts: 1500 });

  const brief = await generateBrief(db, DEFAULT_CONFIG, project, { heuristicOnly: true });
  assert.equal(brief.generator, 'heuristic');
  assert.match(brief.text, /where you left off/i);
  assert.match(brief.text, /## Open threads/);
  assert.match(brief.text, /npm run build/, 'failing command should be surfaced');
  assert.match(brief.text, /pinned? node 20|pin node 20/);

  const stored = db.prepare('SELECT COUNT(*) AS n FROM briefs WHERE project_id = ?').get(project.id) as { n: number };
  assert.equal(stored.n, 1);
  db.close();
});

test('heuristicBrief handles an empty project without crashing', () => {
  const text = heuristicBrief({
    project: {
      id: 1,
      name: 'empty',
      path: '/tmp/empty',
      created_at: 0,
      last_seen_at: null,
      git_remote: null,
      stack: null,
      summary: null,
      open_threads: null,
      ignored: 0,
    },
    generatedAt: 0,
    timeline: [],
    commits: [],
    decisions: [],
    recentCommands: [],
    touchedFiles: [],
    dirtyFiles: [],
    failingCommands: [],
    stack: [],
    testCommand: null,
    stats: { events: 0, commits: 0, chatTurns: 0, firstTs: null },
    watermark: 0,
  });
  assert.match(text, /No captured activity yet/);
});

test('parseCommitFiles reads the object shape and the legacy path array', () => {
  assert.deepEqual(parseCommitFiles(JSON.stringify([{ path: 'a.ts', add: 3, del: 1 }])), [
    { path: 'a.ts', add: 3, del: 1 },
  ]);
  // Rows written before per-file counts existed stored plain paths.
  assert.deepEqual(parseCommitFiles(JSON.stringify(['a.ts'])), [{ path: 'a.ts', add: 0, del: 0 }]);
  assert.deepEqual(parseCommitFiles(null), []);
  assert.deepEqual(parseCommitFiles('not json'), []);
  assert.deepEqual(parseCommitFiles(JSON.stringify([{ nope: 1 }, 42, null])), []);
});

test('serializeCommitFiles normalises paths and round-trips', () => {
  const json = serializeCommitFiles(['a.ts', { path: 'b.ts', add: 2, del: 5 }]);
  assert.deepEqual(parseCommitFiles(json), [
    { path: 'a.ts', add: 0, del: 0 },
    { path: 'b.ts', add: 2, del: 5 },
  ]);
  assert.equal(serializeCommitFiles([]), null);
  assert.equal(serializeCommitFiles(null), null);
});

test('groupAreas groups recent work by top-level directory', () => {
  const commits = [
    { files: JSON.stringify([{ path: 'backend/api/main.py', add: 10, del: 2 }]) },
    {
      files: JSON.stringify([
        { path: 'backend/realtime/streaming.py', add: 5, del: 5 },
        { path: 'README.md', add: 1, del: 0 },
      ]),
    },
    { files: JSON.stringify([{ path: 'dashboard/app.js', add: 3, del: 1 }]) },
  ];
  const areas = groupAreas(commits as never);
  assert.deepEqual(
    areas.map((area) => area.name),
    ['backend', 'dashboard', 'root files'],
  );
  assert.equal(areas[0]?.commits, 2, 'two commits touched backend');
  assert.equal(areas[0]?.files, 2, 'two distinct files under backend');
  assert.equal(areas[0]?.add, 15);
  assert.equal(areas[0]?.del, 7);
});

test('isVagueSubject flags subjects that describe nothing', () => {
  for (const vague of ['idk anymore', 'minor change', 'spectral', 'v3 model', 'WIP', '   ']) {
    assert.equal(isVagueSubject(vague), true, `expected "${vague}" to be vague`);
  }
  for (const clear of [
    'add retry with backoff to the deploy poller',
    'fix: stop dropping numstat lines on binary files',
  ]) {
    assert.equal(isVagueSubject(clear), false, `expected "${clear}" to be descriptive`);
  }
});

test('activityNarrative explains the last session in prose', () => {
  const commits = [
    {
      hash: 'a'.repeat(40),
      message: 'idk anymore',
      author: 'A',
      insertions: 40,
      deletions: 10,
      files_changed: 2,
      ts: 1_699_999_000_000,
      files: JSON.stringify([
        { path: 'backend/api/main.py', add: 30, del: 5 },
        { path: 'backend/realtime/streaming.py', add: 10, del: 5 },
      ]),
    },
    {
      hash: 'b'.repeat(40),
      message: 'minor change',
      author: 'A',
      insertions: 5,
      deletions: 1,
      files_changed: 1,
      ts: 1_699_900_000_000,
      files: JSON.stringify([{ path: 'dashboard/app.js', add: 5, del: 1 }]),
    },
  ] as never;
  const paragraphs = activityNarrative({
    project: { id: 1, name: 'threvia', path: '/tmp/threvia' },
    generatedAt: 1_700_000_000_000,
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
    stats: { events: 4, commits: 2, chatTurns: 0, firstTs: null },
    watermark: 0,
    changedFiles: aggregateChangedFiles(commits),
    areas: groupAreas(commits),
  } as never);
  const text = paragraphs.join('\n\n');
  assert.match(text, /You were last active/);
  assert.match(text, /backend\/api\/main\.py/, 'names the file the last commit touched');
  assert.match(text, /newest of 2 commits since/);
  assert.match(text, /Most of that went into \*\*backend\*\*/);
  assert.match(text, /commit messages are one-liners/, 'says why the brief is reconstructed');
  assert.match(text, /\*\*Pick up with:\*\*/);
});

test('heuristicBrief prints the narrative and per-commit line counts', async () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(dir);
  const project = registerProject(db, projectPath).project;
  upsertCommit(db, {
    projectId: project.id,
    hash: 'f'.repeat(40),
    author: 'Test',
    message: 'idk',
    filesChanged: 1,
    insertions: 12,
    deletions: 3,
    files: [{ path: 'src/a.ts', add: 12, del: 3 }],
    ts: Date.now() - 3 * 3600_000,
  });
  const brief = await generateBrief(db, DEFAULT_CONFIG, project, { heuristicOnly: true });
  assert.match(brief.text, /## Where you left off\nYou were last active/);
  assert.match(brief.text, /src\/a\.ts \+12\/-3/, 'the commits list shows what the commit changed');
  db.close();
});

test('commit messages that state a decision become suggestions', async () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(dir);
  const project = registerProject(db, projectPath).project;
  upsertCommit(db, {
    projectId: project.id,
    hash: 'b'.repeat(40),
    message: 'refactor: switched from moment to date-fns because bundle size',
    ts: 1000,
  });
  upsertCommit(db, { projectId: project.id, hash: 'c'.repeat(40), message: 'chore: bump deps', ts: 2000 });
  const suggestions = suggestDecisionsFromCommits(db, project.id);
  assert.equal(suggestions.length, 1);
  assert.match(suggestions[0] ?? '', /switched from moment/);
  db.close();
});

test('rebuildIndex re-embeds every indexed document', async () => {
  const dir = tmpDir();
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(dir);
  const project = registerProject(db, projectPath).project;
  const index = makeIndexer(db, embedder);
  await recordDecision(db, index, { projectId: project.id, text: 'decided A because B', ts: 1 });
  await recordDecision(db, index, { projectId: project.id, text: 'decided C because D', ts: 2 });
  assert.equal(countEmbeddings(db), 2);

  const result = await rebuildIndex(db, embedder);
  assert.equal(result.total, 2);
  assert.equal(result.embedded, 2);
  assert.equal(countEmbeddings(db), 2);

  const decisions = countDecisions(db, project.id);
  assert.equal(decisions, 2);
  db.close();
});

test('addDecision stores tags as a comma-separated list', () => {
  const dir = tmpDir();
  const db = testDb(dir);
  addDecision(db, { projectId: null, text: 'decided to cache aggressively #perf', tags: ['backend'], ts: 42 });
  const row = db.prepare('SELECT * FROM decisions').get() as { tags: string; ts: number };
  assert.equal(row.ts, 42);
  assert.equal(row.tags, 'backend,perf');
  db.close();
});
