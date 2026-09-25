import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { globToRegExp } from '../dist/capture/watcher.js';
import { relativeTime, truncate } from '../dist/util/format.js';
import { normalizePath } from '../dist/util/paths.js';

test('normalizePath produces forward-slash absolute paths', () => {
  const result = normalizePath('.');
  assert.ok(path.isAbsolute(result));
  assert.ok(!result.includes('\\'));
});

test('normalizePath translates shell-style drives on Windows', () => {
  if (process.platform !== 'win32') return;
  assert.equal(normalizePath('/c/Users/demo/project'), 'C:/Users/demo/project');
  assert.equal(normalizePath('C:\\Users\\demo\\project'), 'C:/Users/demo/project');
  assert.equal(normalizePath('/mnt/d/work/project'), 'D:/work/project');
});

test('relativeTime reads naturally', () => {
  const now = Date.now();
  assert.equal(relativeTime(now, now), 'just now');
  assert.match(relativeTime(now - 90_000, now), /minutes? ago/);
  assert.match(relativeTime(now - 3 * 3600_000, now), /hours? ago/);
});

test('truncate collapses whitespace and ellipsises', () => {
  assert.equal(truncate('a\n  b', 10), 'a b');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
});

test('globToRegExp handles **, * and literal dots', () => {
  const gitIgnore = globToRegExp('**/.git/**');
  assert.ok(gitIgnore.test('C:/work/app/.git/index'));
  assert.ok(!gitIgnore.test('C:/work/app/src/index.ts'));

  const logs = globToRegExp('**/*.log');
  assert.ok(logs.test('C:/work/app/npm-debug.log'));
  assert.ok(!logs.test('C:/work/app/npm-debug.txt'));

  const modules = globToRegExp('**/node_modules/**');
  assert.ok(modules.test('C:/work/app/node_modules/react/index.js'));
  assert.ok(modules.test('/work/app/node_modules/x/y'));
});
