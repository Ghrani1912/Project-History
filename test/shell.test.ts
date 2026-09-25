import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  HOOK_SNIPPETS,
  POWERSHELL_HOOK_SNIPPET,
  SHELL_MARKER_END,
  SHELL_MARKER_START,
  detectShell,
  installShellHook,
  rcCandidatesFor,
  shellHookFiles,
  shellHookInstalled,
  uninstallShellHook,
  writeCliShim,
} from '../dist/capture/shellHook.js';
import { cliEntryPath } from '../dist/util/paths.js';
import { tmpDir } from './helpers.ts';

/** Run `fn` with the database/home pointed at a temp dir; always restore. */
function withTempHome<T>(dir: string, fn: () => T): T {
  const previous = process.env.SECOND_BRAIN_HOME;
  process.env.SECOND_BRAIN_HOME = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.SECOND_BRAIN_HOME;
    else process.env.SECOND_BRAIN_HOME = previous;
  }
}

test('the PowerShell snippet is marker-based and builds a real tab-delimited line', () => {
  assert.ok(POWERSHELL_HOOK_SNIPPET.includes(SHELL_MARKER_START));
  assert.ok(POWERSHELL_HOOK_SNIPPET.includes(SHELL_MARKER_END));
  // Backticks in PowerShell are escape characters; the snippet must avoid them
  // entirely, otherwise the TS template literal (and readback) gets fragile.
  assert.ok(!POWERSHELL_HOOK_SNIPPET.includes('\u0060'), 'no backticks in the PowerShell hook');
  // Fields are joined with a real tab, never with an escape sequence.
  assert.ok(POWERSHELL_HOOK_SNIPPET.includes('-join ([string][char]9)'));
  assert.ok(
    POWERSHELL_HOOK_SNIPPET.includes("$clean -like 'brain *'"),
    'our own CLI must be filtered out in-shell as well',
  );
  // Nothing may rely on a backslash escape: the TS template literal would
  // swallow it (this is how `\s` once silently became a bare `s`). The only
  // legitimate backslashes are the literal control characters in the strip
  // class, which JS has already turned into real tab/CR/LF characters.
  const withoutCharClass = POWERSHELL_HOOK_SNIPPET.replace(/[[\t\r\n]+]/g, '');
  assert.ok(!withoutCharClass.includes('\\'), 'no backslash escapes remain in the PowerShell snippet');
  // PSReadLine sees the command line; the prompt wrapper flushes it with the exit code.
  assert.match(POWERSHELL_HOOK_SNIPPET, /AddToHistoryHandler/);
  assert.match(POWERSHELL_HOOK_SNIPPET, /function global:prompt/);
  assert.match(POWERSHELL_HOOK_SNIPPET, /Get-History -Count 1/);
  // Socket fast path plus CLI fallback, same as the POSIX hook.
  assert.match(POWERSHELL_HOOK_SNIPPET, /TcpClient/);
  assert.match(POWERSHELL_HOOK_SNIPPET, /hook line/);
  assert.match(POWERSHELL_HOOK_SNIPPET, /brief --auto/);
  assert.equal(HOOK_SNIPPETS.powershell, POWERSHELL_HOOK_SNIPPET);
  assert.equal(HOOK_SNIPPETS.bash, HOOK_SNIPPETS.zsh);
});

test('detectShell understands PowerShell spellings', () => {
  assert.equal(detectShell('powershell'), 'powershell');
  assert.equal(detectShell('pwsh'), 'powershell');
  assert.equal(detectShell('zsh'), 'zsh');
  assert.equal(detectShell('bash'), 'bash');
});

test('PowerShell profile candidates cover both installed editions', () => {
  const candidates = rcCandidatesFor('powershell');
  assert.ok(candidates.some((file) => file.includes(`PowerShell${path.sep}profile.ps1`)));
  assert.ok(candidates.some((file) => file.includes('WindowsPowerShell')));
  assert.equal(path.basename(rcCandidatesFor('bash')[0] ?? ''), '.bashrc');
  assert.equal(path.basename(rcCandidatesFor('zsh')[0] ?? ''), '.zshrc');
});

test('installing and uninstalling the PowerShell hook is marker-based and idempotent', () => {
  const dir = tmpDir();
  const rc = path.join(dir, 'profile.ps1');
  fs.writeFileSync(rc, '# my profile\nSet-Alias ll ls\n', 'utf8');

  withTempHome(dir, () => {
    const install = installShellHook('powershell', rc);
    assert.equal(install.installed, true);
    assert.equal(install.shell, 'powershell');
    const content = fs.readFileSync(rc, 'utf8');
    assert.match(content, /Set-Alias ll ls/, 'existing profile content is preserved');
    assert.ok(content.includes(SHELL_MARKER_START) && content.includes(SHELL_MARKER_END));
    assert.ok(content.includes('AddToHistoryHandler'));
    assert.equal(shellHookInstalled('powershell', rc), true);

    const again = installShellHook('powershell', rc);
    assert.equal(again.alreadyPresent, true);
    assert.equal(fs.readFileSync(rc, 'utf8'), content);

    assert.equal(uninstallShellHook('powershell', rc).removed, true);
    assert.equal(shellHookInstalled('powershell', rc), false);
    assert.match(fs.readFileSync(rc, 'utf8'), /Set-Alias ll ls/);
  });
});

test('a hook installed outside the conventional paths is still reported', () => {
  // PowerShell's Documents folder is often redirected (OneDrive), so the
  // installer records the profile it wrote to. Status must see that, otherwise
  // the UI claims PowerShell capture is missing while it is perfectly installed.
  const home = tmpDir();
  const redirected = path.join(home, 'OneDrive', 'Documents', 'WindowsPowerShell');
  fs.mkdirSync(redirected, { recursive: true });
  const rc = path.join(redirected, 'profile.ps1');

  withTempHome(home, () => {
    assert.deepEqual(shellHookFiles('powershell'), [], 'nothing installed yet');
    installShellHook('powershell', rc);
    fs.writeFileSync(
      path.join(home, 'shell-hooks.json'),
      JSON.stringify({ powershell: [rc] }),
      'utf8',
    );
    assert.deepEqual(shellHookFiles('powershell'), [rc]);
    assert.equal(shellHookInstalled('powershell'), true);
  });
});

test('the CLI entry path is the program itself, never whatever imported us', () => {
  const entry = cliEntryPath();
  assert.ok(entry, 'an entry point must be resolvable');
  assert.ok(/index\.[cm]?[jt]s$/.test(entry), `unexpected entry point: ${entry}`);
  assert.ok(!/[\\/]test[\\/]/.test(entry), `entry point points into the test suite: ${entry}`);
});

test('the generated CLI shim refuses to point at a test file', () => {
  const dir = tmpDir();
  withTempHome(dir, () => {
    // The shim target is derived, so the real entry is used…
    const shim = writeCliShim();
    assert.equal(shim, path.join(dir, 'brain'));
    const content = fs.readFileSync(shim as string, 'utf8');
    assert.ok(content.includes('index.js'), content);
    assert.ok(!content.includes('.test.'), content);

    // …and an explicit test-file target is rejected rather than installed.
    fs.rmSync(shim as string);
    assert.equal(writeCliShim(path.join(dir, 'test', 'broken.test.ts')), null);
    assert.equal(fs.existsSync(shim as string), false, 'no shim may be written for a test target');
  });
});
