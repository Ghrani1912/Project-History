import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeIndexer, onboardProject } from '../dist/capture/ingest.js';
import { ask } from '../dist/core/recall.js';
import { getProject, registerProject, setProjectMeta } from '../dist/core/projects.js';
import { createHashEmbedder } from '../dist/embeddings/embedder.js';
import { aggregateChangedFiles } from '../dist/summarize/brief.js';
import { buildProjectProfile, describeProject, renderProfileDoc } from '../dist/summarize/profile.js';
import { testDb, tmpDir } from './helpers.ts';

const embedder = createHashEmbedder(256);

/** A folder that looks like a small Node service with a real README. */
function makeApp(dir: string): string {
  const app = path.join(dir, 'my-app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify({ name: 'my-app', dependencies: { express: '^4.19.0' }, scripts: { test: 'node --test' } }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(app, 'README.md'),
    '# My App\n\nA small service that turns billing events into invoices for the finance team.\n\n## Usage\n\nnpm start\n',
    'utf8',
  );
  fs.writeFileSync(path.join(app, 'src', 'index.ts'), 'export const app = 1;\n', 'utf8');
  return app;
}

test('buildProjectProfile reads the README, stack, layout and entry points', async () => {
  const dir = tmpDir();
  const app = makeApp(dir);
  const db = testDb(dir);
  const project = registerProject(db, app).project;

  const profile = await buildProjectProfile(db, project);
  assert.match(profile.summary, /turns billing events into invoices/);
  assert.ok(profile.stack.includes('Node'));
  assert.ok(profile.stack.includes('Express'));
  assert.ok(profile.entryPoints.includes('src/index.ts'));
  assert.ok(profile.topLevel.some((entry) => entry.name === 'src/'));
  assert.ok(profile.languages.some((entry) => entry.language === 'TypeScript'));
  assert.equal(profile.testCommand, 'npm test');
  assert.equal(profile.readmeFile, 'README.md');
  assert.match(profile.doc, /project overview/);
  assert.match(profile.doc, /README/);
  db.close();
});

test('describeProject prefers README prose and falls back to structure', () => {
  const fromReadme = describeProject({
    name: 'x',
    stack: ['Node'],
    languages: [],
    topLevel: [],
    readme: '# x\n\nThis tool indexes fossils for the museum archive.\n',
  });
  assert.match(fromReadme, /indexes fossils/);

  // A bold tagline under the title is the most common README shape: it is a
  // good summary, but the markers must not leak into stored/printed text.
  const fromBoldTagline = describeProject({
    name: 'x',
    stack: ['Python'],
    languages: [],
    topLevel: [],
    readme: '# Threvia\n\n**Threat Recognition, Evaluation & Visualization using Intelligent Analytics**\n\n## Setup\n',
  });
  assert.equal(fromBoldTagline, 'Threat Recognition, Evaluation & Visualization using Intelligent Analytics');

  const fromStructure = describeProject({
    name: 'x',
    stack: ['Go'],
    languages: [{ language: 'Go', files: 12 }],
    topLevel: [{ name: 'cmd/', kind: 'dir' }],
    readme: null,
  });
  assert.match(fromStructure, /Go project with cmd/);
});

test('renderProfileDoc keeps the keywords recall depends on', () => {
  const doc = renderProfileDoc({
    project: {
      id: 4,
      name: 'Threvia',
      path: 'C:/work/threvia',
      created_at: 0,
      last_seen_at: null,
      git_remote: null,
      stack: null,
      summary: null,
      open_threads: null,
      ignored: 0,
    },
    summary: 'Spectral graph model for invoice matching.',
    stack: ['Python', 'Docker Compose'],
    languages: [{ language: 'Python', files: 42 }],
    gitRemote: 'git@github.com:me/threvia.git',
    branch: 'main',
    isGitRepo: true,
    topLevel: [{ name: 'app/', kind: 'dir' }],
    entryPoints: ['main.py'],
    readme: 'Threvia matches invoices to ledger lines.',
    testCommand: 'pytest',
    commits: 11,
    lastCommit: { hash: 'a'.repeat(40), message: 'v3 model', ts: 0 },
    recentCommits: ['aaaaaaa v3 model'],
  });
  for (const expected of ['project overview', 'Python', 'git@github.com', 'main.py', 'pytest', 'invoices']) {
    assert.ok(doc.toLowerCase().includes(expected.toLowerCase()), `missing ${expected}`);
  }
});

test('setProjectMeta round-trips stack, summary and remote on the project row', () => {
  const dir = tmpDir();
  const app = makeApp(dir);
  const db = testDb(dir);
  const project = registerProject(db, app).project;
  setProjectMeta(db, project.id, { stack: 'Node, Express', summary: 'invoices', git_remote: 'git@x/y.git' });

  const stored = getProject(db, project.id);
  assert.equal(stored?.stack, 'Node, Express');
  assert.equal(stored?.summary, 'invoices');
  assert.equal(stored?.git_remote, 'git@x/y.git');
  db.close();
});

test('onboardProject stores the overview and makes it retrievable with ask', async () => {
  const dir = tmpDir();
  const app = makeApp(dir);
  const db = testDb(dir);
  const index = makeIndexer(db, embedder);

  const result = await onboardProject(db, index, app, { installHook: false });
  assert.equal(result.created, true);
  assert.equal(result.profileIndexed, true);
  assert.equal(result.hook, null);

  const stored = getProject(db, 'my-app');
  assert.ok(stored, 'the project should be readable by name');
  assert.match(stored.summary ?? '', /invoices/);
  assert.ok((stored.stack ?? '').includes('Node'));

  const docs = db.prepare("SELECT COUNT(*) AS n FROM search_docs WHERE owner_type = 'project'").get() as { n: number };
  assert.equal(docs.n, 1);

  const recall = await ask(db, embedder, 'what does this project do', { projectId: stored.id });
  assert.ok(recall.lexicalCount > 0, 'the overview should match lexically');
  assert.ok(
    recall.hits.some((hit) => hit.ownerType === 'project'),
    'the project overview should be the top kind of answer for "what does this project do"',
  );
  assert.equal(recall.weak, false);
  db.close();
});

test('aggregateChangedFiles ranks files by how many commits touched them', () => {
  const commits = [
    { files: JSON.stringify(['src/a.ts', 'src/b.ts']) },
    { files: JSON.stringify(['src/a.ts']) },
    { files: null },
  ];
  const files = aggregateChangedFiles(commits as never);
  assert.equal(files[0]?.path, 'src/a.ts');
  assert.equal(files[0]?.commits, 2);
  assert.deepEqual(
    files.map((file) => file.path),
    ['src/a.ts', 'src/b.ts'],
  );
});
