/**
 * The whole UI is one self-contained page: no build step, no CDN, no framework.
 * It talks to the loopback JSON API in server.ts and carries the per-run token
 * so a random website cannot drive the local server.
 *
 * Hard rules for the client script below, because it lives inside a TypeScript
 * template literal:
 *  - no backticks and no `${` (except the deliberate token injection),
 *  - no backslash escapes of any kind (the template literal would eat them),
 *  - inline handlers take no arguments; they read `data-*` attributes instead,
 *    so no nested quote escaping is ever needed.
 * test/ui.test.ts compiles the emitted script with `vm.Script` to keep this honest.
 */
export function renderPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Second Brain OS</title>
<style>
  :root {
    --bg: #0d1117; --panel: #151b23; --panel2: #1c2430; --line: #263041;
    --fg: #e6edf3; --muted: #8b98a9; --accent: #4aa3ff; --green: #3fb950;
    --yellow: #d29922; --red: #f85149; --magenta: #bc8cff; --cyan: #39c5cf;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  a { color: var(--accent); }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; gap: 12px;
    align-items: center; flex-wrap: wrap; background: #10161e; position: sticky; top: 0; z-index: 5; }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .3px; }
  main { padding: 18px 20px 60px; max-width: 1280px; margin: 0 auto; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .cols { display: grid; grid-template-columns: minmax(320px, 430px) 1fr; gap: 16px; align-items: start; }
  @media (max-width: 980px) { .cols { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted);
    margin: 0 0 10px; font-weight: 600; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px;
    background: var(--panel2); border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .ok { color: var(--green); } .warn { color: var(--yellow); } .bad { color: var(--red); }
  .dot.ok { background: var(--green); } .dot.warn { background: var(--yellow); } .dot.bad { background: var(--red); }
  button { background: var(--panel2); color: var(--fg); border: 1px solid var(--line); border-radius: 7px;
    padding: 6px 11px; font-size: 13px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #04121f; font-weight: 600; }
  button.link { background: none; border: none; color: var(--muted); padding: 2px 4px; text-decoration: underline; }
  input[type=text] { background: #0b1017; color: var(--fg); border: 1px solid var(--line);
    border-radius: 7px; padding: 7px 9px; font: inherit; width: 100%; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px; }
  code { background: #0b1017; border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
  .muted { color: var(--muted); }
  .warnbox { background: #2a2113; border: 1px solid #5c4a1a; border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; }
  .warnbox ul { margin: 6px 0 0; padding-left: 20px; }
  .warnbox li { margin: 4px 0; }
  .browser { max-height: 260px; overflow: auto; border: 1px solid var(--line); border-radius: 8px;
    background: #0b1017; margin-top: 10px; }
  .browser div.entry { padding: 6px 10px; cursor: pointer; display: flex; gap: 8px; align-items: center;
    border-bottom: 1px solid #131a23; }
  .browser div.entry:hover { background: #172030; }
  .tag { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; padding: 1px 6px;
    border-radius: 999px; background: #1f2937; color: var(--muted); }
  .tag.git { background: #14301c; color: var(--green); }
  .tag.reg { background: #16283d; color: var(--accent); }
  .project { border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; margin-bottom: 8px;
    cursor: pointer; background: var(--panel2); }
  .project:hover { border-color: var(--accent); }
  .project.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
  .project .name { font-weight: 600; }
  .project .path { color: var(--muted); font-size: 12px; word-break: break-all; }
  .project .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 12px; flex-wrap: wrap; }
  .tabs button { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none;
    color: var(--muted); padding: 7px 11px; }
  .tabs button.active { color: var(--fg); border-bottom-color: var(--accent); }
  .kv { display: grid; grid-template-columns: 120px 1fr; gap: 4px 10px; font-size: 13px; }
  .kv .k { color: var(--muted); }
  .md { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px;
    background: #0b1017; border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .md .h1 { margin-bottom: 2px; }
  .md .h1 { color: #fff; font-weight: 700; font-size: 15px; }
  .md .h2 { color: var(--accent); font-weight: 600; margin-top: 10px; }
  .md .dim { color: var(--muted); }
  .md .bullet { padding-left: 12px; }
  .md .sub { padding-left: 26px; color: #b9c6d4; }
  .entry-line { padding: 7px 0; border-bottom: 1px solid #141b24; }
  .entry-line .t { color: var(--muted); font-size: 12px; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; }
  .badge.commit { background: #2b1a37; color: var(--magenta); }
  .badge.cmd { background: #16283d; color: var(--accent); }
  .badge.file { background: #1f2937; color: var(--muted); }
  .badge.chat { background: #33290f; color: var(--yellow); }
  .badge.decision { background: #10312f; color: var(--cyan); }
  .badge.project { background: #14301c; color: var(--green); }
  .report { margin-top: 12px; background: var(--panel2); border: 1px solid var(--line); border-radius: 9px; padding: 12px; }
  .spin { color: var(--muted); font-size: 13px; }
  .spacer { height: 6px; }
</style>
</head>
<body>
<header>
  <h1>🧠 Second Brain</h1>
  <span class="pill" id="pillDaemon"><span class="dot"></span><span>daemon …</span></span>
  <span class="pill" id="pillShell"><span class="dot"></span><span>shell hooks …</span></span>
  <span class="pill" id="pillLlm"><span class="dot"></span><span>llm …</span></span>
  <span class="pill" id="pillData"><span class="dot ok"></span><span>…</span></span>
  <span style="flex:1"></span>
  <button data-action="daemon-start" onclick="daemonFromButton(this)">Start daemon</button>
  <button data-action="daemon-stop" onclick="daemonFromButton(this)">Stop daemon</button>
  <button data-action="install-hooks" onclick="daemonFromButton(this)">Install shell hooks</button>
  <button data-action="reload" onclick="daemonFromButton(this)">Refresh</button>
</header>

<main>
  <div id="warnings"></div>
  <div class="cols">
    <div>
      <div class="card">
        <h2>Track a folder</h2>
        <div class="row">
          <input type="text" id="folderPath" placeholder="C:/Users/me/projects/my-app" onkeydown="submitFolder(event)">
        </div>
        <div class="spacer"></div>
        <div class="row">
          <button data-browse="typed" onclick="browseFromButton(this)">Browse…</button>
          <button data-browse="home" onclick="browseFromButton(this)">home</button>
          <span id="browsePath" class="muted mono" style="flex:1; word-break:break-all"></span>
        </div>
        <div class="browser" id="browser"></div>
        <div class="spacer"></div>
        <div class="row">
          <input type="text" id="folderName" placeholder="optional name">
          <button class="primary" data-action="register" onclick="daemonFromButton(this)">Register folder</button>
        </div>
        <div id="registerReport"></div>
      </div>
      <div class="card">
        <h2>Projects</h2>
        <div id="projects"></div>
      </div>
    </div>
    <div>
      <div class="card">
        <div id="detail"><span class="muted">Pick a project on the left to see its overview, brief, timeline and recall.</span></div>
      </div>
    </div>
  </div>
</main>

<script>
var TOKEN = '${token}';
var TICK = String.fromCharCode(96);
var NEWLINE = String.fromCharCode(10);
var homeDir = '';
var state = null;
var current = null;
var tab = 'overview';
// Rendered bodies are cached per project: the 20s state poll rebuilds the
// detail card, and without a cache the brief would flash back to "Loading…".
var briefCache = {};
var briefPending = {};
var timelineCache = {};
var timelineInfoCache = {};
var timelinePending = {};

function api(url, options) {
  options = options || {};
  options.headers = Object.assign({ 'x-brain-token': TOKEN }, options.headers || {});
  return fetch(url, options).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
      return body;
    });
  }).catch(function (err) {
    // A network-level failure means this page lost its backend. Say that,
    // instead of leaking a bare "Failed to fetch" into the UI.
    if (err instanceof TypeError) {
      throw new Error('Cannot reach the UI server — it is no longer running. Start it again with: brain ui');
    }
    throw err;
  });
}
function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"]/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
  });
}
function el(id) { return document.getElementById(id); }
function put(id, html) { el(id).innerHTML = html; }
function rel(ts) {
  if (!ts) return 'never';
  var mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.round(hours / 24);
  if (days < 30) return days + 'd ago';
  return Math.round(days / 30) + 'mo ago';
}
function attr(value) { return esc(value); }

/* ---------------------------- buttons ---------------------------- */
function daemonFromButton(button) {
  var action = button.getAttribute('data-action');
  if (action === 'daemon-start') return startDaemon();
  if (action === 'daemon-stop') return stopDaemon();
  if (action === 'install-hooks') return installHooks();
  if (action === 'register') return registerFolder();
  return loadState();
}
function browseFromButton(button) {
  var mode = button.getAttribute('data-browse');
  browse(mode === 'home' ? homeDir : (el('folderPath').value.trim() || null));
}
function browseEntry(node) { browse(node.getAttribute('data-path')); }
function submitFolder(event) { if (event.key === 'Enter') registerFolder(); }
function tabFromButton(button) {
  setTab(Number(button.getAttribute('data-project')), button.getAttribute('data-tab'));
}
function refreshFromButton(button) { refreshProject(Number(button.getAttribute('data-project'))); }
function unregisterFromButton(button) { unregisterProject(Number(button.getAttribute('data-project'))); }
function briefFromButton(button) { loadBrief(Number(button.getAttribute('data-project')), false); }
function timelineFromButton(button) {
  loadTimeline(Number(button.getAttribute('data-project')), Number(button.getAttribute('data-days')));
}
function askFromButton(button) { runAsk(Number(button.getAttribute('data-project'))); }
function askOnEnter(event) {
  if (event.key === 'Enter') runAsk(Number(event.target.getAttribute('data-project')));
}

/* ---------------------------- state ---------------------------- */
function loadState() {
  api('/api/state').then(function (data) {
    state = data;
    homeDir = data.home || '';
    var daemon = data.daemon;
    put('pillDaemon', '<span class="dot ' + (daemon.running ? 'ok' : 'bad') + '"></span><span>' +
      (daemon.running ? 'daemon pid ' + daemon.pid + ' :' + daemon.port : 'daemon stopped') + '</span>');
    var hooked = data.shells.hooks.filter(function (h) { return h.installed; });
    var shellOk = hooked.length > 0 && (!data.shells.invoking || hooked.some(function (h) {
      return h.shell === data.shells.invoking && h.installed;
    }));
    put('pillShell', '<span class="dot ' + (shellOk ? 'ok' : 'warn') + '"></span><span>hooks: ' +
      (hooked.length ? hooked.map(function (h) { return h.shell; }).join(', ') : 'none') +
      (data.shells.invoking ? ' · this shell ' + esc(data.shells.invoking) : '') + '</span>');
    put('pillLlm', '<span class="dot ' + (data.llm.ready ? 'ok' : 'warn') + '"></span><span>llm: ' +
      esc(data.llm.provider === 'none' ? 'disabled' : data.llm.model) +
      (data.llm.ready ? ' ready' : ' not installed') + '</span>');
    var t = data.totals;
    put('pillData', '<span class="dot ok"></span><span>' + t.projects + ' projects · ' + t.events + ' events · ' +
      t.commits + ' commits · ' + t.chatTurns + ' chat · ' + t.embeddings + ' vectors</span>');
    if (data.warnings && data.warnings.length) {
      put('warnings', '<div class="warnbox"><b>Capture health</b><ul>' + data.warnings.map(function (w) {
        return '<li>' + esc(w) + '</li>';
      }).join('') + '</ul></div>');
    } else {
      put('warnings', '');
    }
    renderProjects();
    if (current !== null) {
      var still = data.projects.filter(function (p) { return p.id === current; })[0];
      if (still) renderDetail(still);
      else { current = null; put('detail', '<span class="muted">Pick a project on the left.</span>'); }
    }
  }).catch(function (err) {
    put('warnings', '<div class="warnbox bad"><b>UI server unreachable</b>' +
      '<div style="margin-top:6px">' + esc(err.message) + '</div>' +
      '<div class="muted" style="margin-top:6px;font-size:12px">This page keeps its data in a local server bound ' +
      'to 127.0.0.1. Closing its terminal window stops it.</div>' +
      '<div style="margin-top:8px"><button onclick="loadState()">Retry now</button></div></div>');
    put('pillDaemon', '<span class="dot bad"></span><span>server offline</span>');
  });
}

function renderProjects() {
  if (!state || !state.projects.length) {
    put('projects', '<span class="muted">Nothing registered yet. Pick a folder above — git repos are tagged green.</span>');
    return;
  }
  put('projects', state.projects.map(function (p) {
    return '<div class="project' + (p.id === current ? ' active' : '') + '" data-project="' + p.id +
      '" onclick="selectFromCard(this)">' +
      '<div class="name">' + esc(p.name) + ' <span class="tag">#' + p.id + '</span>' +
      (p.watched ? ' <span class="tag reg">watched</span>' : '') +
      (p.hook ? ' <span class="tag git">hook</span>' : '') +
      (!p.exists ? ' <span class="tag bad">missing</span>' : '') + '</div>' +
      '<div class="path">' + esc(p.path) + '</div>' +
      (p.summary ? '<div class="meta">' + esc(p.summary).slice(0, 200) + '</div>' : '') +
      '<div class="meta">' + (p.stack ? esc(p.stack) + ' · ' : '') + p.events + ' events · ' + p.commits +
      ' commits · ' + p.briefs + ' briefs · last ' + rel(p.lastSeenAt) + '</div></div>';
  }).join(''));
}
function selectFromCard(node) { selectProject(Number(node.getAttribute('data-project'))); }

function selectProject(id) {
  current = id;
  tab = 'overview';
  renderProjects();
  var found = state.projects.filter(function (p) { return p.id === id; })[0];
  if (found) renderDetail(found);
}

function renderDetail(project) {
  var tabs = ['overview', 'brief', 'timeline', 'ask'];
  var head = '<div class="row" style="justify-content:space-between">' +
    '<div><div style="font-weight:700;font-size:15px">' + esc(project.name) + '</div>' +
    '<div class="muted mono" style="font-size:12px">' + esc(project.path) + '</div></div>' +
    '<div class="row"><button data-project="' + project.id + '" onclick="refreshFromButton(this)">Re-scan</button>' +
    '<button data-project="' + project.id + '" onclick="unregisterFromButton(this)">Unregister</button></div></div>' +
    '<div class="tabs" style="margin-top:12px">' + tabs.map(function (name) {
      return '<button class="' + (tab === name ? 'active' : '') + '" data-tab="' + name + '" data-project="' +
        project.id + '" onclick="tabFromButton(this)">' + name + '</button>';
    }).join('') + '</div>';
  var body = '';
  if (tab === 'overview') body = overviewHtml(project);
  else if (tab === 'brief') body = briefHtml(project);
  else if (tab === 'timeline') body = timelineHtml(project);
  else body = askHtml(project);
  put('detail', head + body);
  if (tab === 'brief') {
    if (briefCache[project.id]) put('briefBody', briefCache[project.id]);
    else if (briefPending[project.id]) put('briefBody', '<span class="spin">Generating…</span>');
    else loadBrief(project.id, false);
  }
  if (tab === 'timeline') {
    if (timelineCache[project.id]) {
      put('timelineInfo', timelineInfoCache[project.id] || '');
      put('timelineBody', timelineCache[project.id]);
    } else if (timelinePending[project.id]) put('timelineBody', '<span class="spin">Loading…</span>');
    else loadTimeline(project.id, 7);
  }
}

function setTab(id, name) {
  tab = name;
  var found = state.projects.filter(function (p) { return p.id === id; })[0];
  if (found) renderDetail(found);
}

function overviewHtml(project) {
  var rows = [
    ['summary', project.summary || 'not analysed yet — click Re-scan'],
    ['stack', project.stack || 'unknown'],
    ['remote', project.gitRemote || 'none'],
    ['last activity', rel(project.lastSeenAt)],
    ['captured', project.events + ' events · ' + project.commits + ' commits · ' + project.decisions + ' decisions'],
    ['watching', project.watched ? 'yes — the daemon is following this folder' : 'no — start the daemon'],
    ['commit hook', project.hook ? 'installed' : 'not installed']
  ];
  return '<div class="kv">' + rows.map(function (pair) {
    return '<div class="k">' + esc(pair[0]) + '</div><div>' + esc(pair[1]) + '</div>';
  }).join('') + '</div><div class="spacer"></div>' +
  '<div class="muted" style="font-size:12px">This is what was stored on the project row at register time and ' +
  'indexed for recall. "Re-scan" refreshes it from the folder on disk.</div>';
}

function briefHtml(project) {
  return '<div class="row"><button class="primary" data-project="' + project.id +
    '" onclick="briefFromButton(this)">Generate brief</button>' +
    '<label class="muted" style="font-size:12px"><input type="checkbox" id="useAi"> use the local LLM (' +
    esc(state.llm.model) + (state.llm.ready ? '' : ' — not installed') + ')</label></div>' +
    '<div class="spacer"></div><div id="briefBody" class="md">Loading…</div>';
}

function loadBrief(id, ai) {
  briefPending[id] = true;
  var checkbox = el('useAi');
  var useAi = ai || (checkbox && checkbox.checked) ? '1' : '0';
  put('briefBody', '<span class="spin">Generating…</span>');
  api('/api/brief?project=' + id + '&ai=' + useAi).then(function (data) {
    var html = markdown(data.text);
    if (data.llm && !data.llm.used && data.llm.reason) {
      html += '<div class="spacer"></div><div class="dim">LLM summary skipped: ' + esc(data.llm.reason) + '</div>';
    }
    delete briefPending[id];
    briefCache[id] = html;
    put('briefBody', html);
  }).catch(function (err) {
    delete briefPending[id];
    put('briefBody', '<span class="bad">' + esc(err.message) + '</span>');
  });
}

function timelineHtml(project) {
  return '<div class="row"><span class="muted" style="font-size:12px">last</span>' +
    ['1', '7', '30', '365'].map(function (days) {
      return '<button data-project="' + project.id + '" data-days="' + days + '" onclick="timelineFromButton(this)">' +
        days + 'd</button>';
    }).join('') + '<span class="muted" style="font-size:12px" id="timelineInfo"></span></div>' +
    '<div class="spacer"></div><div id="timelineBody">Loading…</div>';
}

function loadTimeline(id, days) {
  timelinePending[id] = true;
  put('timelineBody', '<span class="spin">Loading…</span>');
  api('/api/timeline?project=' + id + '&days=' + days + '&limit=80').then(function (data) {
    var info = data.entries.length + ' entries in ' + days + ' day(s)';
    timelineInfoCache[id] = info;
    put('timelineInfo', info);
    if (!data.entries.length) {
      var empty = '<span class="muted">Nothing captured in this window. If you expected commands here, ' +
        'check the shell hooks and the daemon in the capture-health banner above.</span>';
      delete timelinePending[id];
      timelineCache[id] = empty;
      put('timelineBody', empty);
      return;
    }
    var html = data.entries.map(function (entry) {
      return '<div class="entry-line"><span class="t">' + esc(new Date(entry.ts).toLocaleString()) + '</span> ' +
        '<span class="badge ' + esc(entry.kind) + '">' + esc(entry.kind) + '</span> ' +
        '<span class="mono">' + esc(entry.text) + '</span>' +
        (entry.detail ? '<div class="muted mono" style="font-size:12px;padding-left:8px">' + esc(entry.detail) +
          '</div>' : '') + '</div>';
    }).join('');
    delete timelinePending[id];
    timelineCache[id] = html;
    put('timelineBody', html);
  }).catch(function (err) {
    delete timelinePending[id];
    put('timelineBody', '<span class="bad">' + esc(err.message) + '</span>');
  });
}

function askHtml(project) {
  return '<div class="row"><input type="text" id="askInput" data-project="' + project.id +
    '" placeholder="what does this project do?" onkeydown="askOnEnter(event)">' +
    '<button class="primary" data-project="' + project.id + '" onclick="askFromButton(this)">Ask</button></div>' +
    '<div class="spacer"></div><div id="askBody" class="muted">Recall searches project overviews, decisions, ' +
    'commits, commands and chat history.</div>';
}

function hitSnippet(hit) {
  var lines = hit.text.split(NEWLINE);
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('summary:') === 0) return lines[i].slice(9);
  }
  var text = hit.text;
  // Indexed commit documents read "commit <hash> by <author>: <subject>".
  if (text.indexOf('commit ') === 0) {
    var cut = text.indexOf(': ');
    if (cut > 0) text = text.slice(cut + 2);
  }
  return text;
}

function runAsk(id) {
  var query = el('askInput').value.trim();
  if (!query) return;
  put('askBody', '<span class="spin">Searching…</span>');
  api('/api/ask?project=' + id + '&q=' + encodeURIComponent(query)).then(function (data) {
    var head = '<div class="muted mono" style="font-size:12px">' + esc(data.embedder) + ' · ' + data.lexicalCount +
      ' lexical / ' + data.vectorCount + ' vector candidates · best similarity ' + data.bestVectorScore.toFixed(2) +
      '</div>';
    if (data.weak) {
      head += '<div class="warn" style="font-size:12px;margin-top:6px">No keyword match — these are semantic ' +
        'near-misses, not exact answers. Try words that appear in your notes.</div>';
    }
    if (!data.hits.length) { put('askBody', head + '<div class="spacer"></div>No matches.'); return; }
    put('askBody', head + data.hits.map(function (hit, index) {
      return '<div class="entry-line"><span class="t">' + (index + 1) + '.</span> ' +
        '<span class="badge ' + esc(hit.ownerType) + '">' + esc(hit.ownerType) + '</span> ' +
        '<span class="t">' + rel(hit.ts) + ' · ' + esc(hit.via.join('+')) + '</span>' +
        '<div class="mono">' + esc(hitSnippet(hit).slice(0, 300)) + '</div></div>';
    }).join(''));
  }).catch(function (err) { put('askBody', '<span class="bad">' + esc(err.message) + '</span>'); });
}

function markdown(text) {
  var html = esc(text);
  html = html.split('**').map(function (part, index) {
    return index % 2 === 1 ? '<strong>' + part + '</strong>' : part;
  }).join('');
  html = html.split(TICK).map(function (part, index) {
    return index % 2 === 1 ? '<code>' + part + '</code>' : part;
  }).join('');
  return html.split(NEWLINE).map(function (line) {
    // Italics only when the underscores are not glued to word characters,
    // so a file like online_learning.py keeps its underscores.
    var styled = line.replace(
      /(^|[^A-Za-z0-9_])_([^_]+)_($|[^A-Za-z0-9_])/g,
      '$1<span class="dim">$2</span>$3'
    );
    if (line.indexOf('# ') === 0) return '<div class="h1">' + styled.slice(2) + '</div>';
    if (line.indexOf('## ') === 0) return '<div class="h2">' + styled.slice(3) + '</div>';
    // Indented bullets are detail lines (e.g. the files a commit touched).
    // NB: no regex escapes here — the template literal eats the backslash.
    var indented = line.length > 2 && line.charAt(0) === ' ' && line.trim().indexOf('- ') === 0;
    if (indented) return '<div class="sub">• ' + styled.trim().slice(2) + '</div>';
    if (line.indexOf('- ') === 0) return '<div class="bullet">• ' + styled.slice(2) + '</div>';
    return '<div>' + styled + '</div>';
  }).join('');
}

function browse(target) {
  var path = target === undefined ? (el('folderPath').value.trim() || null) : target;
  put('browser', '<div class="entry"><span class="muted">loading…</span></div>');
  api('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : '')).then(function (data) {
    put('browsePath', data.path ? esc(data.path) : 'pick a drive');
    if (data.path) el('folderPath').value = data.path;
    var rows = [];
    if (data.roots && data.roots.length) {
      rows = data.roots.map(function (root) {
        return '<div class="entry" data-path="' + attr(root.path) + '" onclick="browseEntry(this)">💽 ' +
          esc(root.name) + '</div>';
      });
    } else {
      if (data.parent) {
        rows.push('<div class="entry" data-path="' + attr(data.parent) + '" onclick="browseEntry(this)">⬆ ' +
          '<span class="muted">..</span> <span class="muted mono">' + esc(data.parent) + '</span></div>');
      }
      rows = rows.concat(data.entries.map(function (entry) {
        return '<div class="entry" data-path="' + attr(entry.path) + '" onclick="browseEntry(this)">📁 ' +
          esc(entry.name) + (entry.isGit ? ' <span class="tag git">git</span>' : '') +
          (entry.registered ? ' <span class="tag reg">tracked</span>' : '') + '</div>';
      }));
    }
    put('browser', rows.length ? rows.join('') : '<div class="entry"><span class="muted">no subfolders</span></div>');
  }).catch(function (err) { put('browser', '<div class="entry bad">' + esc(err.message) + '</div>'); });
}

function registerFolder() {
  var path = el('folderPath').value.trim();
  if (!path) { put('registerReport', '<div class="report bad">Enter or pick a folder first.</div>'); return; }
  put('registerReport', '<div class="report spin">Scanning the folder, backfilling git history and indexing…</div>');
  api('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: path, name: el('folderName').value.trim() || undefined })
  }).then(function (data) {
    var p = data.profile;
    var rows = [
      ['project', data.project.name + ' (id ' + data.project.id + ')'],
      ['summary', p.summary],
      ['stack', p.stack.join(', ') || 'unknown'],
      ['languages', p.languages.slice(0, 5).map(function (l) { return l.language + ' (' + l.files + ')'; }).join(', ') || 'none'],
      ['git', p.isGitRepo ? (p.remote || 'no remote') + (p.branch ? ' · ' + p.branch : '') : 'not a repo'],
      ['layout', p.topLevel.slice(0, 12).join(' ') || 'none'],
      ['entry points', p.entryPoints.join(', ') || 'none'],
      ['commits', data.commitsInserted + ' new · ' + data.commitsScanned + ' scanned · ' + data.commitsIndexed + ' indexed'],
      ['commit hook', data.hook && data.hook.installed ? 'installed' : 'not installed'],
      ['watching', data.watched ? 'yes' : 'no']
    ];
    put('registerReport', '<div class="report"><b>' + (data.created ? 'Registered ' : 'Refreshed ') +
      esc(data.project.name) + '</b><div class="kv" style="margin-top:8px">' + rows.map(function (pair) {
        return '<div class="k">' + esc(pair[0]) + '</div><div>' + esc(pair[1]) + '</div>';
      }).join('') + '</div>' +
      (data.warnings.length ? '<div class="warn" style="margin-top:8px">' +
        data.warnings.map(function (w) { return esc(w); }).join('<br>') + '</div>' : '') + '</div>');
    loadState();
    selectProject(data.project.id);
  }).catch(function (err) {
    put('registerReport', '<div class="report bad">' + esc(err.message) + '</div>');
  });
}

function refreshProject(id) {
  put('detail', '<span class="spin">Re-scanning the folder…</span>');
  api('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: id }) }).then(function () { loadState(); })
    .catch(function (err) { put('detail', '<span class="bad">' + esc(err.message) + '</span>'); });
}

function unregisterProject(id) {
  var found = state.projects.filter(function (p) { return p.id === id; })[0];
  if (!window.confirm('Stop tracking ' + (found ? found.name : 'this project') + ' and delete its captured data?')) return;
  api('/api/unregister', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: id }) }).then(function () {
    current = null;
    put('detail', '<span class="muted">Unregistered.</span>');
    loadState();
  }).catch(function (err) { put('detail', '<span class="bad">' + esc(err.message) + '</span>'); });
}

function startDaemon() {
  api('/api/daemon', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start' }) }).then(function () { setTimeout(loadState, 1200); });
}
function stopDaemon() {
  api('/api/daemon', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }) }).then(function () { setTimeout(loadState, 400); });
}
function installHooks() {
  api('/api/shell/install', { method: 'POST' }).then(function (data) {
    var lines = data.shells.map(function (s) { return s.shell + ' -> ' + s.rcFile; });
    window.alert('Installed capture hooks:' + NEWLINE + lines.join(NEWLINE) + NEWLINE + NEWLINE +
      'Open a new terminal so the hooks load.');
    loadState();
  });
}

loadState();
setInterval(loadState, 20000);
</script>
</body>
</html>
`;
}
