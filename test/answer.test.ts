import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { answerQuestion } from '../dist/core/answer.js';
import { upsertCommit } from '../dist/core/commits.js';
import { addDecision } from '../dist/core/decisions.js';
import { insertEvent } from '../dist/core/events.js';
import { getProject, registerProject, setProjectMeta } from '../dist/core/projects.js';
import type { BrainConfig } from '../dist/config.js';
import type { SearchHit } from '../dist/core/types.js';
import { testDb, tmpDir } from './helpers.ts';

/** The LLM is disabled for these: the deterministic answerer must stand alone. */
const NO_LLM = {
  llm: { provider: 'none', model: 'none', ollamaUrl: 'http://127.0.0.1:1', timeoutMs: 100 },
} as unknown as BrainConfig;

function seed(): { db: ReturnType<typeof testDb>; projectId: number; projectPath: string } {
  const dir = tmpDir('secondbrain-answer-');
  const projectPath = path.join(dir, 'app');
  fs.mkdirSync(projectPath, { recursive: true });
  const db = testDb(tmpDir('secondbrain-answer-db-'));
  const project = registerProject(db, projectPath).project;
  return { db, projectId: project.id, projectPath };
}

test('a question about the workspace is answered from the stored overview', async () => {
  const { db, projectId } = seed();
  const summary = 'Threvia watches security logs and flags coordinated attacks.';
  setProjectMeta(db, projectId, { summary });
  addDecision(db, {
    projectId,
    text: 'rejected redis caching because the sqlite session cache is already fast enough',
  });

  const project = getProject(db, projectId);
  assert.ok(project);
  const answer = await answerQuestion(db, NO_LLM, { query: 'what does this project do?', project, hits: [] });

  assert.equal(answer.generator, 'stored-overview');
  assert.ok(answer.text.startsWith(summary), 'the overview is the answer, not a hit list');
  assert.match(answer.text, /on record there are/);
  assert.ok(answer.text.includes('1 decision'), 'it reports what is on record');
  // It must read as prose a person could have written, not a report with headings.
  assert.ok(!answer.text.includes('## '), 'no section headings');
  assert.ok(!answer.text.startsWith('- '), 'no raw bullet dumps');
  assert.equal(answer.llm.used, false);
  assert.equal(answer.partial, true);
  db.close();
});

test('an unrelated question falls back to the newest evidence and cites it', async () => {
  const { db, projectId } = seed();
  const project = getProject(db, projectId);
  assert.ok(project);
  const hits: SearchHit[] = [
    {
      ownerType: 'commit',
      ownerId: 1,
      projectId,
      projectName: project.name,
      ts: Date.now() - 86_400_000,
      text: 'feat: add the ingestion pipeline',
      score: 0.9,
      via: ['lexical'],
    },
    {
      ownerType: 'decision',
      ownerId: 2,
      projectId,
      projectName: project.name,
      ts: Date.now(),
      text: 'picked sqlite over postgres',
      score: 0.5,
      via: ['vector'],
    },
  ];

  const answer = await answerQuestion(db, NO_LLM, { query: 'how is ingestion wired up?', project, hits });

  assert.equal(answer.generator, 'captured-history');
  assert.match(answer.text, /the clearest thing on record/);
  assert.equal(answer.sources.length, 2);
  assert.equal(answer.sources[0]?.kind, 'commit');
  assert.match(answer.sources[0]?.snippet ?? '', /ingestion pipeline/);
  // It says it could not really answer, rather than pretending.
  assert.equal(answer.partial, true);
  db.close();
});

test('an out-of-scope question is refused, not answered from the nearest passage', async () => {
  const { db, projectId } = seed();
  const project = getProject(db, projectId);
  assert.ok(project);
  // Retrieval always returns *something*; weak means none of it really matched.
  const hits: SearchHit[] = [
    {
      ownerType: 'commit',
      ownerId: 9,
      projectId,
      projectName: project.name,
      ts: Date.now(),
      text: 'cleanup: remove temporary fix scripts',
      score: 0.1,
      via: ['vector'],
    },
  ];

  const answer = await answerQuestion(db, NO_LLM, {
    query: 'what is the wifi password?',
    project,
    hits,
    weak: true,
  });

  assert.match(answer.text, /Nothing in the recorded history/);
  assert.ok(!answer.text.includes('temporary fix scripts'), 'it must not answer from an unrelated passage');
  assert.equal(answer.llm.used, false);
  assert.match(answer.llm.reason ?? '', /did not match any recorded history/);
  db.close();
});

test('a negative premise with no failure on record is refused, not diagnosed', async () => {
  const { db, projectId } = seed();
  const project = getProject(db, projectId);
  assert.ok(project);

  const answer = await answerQuestion(db, NO_LLM, {
    query: 'why is the build failing?',
    project,
    hits: [],
  });

  assert.equal(answer.generator, 'insufficient-evidence');
  assert.equal(answer.llm.used, false);
  assert.equal(answer.partial, true);
  assert.match(answer.text, /shows a failure/);
  assert.match(answer.llm.reason ?? '', /no failed command/);
  db.close();
});

test('a negative premise is answered once the record contains a failed command', async () => {
  const { db, projectId } = seed();
  insertEvent(db, {
    projectId,
    type: 'cmd',
    payload: { cmd: 'npm test' },
    exitCode: 1,
    source: 'shell',
  });
  const project = getProject(db, projectId);
  assert.ok(project);

  const answer = await answerQuestion(db, NO_LLM, {
    query: 'why is the build failing?',
    project,
    hits: [],
  });

  assert.notEqual(answer.generator, 'insufficient-evidence');
  assert.doesNotMatch(answer.text, /shows a failure/);
  db.close();
});

test('a revert on record also satisfies the negative-premise guard', async () => {
  const { db, projectId } = seed();
  upsertCommit(db, {
    projectId,
    hash: 'a'.repeat(40),
    message: 'Revert "switch the queue to redis"',
    ts: Date.now(),
  });
  const project = getProject(db, projectId);
  assert.ok(project);

  const answer = await answerQuestion(db, NO_LLM, {
    query: 'why is this broken?',
    project,
    hits: [],
  });

  assert.notEqual(answer.generator, 'insufficient-evidence');
  db.close();
});

test('an architecture question is refused when retrieval is too thin to ground it', async () => {
  const { db, projectId } = seed();
  const project = getProject(db, projectId);
  assert.ok(project);
  const hits: SearchHit[] = [
    {
      ownerType: 'commit',
      ownerId: 1,
      projectId,
      projectName: project.name,
      ts: Date.now(),
      text: 'cleanup: rename local variables',
      score: 0.004,
      via: ['vector'],
    },
  ];

  const answer = await answerQuestion(db, NO_LLM, {
    query: 'how is the sync engine architected?',
    project,
    hits,
  });

  assert.equal(answer.generator, 'insufficient-evidence');
  assert.match(answer.text, /firmer match/);
  assert.match(answer.llm.reason ?? '', /retrieval score/);
  db.close();
});

test('a well-retrieved architecture question is allowed through', async () => {
  const { db, projectId } = seed();
  const project = getProject(db, projectId);
  assert.ok(project);
  const hits: SearchHit[] = [
    {
      ownerType: 'commit',
      ownerId: 1,
      projectId,
      projectName: project.name,
      ts: Date.now(),
      text: 'feat: sync engine drains a durable write-ahead queue',
      score: 0.9,
      via: ['lexical', 'vector'],
    },
  ];

  const answer = await answerQuestion(db, NO_LLM, {
    query: 'how is the sync engine architected?',
    project,
    hits,
  });

  assert.notEqual(answer.generator, 'insufficient-evidence');
  db.close();
});
