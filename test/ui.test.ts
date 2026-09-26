import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { renderPage } from '../dist/ui/page.js';

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
  // The cross-project prior-art panel is part of the project detail tabs.
  assert.ok(html.includes("var tabs = ['overview', 'brief', 'related', 'timeline', 'ask']"));
  assert.ok(html.includes('/api/related?project='));
  assert.ok(html.includes('Find similar work'));
  // Pre-flight: the same tab diffs a plan against past decisions and reverts.
  assert.ok(html.includes('/api/check?project='));
  assert.ok(html.includes('Check plan'));
  assert.ok(html.includes('Before you build it'));
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
