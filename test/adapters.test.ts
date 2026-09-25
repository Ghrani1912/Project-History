import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../dist/config.js';
import { registerProject } from '../dist/core/projects.js';
import { claudeCodeAdapter } from '../dist/adapters/claudeCode.js';
import { dotfileAdapter, parseTimestampedText } from '../dist/adapters/dotfile.js';
import { walkForMessages, vscodeChatAdapter } from '../dist/adapters/vscodeChat.js';
import { runAdapters } from '../dist/adapters/index.js';
import { makeIndexer } from '../dist/capture/ingest.js';
import { createHashEmbedder } from '../dist/embeddings/embedder.js';
import { testDb, tmpDir, writeJsonl } from './helpers.ts';

function configWith(overrides: Partial<(typeof DEFAULT_CONFIG)['adapters']>): typeof DEFAULT_CONFIG {
  return { ...DEFAULT_CONFIG, adapters: { ...DEFAULT_CONFIG.adapters, ...overrides } } as typeof DEFAULT_CONFIG;
}

test('claudeCodeAdapter reads transcripts and uses the in-content timestamp', async () => {
  const dir = tmpDir('claude-projects-');
  const sessionDir = path.join(dir, '-c-Users-demo-app');
  const file = path.join(sessionDir, 'session.jsonl');
  writeJsonl(file, [
    {
      type: 'user',
      timestamp: '2026-01-02T03:04:05.000Z',
      cwd: 'C:/Users/demo/app',
      uuid: 'aaa',
      message: { role: 'user', content: [{ type: 'text', text: 'how does auth work?' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-02T03:04:09.000Z',
      cwd: 'C:/Users/demo/app',
      uuid: 'bbb',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'It uses JWT.' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    },
    { type: 'summary', timestamp: '2026-01-02T03:05:00.000Z', cwd: 'C:/Users/demo/app', uuid: 'ccc' },
    { type: 'user', timestamp: 'not-a-date', uuid: 'ddd', message: { role: 'user', content: 'bad ts' } },
  ]);
  // Deliberately age the file so a mtime-based implementation would fail.
  const old = new Date('2000-01-01T00:00:00.000Z');
  fs.utimesSync(file, old, old);

  const events = await claudeCodeAdapter.collect(configWith({ claudeCodeDir: dir }), {});
  assert.equal(events.length, 2, 'summary records and undated messages are skipped');
  assert.equal(events[0]?.sourceIde, 'claude-code');
  assert.equal(events[0]?.role, 'user');
  assert.equal(events[0]?.ts, Date.parse('2026-01-02T03:04:05.000Z'));
  assert.equal(events[0]?.cwd, 'C:/Users/demo/app');
  assert.match(events[1]?.text ?? '', /JWT/);
  assert.match(events[1]?.text ?? '', /\[tool: Read\]/);
  assert.match(events[1]?.sourceRef ?? '', /session\.jsonl#bbb$/);
});

test('claudeCodeAdapter tolerates malformed transcripts and missing dirs', async () => {
  const dir = tmpDir('claude-bad-');
  const file = path.join(dir, 'broken.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '{not json}\n{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"valid"}}\n');
  const events = await claudeCodeAdapter.collect(configWith({ claudeCodeDir: dir }), {});
  assert.equal(events.length, 1);

  const missing = await claudeCodeAdapter.collect(configWith({ claudeCodeDir: path.join(dir, 'nope') }), {});
  assert.deepEqual(missing, []);
});

test('claudeCodeAdapter honours a since filter from content timestamps', async () => {
  const dir = tmpDir('claude-since-');
  writeJsonl(path.join(dir, 's.jsonl'), [
    { type: 'user', timestamp: '2025-01-01T00:00:00Z', uuid: 'old', message: { role: 'user', content: 'old' } },
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', uuid: 'new', message: { role: 'user', content: 'new' } },
  ]);
  const cutoff = Date.parse('2025-06-01T00:00:00Z');
  const events = await claudeCodeAdapter.collect(configWith({ claudeCodeDir: dir }), { since: cutoff });
  assert.equal(events.length, 1);
  assert.match(events[0]?.text ?? '', /new/);
});

test('parseTimestampedText understands jsonl, json and bracketed markdown', () => {
  const jsonl = parseTimestampedText(
    'notes.jsonl',
    '{"ts":1000,"text":"first note"}\n{"timestamp":"2026-01-01T00:00:00Z","content":"second note"}\nnot json\n',
  );
  assert.equal(jsonl.length, 2);
  assert.deepEqual(jsonl.map((entry) => entry.text), ['first note', 'second note']);

  const md = parseTimestampedText('notes.md', '# heading\n[2026-02-03T04:05:06Z] decided to ship\nplain line\n');
  assert.equal(md.length, 1);
  assert.equal(md[0]?.text, 'decided to ship');

  const json = parseTimestampedText('notes.json', '[{"ts":5,"text":"a"},{"ts":6,"text":"b"}]');
  assert.equal(json.length, 2);
  assert.deepEqual(parseTimestampedText('notes.md', 'no timestamps here'), []);
});

test('dotfileAdapter ingests timestamped notes from a project dot-folder', async () => {
  const root = tmpDir('dotfile-project-');
  const notesDir = path.join(root, '.brain-notes');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'log.md'), '[2026-03-01T10:00:00Z] decided to use WAL mode\n');
  fs.writeFileSync(path.join(notesDir, 'undated.md'), 'just a thought\n');

  const db = testDb(tmpDir('dotfile-db-'));
  const project = registerProject(db, root).project;

  const adapter = dotfileAdapter(db);
  const events = await adapter.collect(DEFAULT_CONFIG, {});
  assert.equal(events.length, 1, 'undated notes are skipped so the timeline stays honest');
  assert.equal(events[0]?.cwd, project.path);
  assert.match(events[0]?.text ?? '', /WAL mode/);

  const index = makeIndexer(db, createHashEmbedder(128));
  const reports = await runAdapters(db, index, DEFAULT_CONFIG, { only: 'dotfile' });
  assert.equal(reports[0]?.inserted, 1);
  const turns = db.prepare('SELECT COUNT(*) AS n FROM chat_turns').get() as { n: number };
  assert.equal(turns.n, 1);

  const rerun = await runAdapters(db, index, DEFAULT_CONFIG, { only: 'dotfile' });
  assert.equal(rerun[0]?.inserted, 0, 're-ingesting is idempotent');
  db.close();
});

test('runAdapters rejects unknown adapter ids', async () => {
  const db = testDb(tmpDir('adapters-db-'));
  await assert.rejects(
    () => runAdapters(db, makeIndexer(db, null), DEFAULT_CONFIG, { only: 'nope' }),
    /unknown adapter/,
  );
  db.close();
});

test('walkForMessages finds role/text/timestamp triples and Copilot request shapes', () => {
  const out: Array<{ role: string; text: string; ts: number }> = [];
  walkForMessages(
    {
      nested: [{ role: 'user', text: 'hello there', timestamp: 1700000000 }],
      requests: [
        {
          message: { text: 'copilot question' },
          response: [{ value: 'copilot answer' }],
          timestamp: 1700003600,
        },
      ],
    },
    out,
  );
  assert.equal(out.length, 3);
  const byText = (needle: string) => out.find((entry) => entry.text.includes(needle));
  assert.equal(byText('hello there')?.role, 'user');
  assert.equal(byText('hello there')?.ts, 1_700_000_000_000);
  assert.equal(byText('copilot question')?.role, 'user');
  assert.equal(byText('copilot question')?.ts, 1_700_003_600_000);
  assert.equal(byText('copilot answer')?.role, 'assistant');
});

test('walkForMessages ignores chat-like objects without a real timestamp', () => {
  const out: Array<{ role: string; text: string; ts: number }> = [];
  walkForMessages({ role: 'user', text: 'no timestamp here' }, out);
  assert.equal(out.length, 0);
});

test('vscodeChatAdapter reports nothing when no editor state exists', async () => {
  // On a machine with editors installed this still must not throw.
  const events = await vscodeChatAdapter.collect(DEFAULT_CONFIG, { limit: 5 });
  assert.ok(Array.isArray(events));
});
