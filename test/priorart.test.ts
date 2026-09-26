import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { upsertCommit } from '../dist/core/commits.js';
import {
  capabilitiesOf,
  collectSolvedWork,
  crossProjectLinks,
  explainConcept,
  explainFile,
  explainMatch,
  explainProjectMatch,
  findPriorArt,
  findRelatedProjects,
  pathRoles,
  projectFocus,
} from '../dist/core/priorart.js';
import { upsertSearchDoc } from '../dist/core/indexing.js';
import { registerProject } from '../dist/core/projects.js';
import { testDb, tmpDir } from './helpers.ts';

/** A stored project overview document in the shape register/refresh writes it. */
function overviewDoc(name: string, readme: string): string {
  return [
    `Project "${name}" (project overview, README, stack, layout)`,
    `path: /tmp/${name}`,
    `summary: ${name} summary`,
    'languages: Markdown (1 files)',
    'layout: README.md',
    'recent commits: none',
    'README:',
    `# ${name}`,
    readme,
  ].join('\n');
}

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

test('findRelatedProjects pairs similar READMEs even with zero commits', () => {
  const dir = tmpDir('secondbrain-related-docs-');
  fs.mkdirSync(path.join(dir, 'fraudlens'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'threvia'), { recursive: true });
  const db = testDb(tmpDir('secondbrain-related-docs-db-'));
  const fraud = registerProject(db, path.join(dir, 'fraudlens')).project;
  const threat = registerProject(db, path.join(dir, 'threvia')).project;
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: fraud.id,
    projectId: fraud.id,
    ts: 1_700_000_000_000,
    text: overviewDoc(
      'fraudlens',
      'A platform for detecting fraudulent transactions with graph analysis of laundering rings, ML classification of card fraud, a bloom filter for blacklist lookups and distributed storage of transaction data.',
    ),
  });
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: threat.id,
    projectId: threat.id,
    ts: 1_700_000_000_000,
    text: overviewDoc(
      'threvia',
      'A platform for recognising threats with graph analysis of attack networks, ML classification of malicious traffic, a bloom filter for indicator lookups and distributed storage of event data.',
    ),
  });
  const result = findRelatedProjects(db, fraud.id);
  assert.ok(result.matches.length > 0, 'a document-level match should exist without any commits');
  const best = result.matches[0];
  assert.equal(best?.projectName, 'threvia');
  assert.equal(best?.commits, 0);
  assert.ok(
    (best?.sharedCapabilities.length ?? 0) > 0,
    `expected a shared capability: ${JSON.stringify(best?.sharedCapabilities)}`,
  );
  assert.match(explainProjectMatch(best as never), /same kind of project/);
  // Never suggests the project you are looking at.
  assert.ok(result.matches.every((match) => match.projectId !== fraud.id));
  db.close();
});

test('findRelatedProjects names the concepts and the file they live in over there', () => {
  const dir = tmpDir('secondbrain-related-concepts-');
  fs.mkdirSync(path.join(dir, 'fraudlens'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'threvia'), { recursive: true });
  const db = testDb(tmpDir('secondbrain-related-concepts-db-'));
  const fraud = registerProject(db, path.join(dir, 'fraudlens')).project;
  const threat = registerProject(db, path.join(dir, 'threvia')).project;
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: fraud.id,
    projectId: fraud.id,
    ts: 1_700_000_000_000,
    text: overviewDoc(
      'fraudlens',
      'Fraud analytics with graph analysis of laundering rings, ML classification of card fraud, a bloom filter for blacklist lookups and a configurable detection threshold.',
    ),
  });
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: threat.id,
    projectId: threat.id,
    ts: 1_700_000_000_000,
    text: overviewDoc(
      'threvia',
      'Threat analytics with graph analysis of attack networks and detection of malicious traffic.',
    ),
  });
  // The other side's *code* is what the concepts are pointed at.
  upsertCommit(db, {
    projectId: threat.id,
    hash: 'e'.repeat(40),
    message: 'tune the detection threshold',
    filesChanged: 3,
    insertions: 40,
    deletions: 5,
    files: [
      { path: 'backend/graph/graph_analytics.py', add: 20, del: 1 },
      { path: 'backend/ml/train_bot_classifier.py', add: 15, del: 4 },
      { path: 'backend/realtime/streaming_detector.py', add: 5, del: 0 },
    ],
    ts: 1_700_100_000_000,
  });
  const result = findRelatedProjects(db, fraud.id);
  const best = result.matches[0];
  assert.ok(best, 'expected a related project');
  const concepts = best?.sharedConcepts ?? [];
  // Adjacent ideas from one file are read back as one phrase, and the phrase is
  // pointed at the actual file rather than at a capability tag.
  const graph = concepts.find((concept) => concept.file === 'backend/graph/graph_analytics.py');
  assert.ok(graph, `expected a concept in graph_analytics.py: ${JSON.stringify(concepts)}`);
  assert.equal(graph?.source, 'code');
  assert.match(graph?.term ?? '', /graph/);
  // Morphology is handled: classification lives in the classifier.
  const classifier = concepts.find((concept) => concept.file === 'backend/ml/train_bot_classifier.py');
  assert.ok(classifier, `expected a concept in the classifier: ${JSON.stringify(concepts)}`);
  assert.match(explainConcept(graph as never), /graph_analytics\.py/);
  assert.match(explainProjectMatch(best as never), /same ground:/);
  db.close();
});

test('findRelatedProjects falls back to the other project README when it has no commits', () => {
  const dir = tmpDir('secondbrain-related-readme-');
  fs.mkdirSync(path.join(dir, 'fraudlens'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'threvia'), { recursive: true });
  const db = testDb(tmpDir('secondbrain-related-readme-db-'));
  const fraud = registerProject(db, path.join(dir, 'fraudlens')).project;
  const threat = registerProject(db, path.join(dir, 'threvia')).project;
  // Both documents share the word "recognition" and neither side has commits.
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: fraud.id,
    projectId: fraud.id,
    ts: 1_700_000_000_000,
    text: overviewDoc('fraudlens', 'Fraud recognition with graph analysis of laundering rings.'),
  });
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: threat.id,
    projectId: threat.id,
    ts: 1_700_000_000_000,
    text: overviewDoc('threvia', 'Threat recognition with graph analysis of attack networks.'),
  });
  const best = findRelatedProjects(db, fraud.id).matches[0];
  assert.ok(best, 'expected a related project');
  assert.ok((best?.sharedConcepts.length ?? 0) > 0, 'expected shared concepts');
  assert.ok(best?.sharedConcepts.every((concept) => concept.source === 'doc'));
  assert.ok(best?.sharedConcepts.every((concept) => concept.file === 'README.md'));
  db.close();
});

test('findRelatedProjects states the relation in prose and quotes your own words', () => {
  const dir = tmpDir('secondbrain-related-prose-');
  fs.mkdirSync(path.join(dir, 'fraudlens'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'threvia'), { recursive: true });
  const db = testDb(tmpDir('secondbrain-related-prose-db-'));
  const fraud = registerProject(db, path.join(dir, 'fraudlens')).project;
  const threat = registerProject(db, path.join(dir, 'threvia')).project;
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: fraud.id,
    projectId: fraud.id,
    ts: 1_700_000_000_000,
    text: overviewDoc(
      'fraudlens',
      'Fraud detection at scale, including a Bloom Filter for instant blacklist lookups and graph analysis of laundering rings.',
    ),
  });
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: threat.id,
    projectId: threat.id,
    ts: 1_700_000_000_000,
    text: overviewDoc('threvia', 'Threat detection with graph analysis of attack networks.'),
  });
  upsertCommit(db, {
    projectId: threat.id,
    hash: 'f'.repeat(40),
    message: 'tighten the bloom filter',
    filesChanged: 1,
    insertions: 12,
    deletions: 3,
    files: [{ path: 'backend/realtime/bloom_filter.py', add: 12, del: 3 }],
    ts: 1_700_100_000_000,
  });
  const best = findRelatedProjects(db, fraud.id).matches[0];
  assert.ok(best, 'expected a related project');
  // The headline is a claim about what both projects are…
  assert.match(best?.relation.headline ?? '', /same shape of system/);
  assert.match(best?.relation.headline ?? '', /graph/);
  // …and each piece of evidence quotes the user's own README and names the file.
  const bloom = (best?.relation.evidence ?? []).find((item) => /bloom/i.test(item.idea));
  assert.ok(bloom, `expected bloom-filter evidence: ${JSON.stringify(best?.relation.evidence)}`);
  assert.match(bloom?.yours ?? '', /Bloom Filter for instant blacklist lookups/);
  assert.ok(bloom?.files.some((file) => file.path === 'backend/realtime/bloom_filter.py'));
  db.close();
});

test('findRelatedProjects reports what is inside the other project\'s files', () => {
  const dir = tmpDir('secondbrain-related-inside-');
  const fraudPath = path.join(dir, 'fraudlens');
  const threatPath = path.join(dir, 'threvia');
  fs.mkdirSync(fraudPath, { recursive: true });
  fs.mkdirSync(path.join(threatPath, 'backend', 'realtime'), { recursive: true });
  // A real file on disk, so the inspector reads actual contents.
  fs.writeFileSync(
    path.join(threatPath, 'backend', 'realtime', 'bloom_filter.py'),
    [
      '#!/usr/bin/env python3',
      '"""Phase 4A — fast blacklist membership checks."""',
      '',
      'class ThreatBloomFilter:',
      '    def __init__(self, size):',
      '        self.size = size',
      '',
      '    def build_from_dataset(self, path):',
      '        return path',
      '',
      '    def check(self, value):',
      '        return False',
    ].join('\n'),
  );
  const db = testDb(tmpDir('secondbrain-related-inside-db-'));
  const fraud = registerProject(db, fraudPath).project;
  const threat = registerProject(db, threatPath).project;
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: fraud.id,
    projectId: fraud.id,
    ts: 1_700_000_000_000,
    text: overviewDoc(
      'fraudlens',
      'Fraud detection at scale with a Bloom Filter for instant blacklist lookups and graph analysis of rings.',
    ),
  });
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: threat.id,
    projectId: threat.id,
    ts: 1_700_000_000_000,
    text: overviewDoc('threvia', 'Threat detection with graph analysis of attack networks.'),
  });
  upsertCommit(db, {
    projectId: threat.id,
    hash: 'd'.repeat(40),
    message: 'bloom filter batch handler',
    filesChanged: 1,
    insertions: 40,
    deletions: 2,
    files: [{ path: 'backend/realtime/bloom_filter.py', add: 40, del: 2 }],
    ts: 1_700_100_000_000,
  });
  const best = findRelatedProjects(db, fraud.id).matches[0];
  const bloom = (best?.relation.evidence ?? []).find((item) => /bloom/i.test(item.idea));
  const file = bloom?.files.find((entry) => entry.path === 'backend/realtime/bloom_filter.py');
  assert.ok(file, 'expected the bloom filter file to be inspected');
  assert.equal(file?.exists, true);
  assert.equal(file?.language, 'Python');
  assert.equal(file?.lines, 12);
  // The reusable pieces, with dunder noise and the shebang line filtered out.
  assert.ok(file?.symbols.includes('ThreatBloomFilter'), `symbols: ${JSON.stringify(file?.symbols)}`);
  assert.ok(file?.symbols.includes('build_from_dataset'));
  assert.ok(file?.symbols.includes('check'));
  assert.ok(!file?.symbols.includes('__init__'));
  assert.equal(file?.doc, 'Phase 4A — fast blacklist membership checks.');
  assert.match(explainFile(file as never), /Python, 12 lines · defines ThreatBloomFilter/);
  db.close();
});

test('findRelatedProjects ignores the generated overview header', () => {
  const dir = tmpDir('secondbrain-related-header-');
  fs.mkdirSync(path.join(dir, 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'chess'), { recursive: true });
  const db = testDb(tmpDir('secondbrain-related-header-db-'));
  const recipes = registerProject(db, path.join(dir, 'recipes')).project;
  const chess = registerProject(db, path.join(dir, 'chess')).project;
  // Identical boilerplate (path/layout/languages/summary excluded) but the
  // README stories have nothing to do with each other.
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: recipes.id,
    projectId: recipes.id,
    ts: 1_700_000_000_000,
    text: overviewDoc('recipes', 'A personal recipe collection with photo galleries and shopping lists for home cooks.'),
  });
  upsertSearchDoc(db, {
    ownerType: 'project',
    ownerId: chess.id,
    projectId: chess.id,
    ts: 1_700_000_000_000,
    text: overviewDoc('chess', 'A chess engine playing endgames with bitboard search and a tournament clock for clubs.'),
  });
  assert.deepEqual(findRelatedProjects(db, recipes.id).matches, []);
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
