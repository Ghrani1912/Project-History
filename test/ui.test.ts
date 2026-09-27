import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { renderPage } from '../dist/ui/page.js';
import { looksLikeGitUrl } from '../dist/git/remote.js';

function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
}

test('the UI page is one self-contained document with the run token', () => {
  const html = renderPage('test-token-123');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>Second Brain OS</title>'));
  assert.ok(html.includes("var TOKEN = 'test-token-123';"));
  // No external assets: the panel can be served with the machine offline.
  assert.ok(!/<(link|script)[^>]+(src|href)=/i.test(html));
  assert.ok(html.includes('Track a folder'));
  assert.ok(html.includes('Register folder'));
  // The workbench shell: sidebar of workspaces, the Auto-Brief / timeline split.
  assert.ok(html.includes('Connected Workspaces'));
  assert.ok(html.includes('Auto-Brief'));
  assert.ok(html.includes('Ask Second Brain'));
  assert.ok(html.includes('Unified') || html.includes('Live Feed'));
  // The project sections stay the ones the CLI and the earlier UI exposed.
  assert.ok(html.includes("var tabs = ['overview', 'brief', 'related', 'timeline', 'ask']"));
  // Recall is back on its own project tab, not only in the ⌘K palette.
  assert.ok(html.includes('/api/ask?project='));
  assert.ok(html.includes('Ask this workspace'));
  // The cross-project prior-art panel lives in the left column of the detail split.
  assert.ok(html.includes('/api/related?project='));
  assert.ok(html.includes('Find similar work'));
  // Pre-flight: the same tab diffs a plan against past decisions and reverts.
  assert.ok(html.includes('/api/check?project='));
  assert.ok(html.includes('Check plan'));
  assert.ok(html.includes('Before you build it'));
  // A local-first panel should say where the data lives, so the paths the
  // server reports in /api/state are consumed rather than dead payload.
  assert.ok(html.includes('data.database') && html.includes('data.configFile'));
});

/** Pull a few declarations out of the emitted script so they can be unit-tested. */
function clientHelpers(script: string, names: string[]): Record<string, (...args: never[]) => unknown> {
  const source = names
    .map((name) => {
      const pattern = new RegExp(`(?:var ${name} = [^;]+;|function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\})`);
      const match = script.match(pattern);
      assert.ok(match, `could not extract ${name} from the UI script`);
      return match[0];
    })
    .join('\n');
  return new Function(`${source}; return { ${names.join(', ')} };`)() as Record<
    string,
    (...args: never[]) => unknown
  >;
}

test('the brief renderer keeps underscores in file names', () => {
  const script = scriptsOf(renderPage('token'))[0] ?? '';
  const helpers = clientHelpers(script, ['TICK', 'NEWLINE', 'esc', 'markdown']);
  const markdown = helpers.markdown as unknown as (text: string) => string;

  const html = markdown(
    [
      '_just now generated_',
      '- `42114f2` idk anyway',
      '  - `backend/realtime/online_learning.py +1310/-0`, `backend/realtime/test_online_learning.py +500/-0`',
    ].join('\n'),
  );
  assert.ok(html.includes('online_learning.py'), 'underscores inside a file name must survive');
  assert.ok(html.includes('test_online_learning.py'), 'the second file name survives too');
  assert.ok(html.includes('<span class="dim">just now generated</span>'), 'wrapped _text_ is dim');
  assert.ok(html.includes('class="bullet"'), 'top-level bullets are rendered');
  assert.ok(html.includes('class="sub"'), 'indented bullets become detail lines');
});

test('the emitted UI script parses — escaping mistakes break the whole page', () => {
  const scripts = scriptsOf(renderPage('token'));
  assert.equal(scripts.length, 1);
  const script = scripts[0] ?? '';
  assert.ok(script.length > 4000);
  // Compiling with vm throws SyntaxError on exactly the class of bug where a
  // template-literal escape silently produced an unterminated string.
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'brain-ui.js' }));
  // The script sits inside a TypeScript template literal, so a backslash escape
  // is silently eaten there (\s became s) and the regex quietly stops matching.
  assert.ok(!script.includes('\\'), 'the UI script must not contain backslash escapes');
  // Every inline handler must resolve to a function the script defines.
  const ready = new Set<string>();
  for (const match of script.matchAll(/function\s+([A-Za-z_][\w]*)\s*\(/g)) {
    if (match[1]) ready.add(match[1]);
  }
  const html = renderPage('token');
  for (const match of html.matchAll(/on(?:click|keydown)="([A-Za-z_][\w]*)\(/g)) {
    assert.ok(ready.has(match[1] ?? ''), `inline handler ${match[1]} is not defined`);
  }
});

test('the register dialog enrolls a git link, not only a local folder', () => {
  // Before this, the only way to enroll a repository was the CLI (`brain
  // register <url>`): pasting a URL into the dialog hit the local-path checks
  // and failed. The client now recognizes a link and says so.
  const html = renderPage('token');
  const script = scriptsOf(html)[0] ?? '';
  const helpers = clientHelpers(script, ['URL_RE', 'looksLikeUrl']);
  const looksLikeUrl = helpers.looksLikeUrl as unknown as (value: string) => boolean;

  assert.equal(looksLikeUrl('https://github.com/owner/repo.git'), true);
  assert.equal(looksLikeUrl('  git@github.com:owner/repo.git  '), true);
  assert.equal(looksLikeUrl('ssh://git@host/owner/repo'), true);
  assert.equal(looksLikeUrl('C:/Users/me/projects/app'), false);
  assert.equal(looksLikeUrl(''), false);

  assert.ok(html.includes('Track a folder or git link'));
  assert.ok(html.includes('oninput="syncRegisterMode()"'), 'the dialog reacts to a pasted link');
  assert.ok(html.includes('Register git link'), 'the button renames itself for a link');
});

test('a decision can be logged from the panel, not only from the CLI', () => {
  // The plan check diffs against decisions and the hygiene card scans them for
  // conflicts; with no way to write one here, both cards dead-ended in a CLI
  // instruction inside a panel that exists to avoid the CLI.
  const html = renderPage('token');
  const script = scriptsOf(html)[0] ?? '';
  assert.ok(html.includes('/api/decision'), 'the panel posts a decision');
  assert.ok(html.includes('Log a decision'));
  assert.ok(html.includes('onclick="logFromButton('), 'the button is wired to a handler');
  assert.ok(script.includes('function logDecision('), 'and the handler exists in the emitted script');
  assert.ok(html.includes('id="decisionInput"'), 'the field exists in the card');
});

test('the dialog and the server agree on what a git link is', () => {
  // The client cannot import the server rule (the page is one self-contained
  // string), so the detection is written twice. If they ever disagree the
  // dialog promises "Register git link" for something the server then rejects
  // as a missing folder — so both are run over the same inputs.
  const script = scriptsOf(renderPage('token'))[0] ?? '';
  const helpers = clientHelpers(script, ['URL_RE', 'looksLikeUrl']);
  const client = helpers.looksLikeUrl as unknown as (value: string) => boolean;

  const samples = [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'http://gitlab.local/group/sub/project',
    'git@github.com:owner/repo.git',
    'ssh://git@host/owner/repo',
    'git://github.com/owner/repo',
    'https://github.com',
    'C:/Users/me/projects/app',
    'C:\\Users\\me\\app',
    '/home/me/app',
    './relative/app',
    'relative/app',
    'git@home',
    '',
  ];
  for (const sample of samples) {
    assert.equal(
      client(sample.trim()),
      looksLikeGitUrl(sample.trim()),
      `the dialog and the server disagree about "${sample}"`,
    );
  }
});

test('every timeline chip has a counter for its own kind', () => {
  // The bug this guards: an event kind can render on the timeline (and count
  // toward "All") while its chip silently reads 0, because the client-side
  // counts object forgot a key. Adding a chip without a counter is that bug.
  const script = scriptsOf(renderPage('token'))[0] ?? '';
  const kindsMatch = script.match(/var kinds = (\[\[[\s\S]*?\]\]);/);
  const kindsSource = kindsMatch?.[1];
  assert.ok(kindsSource, 'the timeline chip list is present in the emitted script');
  const kinds = new Function(`return ${kindsSource};`)() as Array<[string, string]>;

  const countsMatch = script.match(/var counts = \{ all: entries\.length,([^}]*)\};/);
  const countsBody = countsMatch?.[1];
  assert.ok(countsBody, 'the timeline counts map is present in the emitted script');
  const counterKeys = new Set<string>(['all']);
  for (const part of countsBody.split(',')) {
    const key = part.split(':')[0]?.trim();
    if (key) counterKeys.add(key);
  }

  for (const entry of kinds) {
    const kind = entry[0];
    assert.ok(counterKeys.has(kind), `the "${kind}" chip has no counter — it would always read 0`);
  }
});
