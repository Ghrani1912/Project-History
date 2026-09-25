import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { encodeLine, parseLine } from '../dist/capture/protocol.js';
import {
  SHELL_HOOK_SNIPPET,
  SHELL_MARKER_END,
  SHELL_MARKER_START,
  installShellHook,
  shellHookInstalled,
  splitLine,
  uninstallShellHook,
  writeCliShim,
} from '../dist/capture/shellHook.js';
import { ProjectWatcher, buildIgnoreMatcher } from '../dist/capture/watcher.js';
import { tmpDir } from './helpers.ts';

test('the shell snippet wires both shells and builds tab-delimited lines', () => {
  assert.match(SHELL_HOOK_SNIPPET, /preexec/);
  assert.match(SHELL_HOOK_SNIPPET, /precmd/);
  assert.match(SHELL_HOOK_SNIPPET, /add-zsh-hook/);
  assert.match(SHELL_HOOK_SNIPPET, /trap '__brain_debug' DEBUG/);
  assert.match(SHELL_HOOK_SNIPPET, /PROMPT_COMMAND/);
  // The payload must be built by printf with escapes in the *format* string,
  // otherwise the daemon receives a line with literal backslash-t fields.
  assert.match(SHELL_HOOK_SNIPPET, /printf 'SB1\\t%s\\tcmd\\t/);
  // Socket fast path plus CLI fallback.
  assert.match(SHELL_HOOK_SNIPPET, /dev\/tcp\/127\.0\.0\.1/);
  assert.match(SHELL_HOOK_SNIPPET, /ztcp 127\.0\.0\.1/);
  assert.match(SHELL_HOOK_SNIPPET, /hook line/);
  // No unescaped backticks would have broken the template literal in TS.
  assert.ok(!SHELL_HOOK_SNIPPET.includes('\u0060'));
});

test('line protocol round-trips tab-separated fields', () => {
  const line = encodeLine({
    op: 'cmd',
    token: 'tok',
    fields: ['sess-1', '1', '1700000000000', 'C:/work/app', 'npm test --silent'],
  });
  const parsed = parseLine(line);
  assert.ok(parsed);
  assert.equal(parsed.op, 'cmd');
  assert.equal(parsed.token, 'tok');
  assert.deepEqual(parsed.fields, ['sess-1', '1', '1700000000000', 'C:/work/app', 'npm test --silent']);
});

test('line protocol rejects foreign and unknown lines', () => {
  assert.equal(parseLine('{"id":"1","op":"ping"}'), null);
  assert.equal(parseLine('SB1\ttok\tshutdown'), null);
  assert.equal(parseLine('SB1\ttok'), null);
});

test('splitLine tolerates trailing CRLF from Windows pipes', () => {
  assert.deepEqual(splitLine('SB1\ttok\tcmd\tx\r\n'), ['SB1', 'tok', 'cmd', 'x']);
});

test('shell hook install and uninstall are marker-based and idempotent', () => {
  const dir = tmpDir();
  const rc = path.join(dir, '.bashrc');
  fs.writeFileSync(rc, 'export EDITOR=vim\n', 'utf8');

  const install = installShellHook('bash', rc);
  assert.equal(install.installed, true);
  assert.equal(shellHookInstalled('bash', rc), true);
  const content = fs.readFileSync(rc, 'utf8');
  assert.match(content, /export EDITOR=vim/, 'existing rc content is preserved');
  assert.ok(content.includes(SHELL_MARKER_START) && content.includes(SHELL_MARKER_END));

  const again = installShellHook('bash', rc);
  assert.equal(again.alreadyPresent, true);
  assert.equal(fs.readFileSync(rc, 'utf8'), content);

  const removed = uninstallShellHook('bash', rc);
  assert.equal(removed.removed, true);
  assert.equal(shellHookInstalled('bash', rc), false);
  assert.match(fs.readFileSync(rc, 'utf8'), /export EDITOR=vim/);
  assert.equal(uninstallShellHook('bash', rc).removed, false);
});

test('the CLI shim points at the current entry point', () => {
  const dir = tmpDir();
  const previous = process.env.SECOND_BRAIN_HOME;
  process.env.SECOND_BRAIN_HOME = dir;
  try {
    const shim = writeCliShim('/somewhere/dist/index.js');
    assert.equal(shim, path.join(dir, 'brain'));
    const content = fs.readFileSync(shim as string, 'utf8');
    assert.match(content, /^#!\/bin\/sh/);
    assert.match(content, /\/somewhere\/dist\/index\.js/);
  } finally {
    if (previous === undefined) delete process.env.SECOND_BRAIN_HOME;
    else process.env.SECOND_BRAIN_HOME = previous;
  }
});

test('ignore matcher blocks VCS and dependency trees', () => {
  const isIgnored = buildIgnoreMatcher(['**/node_modules/**', '**/.git/**']);
  assert.equal(isIgnored('C:/work/app/node_modules/react/index.js'), true);
  assert.equal(isIgnored('C:/work/app/.git/index'), true);
  assert.equal(isIgnored('C:/work/app/src/index.ts'), false);
});

test('watcher reports real file touches and ignores noise', async () => {
  const root = tmpDir('secondbrain-watch-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });

  const touches: Array<{ path: string; action: string }> = [];
  const watcher = new ProjectWatcher(
    { ignore: ['**/node_modules/**', '**/.git/**'], debounceMs: 20, maxEventsPerMinute: 1000 },
    (touch) => touches.push({ path: touch.path, action: touch.action }),
  );

  const project = {
    id: 7,
    name: 'watched',
    path: root.replace(/\\/g, '/'),
    created_at: 0,
    last_seen_at: null,
    git_remote: null,
    stack: null,
    summary: null,
    open_threads: null,
    ignored: 0,
  };
  watcher.sync([project]);
  await new Promise((resolve) => setTimeout(resolve, 300));

  fs.writeFileSync(path.join(root, 'src', 'real.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, '.git', 'index'), 'noise\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'noise\n');

  const deadline = Date.now() + 4000;
  while (touches.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await watcher.close();

  assert.deepEqual(
    touches.map((touch) => touch.path),
    ['src/real.ts'],
    'only the source file should be reported',
  );
  assert.equal(touches[0]?.action, 'create');
});

test('watcher sync unwatches removed projects', async () => {
  const root = tmpDir('secondbrain-watch-sync-');
  const watcher = new ProjectWatcher({ ignore: [], debounceMs: 10, maxEventsPerMinute: 100 }, () => undefined);
  const project = {
    id: 1,
    name: 'a',
    path: root.replace(/\\/g, '/'),
    created_at: 0,
    last_seen_at: null,
    git_remote: null,
    stack: null,
    summary: null,
    open_threads: null,
    ignored: 0,
  };
  assert.deepEqual(watcher.sync([project]).watching, [1]);
  assert.deepEqual(watcher.list(), [1]);
  const result = watcher.sync([]);
  assert.deepEqual(result.stopped, [1]);
  assert.deepEqual(watcher.list(), []);
  await watcher.close();
});
