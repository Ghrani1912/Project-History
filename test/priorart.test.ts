import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { upsertCommit } from '../dist/core/commits.js';
import {
  capabilitiesOf,
  collectSolvedWork,
  crossProjectLinks,
  explainMatch,
  findPriorArt,
  pathRoles,
  projectFocus,
} from '../dist/core/priorart.js';
import { registerProject } from '../dist/core/projects.js';
import { testDb, tmpDir } from './helpers.ts';

/**
 * Two projects with overlapping *shapes* but different names, languages and
 * layouts: exactly the case where text search inside one repo finds nothing.
 */
function seed(): { db: ReturnType<typeof testDb>; veraId: number; threviaId: number } {
  const dir = tmpDir('secondbrain-priorart-');
  const veraPath = path.join(dir, 'vera');
  const threviaPath = path.join(dir, 'threvia');
  fs.mkdirSync(veraPath, { recursive: true });
  fs.mkdirSync(threviaPath, { recursive: true });
  const db = testDb(tmpDir('secondbrain-priorart-db-'));
  const vera = registerProject(db, veraPath).project;
  const threvia = registerProject(db, threviaPath).project;

  upsertCommit(db, {
    projectId: vera.id,
    hash: 'a'.repeat(40),
    author: 'T',
    message: 'add JWT refresh and session revocation',
    filesChanged: 3,
    insertions: 395,
    deletions: 52,
    files: [
      { path: 'src/auth/session.ts', add: 180, del: 12 },
      { path: 'src/auth/login.ts', add: 95, del: 40 },
      { path: 'tests/session.test.ts', add: 120, del: 0 },
    ],
    ts: 1_700_000_000_000,
  });
  upsertCommit(db, {
    projectId: threvia.id,
    hash: 'b'.repeat(40),
    author: 'T',
    message: 'ldap auth login middleware',
    filesChanged: 2,
    insertions: 210,
    deletions: 8,
    files: [
      { path: 'backend/api/auth/login.py', add: 150, del: 8 },
      { path: 'backend/api/auth/session.py', add: 60, del: 0 },
    ],
    ts: 1_700_100_000_000,
  });
  upsertCommit(db, {
    projectId: threvia.id,
    hash: 'c'.repeat(40),
    author: 'T',
    message: 'csv ingestion pipeline for hadoop',
    filesChanged: 1,
    insertions: 300,
    deletions: 2,
    files: [{ path: 'backend/processing/csv_ingest.py', add: 300, del: 2 }],
    ts: 1_700_200_000_000,
  });
  return { db, veraId: vera.id, threviaId: threvia.id };
}

test('pathRoles keeps what a file does and drops boilerplate', () => {
  assert.deepEqual(pathRoles('src/auth/login_handler.ts'), ['auth', 'login']);
  assert.deepEqual(pathRoles('src/index.ts'), []);
  // Stack words like "csv" are not roles: they say what the data is, not what
  // the file does, and they appear in half of all repositories.
  assert.deepEqual(pathRoles('backend/processing/csv_ingest.py'), ['processing', 'ingest']);
});

test('capabilitiesOf recognises a problem shape from a sentence and its files', () => {
  const tags = capabilitiesOf('wire up login', ['src/auth/session.ts']);
  assert.ok(tags.includes('auth/session'), `expected auth/session in ${tags}`);
  const dbTags = capabilitiesOf('add a migration for the users table', ['db/migration.sql']);
  assert.ok(dbTags.includes('database/schema'), `expected database/schema in ${dbTags}`);
});

test('findPriorArt finds the same problem solved in another project', () => {
  const { db, veraId } = seed();
  const scoped = findPriorArt(db, 'add token refresh to the login session', {
    capabilities: ['auth/session'],
    roles: ['auth', 'login', 'session'],
    excludeProjectIds: [veraId],
  });
  // The project you are working in never answers its own question.
  assert.ok(
    scoped.matches.every((match) => match.projectName !== 'vera'),
    `excluded project leaked in: ${scoped.matches.map((match) => match.projectName)}`,
  );

  const crossProject = findPriorArt(db, 'add token refresh to the login session', {
    capabilities: ['auth/session'],
    roles: ['auth', 'login', 'session'],
  });
  assert.ok(crossProject.matches.length > 0, 'a cross-project match should exist');
  const best = crossProject.matches[0];
  assert.equal(best?.projectName, 'vera');
  assert.equal(best?.hash, 'a'.repeat(40));
  assert.ok(best?.sharedCapabilities.includes('auth/session'));
  assert.ok((best?.sharedRoles ?? []).includes('login') || (best?.sharedRoles ?? []).includes('auth'));
  assert.match(explainMatch(best as never), /auth\/session/);
  assert.equal(crossProject.projectsSearched, 2);
  db.close();
});

test('findPriorArt rejects unrelated work instead of guessing', () => {
  const { db } = seed();
  const result = findPriorArt(db, 'polish the css of the settings screen');
  assert.deepEqual(result.matches, []);
  db.close();
});

test('shared generic tags alone are never a match', () => {
  const dir = tmpDir('secondbrain-priorart-generic-');
  const db = testDb(tmpDir('secondbrain-priorart-generic-db-'));
  fs.mkdirSync(path.join(dir, 'one'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'two'), { recursive: true });
  const one = registerProject(db, path.join(dir, 'one')).project;
  const two = registerProject(db, path.join(dir, 'two')).project;
  for (const project of [one, two]) {
    upsertCommit(db, {
      projectId: project.id,
      hash: `${project.id}`.repeat(40).slice(0, 40),
      message: 'tidy up the api endpoints and tests',
      filesChanged: 2,
      insertions: 10,
      deletions: 4,
      files: [
        { path: 'src/api/routes.ts', add: 8, del: 4 },
        { path: 'tests/routes.test.ts', add: 2, del: 0 },
      ],
      ts: 1_700_000_000_000,
    });
  }
  // api/endpoints and testing are true of nearly every commit: no evidence.
  const result = findPriorArt(db, 'tidy up the api endpoints and tests');
  assert.deepEqual(result.matches, []);
  assert.ok(result.bestCandidateWeight > 0, 'the candidate was scored, just not shown');
  db.close();
});

test('findPriorArt ranks the closest of several candidates first', () => {
  const { db } = seed();
  const result = findPriorArt(db, 'csv ingestion pipeline dataset import', {
    capabilities: ['data/ingestion'],
    roles: ['csv', 'ingest', 'pipeline'],
    limit: 5,
  });
  assert.ok(result.matches.length > 0);
  assert.equal(result.matches[0]?.projectName, 'threvia');
  assert.equal(result.matches[0]?.hash, 'c'.repeat(40));
  db.close();
});

test('collectSolvedWork and projectFocus describe the work structurally', () => {
  const { db, threviaId } = seed();
  const units = collectSolvedWork(db);
  assert.equal(units.length, 3);
  const focus = projectFocus(db, threviaId);
  assert.ok(focus.capabilities.includes('auth/session'));
  assert.ok(focus.capabilities.includes('data/ingestion'));
  assert.ok(focus.roles.includes('login'));
  db.close();
});

test('crossProjectLinks pairs every project with the work it can borrow', () => {
  const { db } = seed();
  const links = crossProjectLinks(db);
  const fromThrevia = links.find((link) => link.fromProjectName === 'threvia');
  const fromVera = links.find((link) => link.fromProjectName === 'vera');
  assert.ok(fromThrevia, `expected threvia to point somewhere: ${JSON.stringify(links.map((l) => l.fromProjectName))}`);
  assert.equal(fromThrevia?.toProjectName, 'vera');
  assert.equal(fromThrevia?.matches[0]?.hash, 'a'.repeat(40));
  assert.equal(fromVera?.toProjectName, 'threvia');
  db.close();
});

test('crossProjectLinks is empty for a single project with no history', () => {
  const dir = tmpDir('secondbrain-priorart-empty-');
  fs.mkdirSync(path.join(dir, 'solo'), { recursive: true });
  const db = testDb(tmpDir('secondbrain-priorart-empty-db-'));
  registerProject(db, path.join(dir, 'solo'));
  assert.deepEqual(crossProjectLinks(db), []);
  db.close();
});
