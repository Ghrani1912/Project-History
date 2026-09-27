/**
 * The whole UI is one self-contained page: no build step, no CDN, no framework.
 * It talks to the loopback JSON API in server.ts and carries the per-run token
 * so a random website cannot drive the local server.
 *
 * Visual language: a dark "Second Brain OS" workbench — fixed sidebar of
 * connected workspaces, a top bar with timeline category filters, and a 38/62
 * split of Auto-Brief (left) against the Unified Timeline (right). It mirrors
 * the design mockup, but every pixel is fed by the real endpoints; there is no
 * Tailwind CDN or web-font pull, because the panel must run with the machine
 * offline (test/ui.test.ts enforces that).
 *
 * Hard rules for the client script below, because it lives inside a TypeScript
 * template literal:
 *  - no backticks and no `${` (except the deliberate token and git-scheme
 *    injections from renderPage's arguments/imports),
 *  - no backslash escapes of any kind (the template literal would eat them),
 *  - inline handlers take no arguments; they read `data-*` attributes instead,
 *    so no nested quote escaping is ever needed.
 * test/ui.test.ts compiles the emitted script with `vm.Script` to keep this honest.
 */
import { GIT_URL_SCHEMES } from '../git/remote.js';

export function renderPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Second Brain OS</title>
<style>
  :root {
    --bg: #10141a; --surf: #10141a; --surf-low: #181c22; --surf-con: #1c2026;
    --surf-high: #262a31; --surf-highest: #31353c;
    --fg: #dfe2eb; --fg2: #c7c4d7; --outline: #908fa0; --line: #464554;
    --primary: #c0c1ff; --primary-con: #8083ff; --on-primary-con: #0d0096;
    --secondary: #7bd0ff; --secondary-con: #00a6e0; --on-secondary-con: #00374d;
    --tertiary: #ddb7ff; --tertiary-con: #b76dff;
    --error: #ffb4ab; --error-con: #93000a; --on-error-con: #ffdad6;
    --green: #3fb950;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg); min-height: 100vh;
    font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased;
    --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, "Liberation Mono", monospace;
  }
  a { color: var(--secondary); }
  ::selection { background: var(--primary-con); color: var(--on-primary-con); }
  code, .mono { font-family: var(--mono); font-size: 12.5px; }
  code { background: var(--surf-con); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
  h1, h2, h3 { margin: 0; }
  button { font-family: inherit; }
  .grow { flex: 1; }
  .muted { color: var(--outline); }
  .small { font-size: 12px; }
  .ok { color: var(--green); } .warn { color: var(--tertiary); } .bad { color: var(--error); }
  .mono-label { font-family: var(--mono); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }

  /* ------------------------------ sidebar ------------------------------ */
  .sidebar {
    position: fixed; inset: 0 auto 0 0; width: 272px; z-index: 50;
    background: var(--surf-low); border-right: 1px solid #22262e;
    display: flex; flex-direction: column; justify-content: space-between;
    box-shadow: 0 1px 8px rgba(0,0,0,.35);
  }
  .side-top { display: flex; flex-direction: column; gap: 10px; padding: 14px; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 2px; }
  .brand-mark {
    width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
    background: linear-gradient(135deg, var(--primary-con), var(--tertiary-con)); font-size: 18px;
  }
  .brand-name { font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
  .brand-status { display: flex; align-items: center; gap: 5px; margin-top: 2px;
    font-family: var(--mono); font-size: 10px; letter-spacing: .08em; color: var(--secondary); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--outline); flex: none; display: inline-block; }
  .dot.ok { background: var(--secondary); box-shadow: 0 0 7px var(--secondary); }
  .dot.warn { background: var(--tertiary); box-shadow: 0 0 7px var(--tertiary); }
  .dot.bad { background: var(--error); box-shadow: 0 0 7px var(--error); }
  .palette-open {
    width: 100%; display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; border-radius: 9px; cursor: pointer;
    background: var(--surf-con); border: 1px solid #2b3038; color: var(--fg2); font-size: 13px;
  }
  .palette-open:hover { color: var(--fg); background: var(--surf-high); }
  .palette-open kbd, kbd {
    font-family: var(--mono); font-size: 10.5px; padding: 2px 6px; border-radius: 5px;
    background: var(--surf-highest); color: var(--outline); border: 1px solid #3a3f48;
  }
  .btn {
    border: 1px solid var(--line); background: var(--surf-con); color: var(--fg);
    border-radius: 8px; padding: 7px 12px; font-size: 13px; cursor: pointer;
  }
  .btn:hover { border-color: var(--secondary); }
  .btn.primary {
    background: var(--primary-con); border-color: var(--primary-con); color: var(--on-primary-con);
    font-weight: 600; box-shadow: 0 0 12px rgba(128,131,255,.25);
  }
  .btn.primary:hover { background: var(--primary); border-color: var(--primary); }
  .btn.block { width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .ws-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 4px 0; color: var(--outline);
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase;
  }
  .ws-list { display: flex; flex-direction: column; gap: 3px; overflow-y: auto; }
  .ws {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 9px; border-radius: 8px; cursor: pointer; color: var(--fg2);
    border: 1px solid transparent;
  }
  .ws:hover { background: var(--surf-con); color: var(--fg); }
  .ws.active {
    background: var(--surf-con); color: var(--fg); font-weight: 600;
    border-color: #2f3540; box-shadow: 0 0 10px rgba(123,208,255,.12);
  }
  .ws-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ws-name span:last-child, .ws-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ws-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--outline); flex: none; }
  .ws-dot.ok { background: var(--secondary); box-shadow: 0 0 6px var(--secondary); }
  .ws-dot.warn { background: var(--tertiary); }
  .ws-dot.bad { background: var(--error); }
  .ws-tag {
    font-family: var(--mono); font-size: 10px; padding: 2px 6px; border-radius: 5px;
    background: var(--surf-high); color: var(--outline); flex: none;
  }
  .ws.active .ws-tag { color: var(--secondary); }
  .ws-actions { display: flex; align-items: center; gap: 2px; flex: none; }
  /* Unregister sits on every row, revealed on hover so the sidebar stays
     clean but the control is one click away on the row itself. */
  .ws-x {
    border: none; background: transparent; color: var(--outline); cursor: pointer;
    font-size: 12px; line-height: 1; padding: 3px 6px; border-radius: 5px; opacity: 0;
    transition: opacity .12s ease;
  }
  .ws:hover .ws-x, .ws.active .ws-x { opacity: .75; }
  .ws-x:hover { opacity: 1; background: #3a1414; color: var(--error); }
  .ws-ro {
    font-family: var(--mono); font-size: 8.5px; padding: 1px 4px; border-radius: 4px;
    background: #33290f; color: #ffd479; margin-left: 5px; vertical-align: 1px;
  }
  .side-foot {
    margin: 10px; padding: 12px; border-radius: 12px; background: rgba(24,28,34,.7);
    border: 1px solid #242931; display: flex; flex-direction: column; gap: 6px;
  }
  .foot-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
  .foot-row .mono-label { color: var(--outline); }

  /* ------------------------------ shell ------------------------------ */
  .shell { margin-left: 272px; min-height: 100vh; display: flex; flex-direction: column; }
  .topbar {
    position: sticky; top: 0; z-index: 40; min-height: 62px; display: flex; align-items: center;
    flex-wrap: wrap; row-gap: 4px; gap: 16px; padding: 8px 22px; background: rgba(16,20,26,.85);
    backdrop-filter: blur(14px); border-bottom: 1px solid #22262e;
  }
  .crumbs { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; white-space: nowrap; }
  .crumbs .sep { color: var(--line); }
  .crumb-active { color: var(--fg); font-weight: 600; }
  .topnav { display: flex; align-items: center; gap: 4px; margin-left: 6px; flex-wrap: wrap; max-width: 100%; }
  .navbtn {
    border: 1px solid transparent; background: none; color: var(--fg2); cursor: pointer;
    padding: 5px 10px; border-radius: 8px; font-size: 13px; white-space: nowrap;
  }
  /* The tabs scroll sideways on narrow windows, but the bar itself stays
     invisible so the row reads as one clean strip. */
  .topnav { scrollbar-width: none; }
  .topnav::-webkit-scrollbar { display: none; }
  .navbtn:hover { color: var(--fg); background: var(--surf-con); }
  .navbtn.active { background: var(--surf-con); color: var(--fg); font-weight: 600; border-color: #2f3540; }
  .top-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pill {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px;
    background: var(--surf-low); border: 1px solid #272c34; font-size: 12px; color: var(--fg2);
  }

  main { flex: 1; padding: 18px 22px 70px; }
  .statbar {
    display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    padding: 10px 14px; border-radius: 12px; background: var(--surf-low);
    border: 1px solid #242931; margin-bottom: 16px;
  }
  .stat-left { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .live-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--secondary);
    box-shadow: 0 0 9px var(--secondary); animation: pulse 1.8s ease-in-out infinite; flex: none; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  .stat-figs { margin-left: auto; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    font-family: var(--mono); font-size: 11px; color: var(--outline); }

  .split { display: grid; grid-template-columns: 38fr 62fr; gap: 18px; align-items: start; }
  .split.single { grid-template-columns: 1fr; }
  .col-left, .col-right { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
  .empty { grid-column: 1 / -1; color: var(--outline); padding: 40px 8px; text-align: center; }

  .card {
    background: var(--surf-low); border: 1px solid #242931; border-radius: 14px;
    padding: 16px; box-shadow: 0 1px 8px rgba(0,0,0,.25); position: relative;
  }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  .card-head h2 { font-size: 16px; font-weight: 650; letter-spacing: -.01em; display: flex; align-items: center; gap: 8px; }
  .ico { font-size: 15px; line-height: 1; }
  .card-sub { margin: 0 0 8px; }
  .panel { background: var(--surf-con); border: 1px solid #232830; border-radius: 10px; padding: 12px; }
  .panel + .panel { margin-top: 8px; }
  .panel-label { display: block; margin-bottom: 8px; color: var(--outline);
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; }
  .warnbox {
    background: #2a2113; border: 1px solid #5c4a1a; border-radius: 12px;
    padding: 12px 16px; margin-bottom: 16px;
  }
  .warnbox.bad { background: #2c1414; border-color: #6b2a2a; }
  .warnbox ul { margin: 6px 0 0; padding-left: 20px; }
  .warnbox li { margin: 4px 0; }

  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  input[type=text] {
    background: #0b1017; color: var(--fg); border: 1px solid #2b3038;
    border-radius: 8px; padding: 8px 10px; font: inherit; width: 100%;
  }
  input[type=text]:focus { outline: none; border-color: var(--secondary); }
  .ghost {
    background: var(--surf-con); border: 1px solid #2b3038; color: var(--fg2);
    border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer;
  }
  .ghost:hover { color: var(--fg); border-color: var(--secondary); }
  .ghost.tiny { padding: 3px 7px; font-size: 11px; }
  .ghost.active { background: var(--primary-con); color: var(--on-primary-con); border-color: var(--primary-con); font-weight: 600; }
  .btn[disabled] { opacity: .38; cursor: default; pointer-events: none; }
  .toast {
    position: fixed; right: 18px; bottom: 18px; z-index: 60;
    background: var(--surf-con); border: 1px solid #2b3038; border-radius: 12px;
    box-shadow: 0 12px 34px rgba(0,0,0,.5); padding: 12px 16px; max-width: 380px;
    font-size: 12.5px;
  }
  .toast b { display: block; margin-bottom: 4px; }
  .toast .mono { color: var(--fg2); }
  .toast .toast-x { float: right; margin-left: 12px; cursor: pointer; color: var(--outline); }
  .toast .toast-x:hover { color: var(--fg); }
  .ai-toggle { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--outline); margin: 4px 0 10px; }
  .ai-toggle input { accent-color: var(--primary-con); }

  .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0; }
  .metric { display: flex; flex-direction: column; padding: 9px 10px; border-radius: 9px; background: var(--surf-high); }
  .metric b { font-size: 18px; font-weight: 650; }
  .metric span { font-family: var(--mono); font-size: 10px; color: var(--outline); text-transform: uppercase; letter-spacing: .05em; }
  .metric.m1 b { color: var(--secondary); } .metric.m2 b { color: var(--primary); }
  .metric.m3 b { color: var(--tertiary); } .metric.m4 b { color: var(--green); }

  .kv { display: grid; grid-template-columns: 118px 1fr; gap: 5px 10px; font-size: 13px; }
  .kv .k { color: var(--outline); }
  .kv .v { word-break: break-word; }
  .md {
    font-family: var(--mono); font-size: 12.5px; white-space: pre-wrap; word-break: break-word;
    background: #0b1017; border: 1px solid #232830; border-radius: 10px; padding: 12px;
  }
  .md .h1 { color: #fff; font-weight: 700; font-size: 14px; }
  .md .h2 { color: var(--secondary); font-weight: 600; margin-top: 10px; }
  .md .dim { color: var(--outline); }
  .md .bullet { padding-left: 12px; }
  .md .sub { padding-left: 26px; color: var(--fg2); }
  .answer {
    background: #0b1017; border: 1px solid #232830; border-radius: 10px; padding: 14px;
    font-size: 13.5px; line-height: 1.7; color: var(--fg);
  }
  .answer .h1 { color: #fff; font-weight: 700; font-size: 15px; }
  .answer .h2 { margin-top: 12px; color: var(--secondary); font-family: var(--mono);
    font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  .answer .bullet { padding-left: 16px; }
  .answer .dim { color: var(--outline); }
  .answer-foot { margin-top: 12px; padding-top: 8px; border-top: 1px solid #232830;
    color: var(--outline); font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em; }

  /* ------------------------------ timeline ------------------------------ */
  .tl-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .search {
    flex: 1; display: flex; align-items: center; gap: 8px; background: var(--surf-con);
    border: 1px solid #2b3038; border-radius: 9px; padding: 6px 10px;
  }
  .search input { border: none; background: transparent; padding: 2px 0; }
  .search input:focus { border: none; }
  .search-ico { color: var(--secondary); font-size: 15px; }
  .live-pill { color: var(--secondary); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
  .chip {
    border: 1px solid transparent; background: var(--surf-con); color: var(--fg2); cursor: pointer;
    font-family: var(--mono); font-size: 11px; padding: 5px 9px; border-radius: 7px;
  }
  .chip:hover { color: var(--fg); background: var(--surf-high); }
  .chip.active { background: var(--primary-con); color: var(--on-primary-con); font-weight: 600; }
  .chip-n { opacity: .8; }
  .tl-days { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
  .tl-days .muted { margin-left: auto; font-size: 12px; }

  .stream { position: relative; padding-left: 22px; display: flex; flex-direction: column; gap: 12px; }
  .stream::before {
    content: ""; position: absolute; left: 7px; top: 6px; bottom: 6px; width: 2px;
    background: linear-gradient(180deg, var(--secondary), var(--primary-con), var(--surf-highest));
    opacity: .55;
  }
  .tl-item { position: relative; }
  .tl-node {
    position: absolute; left: -22px; top: 16px; width: 14px; height: 14px; border-radius: 50%;
    background: var(--surf-high); display: grid; place-items: center; z-index: 1;
  }
  .tl-node span { width: 6px; height: 6px; border-radius: 50%; background: var(--secondary); }
  .tl-node.commit span { background: var(--tertiary); }
  .tl-node.decision span { background: var(--primary); }
  .tl-node.file span { background: var(--secondary); }
  .tl-node.chat span { background: var(--tertiary); }
  .tl-node.error span { background: var(--error); }
  .tl-card {
    background: var(--surf-low); border: 1px solid #242931; border-radius: 12px;
    padding: 12px 14px; box-shadow: 0 1px 6px rgba(0,0,0,.25);
  }
  .tl-card:hover { border-color: #333a45; }
  .tl-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .clock { font-family: var(--mono); font-size: 11px; color: var(--outline); }
  .tl-src { font-family: var(--mono); font-size: 11px; color: var(--outline); }
  .badge {
    font-family: var(--mono); font-size: 10px; letter-spacing: .05em; text-transform: uppercase;
    padding: 2px 7px; border-radius: 6px; background: var(--surf-high); color: var(--outline); font-weight: 600;
  }
  .badge.cmd { background: #16283d; color: var(--secondary); }
  .badge.commit { background: #2b1a37; color: var(--tertiary); }
  .badge.decision { background: #10312f; color: #6ff0e6; }
  .badge.file { background: #1f2937; color: var(--fg2); }
  .badge.chat { background: #33290f; color: #ffd479; }
  .badge.error { background: #3a1414; color: var(--error); }
  .tl-text { font-family: var(--mono); font-size: 12.5px; color: var(--fg); word-break: break-word; }
  .tl-text::before { content: "$ "; color: var(--secondary); }
  .tl-text.plain::before { content: none; }
  .tl-detail {
    margin-top: 6px; font-family: var(--mono); font-size: 11.5px; color: var(--outline);
    white-space: pre-wrap; word-break: break-word; background: var(--surf-con);
    border-radius: 8px; padding: 8px 10px;
  }
  .entry-line { padding: 8px 0; border-bottom: 1px solid #1d222a; }
  .entry-line:last-child { border-bottom: none; }

  /* ------------------------------ modals ------------------------------ */
  .modal {
    position: fixed; inset: 0; z-index: 80; display: flex;
    align-items: flex-start; justify-content: center; padding: 60px 16px 16px;
    background: rgba(10,14,20,.82); backdrop-filter: blur(8px); overflow-y: auto;
  }
  .modal.hidden { display: none; }
  .modal-panel {
    width: 100%; max-width: 560px; background: var(--surf-low); border: 1px solid #2b3038;
    border-radius: 16px; padding: 18px; box-shadow: 0 20px 60px rgba(0,0,0,.75);
  }
  .modal-panel.palette-panel { max-width: 680px; padding: 0; overflow: hidden; }
  .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .modal-head h2 { font-size: 17px; font-weight: 650; }
  .palette-top { height: 3px; background: linear-gradient(90deg, var(--primary), var(--secondary), var(--tertiary)); }
  .palette-input-row { display: flex; align-items: center; gap: 10px; padding: 14px 16px; }
  .palette-input-row input { border: none; background: transparent; font-size: 17px; padding: 4px 0; }
  .palette-input-row input:focus { border: none; }
  .palette-body { padding: 0 16px 16px; max-height: 62vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
  .browser { max-height: 240px; overflow: auto; border: 1px solid #232830; border-radius: 9px;
    background: #0b1017; margin-top: 10px; }
  .browser div.entry { padding: 7px 10px; cursor: pointer; display: flex; gap: 8px; align-items: center;
    border-bottom: 1px solid #141a22; font-size: 13px; }
  .browser div.entry:hover { background: #172030; }
  .report { margin-top: 12px; background: var(--surf-con); border: 1px solid #2b3038; border-radius: 10px; padding: 12px; }
  .spin { color: var(--outline); font-size: 13px; padding: 8px 0; }
  .spacer { height: 8px; }
  .tag { font-family: var(--mono); font-size: 10px; letter-spacing: .05em; text-transform: uppercase;
    padding: 2px 7px; border-radius: 999px; background: var(--surf-high); color: var(--outline); }
  .tag.git { background: #14301c; color: var(--green); }
  .tag.reg { background: #16283d; color: var(--secondary); }
  .tag.bad { background: #3a1414; color: var(--error); }
  .badge.project { background: #14301c; color: var(--green); }

  @media (max-width: 1240px) {
    /* Keep the section tabs visible: give them their own full-width row and
       let them wrap onto more lines rather than hide or cut them off. */
    .topnav { order: 3; flex-basis: 100%; margin-left: 0; padding-bottom: 2px; }
  }
  @media (max-width: 1100px) {
    .split { grid-template-columns: 1fr; }
  }
  @media (max-width: 820px) {
    .sidebar { position: static; width: auto; flex-direction: column; }
    .shell { margin-left: 0; }
    .side-foot { display: none; }
    .ws-list { flex-direction: row; flex-wrap: wrap; }
    .metrics { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<aside class="sidebar">
  <div class="side-top">
    <div class="brand">
      <span class="brand-mark">🧠</span>
      <div>
        <div class="brand-name">Second Brain OS</div>
        <div class="brand-status" id="sideStatus"><span class="dot"></span><span>CONNECTING</span></div>
      </div>
    </div>
    <button class="palette-open" onclick="openPalette()">
      <span>⌘K Ask Brain…</span><kbd>⌘K</kbd>
    </button>
    <button class="btn primary block" onclick="openRegister()">＋ Register New Project</button>
    <div class="ws-head"><span>Connected Workspaces</span><span id="wsCount">…</span></div>
    <nav class="ws-list" id="projects"></nav>
  </div>
  <div class="side-foot">
    <div class="foot-row"><span class="mono-label">Local SQLite Synced</span><span id="dbSize" class="muted">…</span></div>
    <div class="foot-row"><span class="mono-label">Captured</span><span id="footTotals" class="muted">…</span></div>
  </div>
</aside>

<div class="shell">
  <header class="topbar">
    <div class="crumbs">
      <span class="muted">Projects</span><span class="sep">/</span>
      <span class="crumb-active" id="crumbName">none</span>
    </div>
    <nav class="topnav" id="topnav"></nav>
    <div class="top-actions">
      <span class="pill" id="pillDaemon"><span class="dot"></span><span>daemon …</span></span>
      <button class="btn" data-action="reload" onclick="daemonFromButton(this)">Refresh</button>
      <button class="btn" id="btnDaemonStart" onclick="daemonFromButton(this)" data-action="daemon-start">Start</button>
      <button class="btn" id="btnDaemonStop" onclick="daemonFromButton(this)" data-action="daemon-stop">Stop</button>
      <button class="btn" id="btnHooks" onclick="daemonFromButton(this)" data-action="install-hooks">Hooks</button>
    </div>
  </header>

  <main>
    <div id="warnings"></div>
    <div class="statbar">
      <div class="stat-left">
        <span class="live-dot"></span>
        <span class="mono-label" style="color:var(--secondary)">Continuous Engine</span>
        <span class="muted small" id="statContext">Select a workspace</span>
      </div>
      <div class="stat-figs">
        <span id="pillShell">hooks …</span>
        <span id="pillLlm">llm …</span>
        <span id="statFigs">…</span>
      </div>
    </div>
    <div id="detail"><div class="empty">Pick a workspace on the left to see its brief, related work, timeline and recall.</div></div>
  </main>
</div>

<div class="modal hidden" id="registerModal">
  <div class="modal-panel">
    <div class="modal-head"><h2>Track a folder or git link</h2><button class="ghost" onclick="closeRegister()">✕</button></div>
    <div class="row"><input type="text" id="folderPath" placeholder="C:/Users/me/projects/my-app  ·  https://github.com/owner/repo" onkeydown="submitFolder(event)" oninput="syncRegisterMode()"></div>
    <div class="row" style="margin-top:6px"><span id="registerHint" class="muted small"></span></div>
    <div class="row" style="margin-top:8px" id="browseRow">
      <button class="ghost" data-browse="typed" onclick="browseFromButton(this)">Browse…</button>
      <button class="ghost" data-browse="home" onclick="browseFromButton(this)">home</button>
      <span id="browsePath" class="muted mono small"></span>
    </div>
    <div class="browser" id="browser"></div>
    <div class="row" style="margin-top:10px">
      <input type="text" id="folderName" placeholder="optional name">
      <button class="btn primary" id="btnRegister" onclick="registerFolder()">Register folder</button>
    </div>
    <div id="registerReport"></div>
  </div>
</div>

<div class="modal hidden" id="palette">
  <div class="modal-panel palette-panel">
    <div class="palette-top"></div>
    <div class="palette-input-row">
      <span class="search-ico">⌕</span>
      <input type="text" id="paletteInput" placeholder="Ask Second Brain anything…" onkeydown="paletteOnEnter(event)">
      <button class="ghost" onclick="closePalette()">✕</button>
    </div>
    <div class="palette-body" id="paletteBody">
      <div class="muted small">Recall searches project overviews, decisions, commits, commands and chat history across every registered workspace.</div>
    </div>
  </div>
</div>

<script>
var TOKEN = '${token}';
var TICK = String.fromCharCode(96);
var NEWLINE = String.fromCharCode(10);
var BS = String.fromCharCode(92);
var homeDir = '';
var state = null;
var current = null;
// The same project sections the CLI and the earlier UI exposed, kept as the
// header tabs so muscle memory carries over.
var tabs = ['overview', 'brief', 'related', 'timeline', 'ask'];
var tab = 'overview';
var filter = 'all';
var search = '';
var days = 7;
// Rendered bodies are cached per project: the 20s state poll rebuilds the
// detail columns, and without a cache the brief would flash back to a spinner.
var briefCache = {};
var briefPending = {};
var relatedCache = {};
var relatedPending = {};
var checkCache = {};
var askCache = {};
var timelineData = {};
var timelineInfo = {};
var timelinePending = {};
var timelineWidened = {};
// The 20s state poll used to rebuild the sidebar and the whole detail panel
// every tick, which read as the page reloading: typed text vanished, the
// timeline search box emptied, scroll jumped. These signatures remember what
// is on screen so a poll that learned nothing new touches nothing.
var lastSidebarSig = '';
var lastDetailSig = '';
var lastWarningsSig = null;

function projectSig(p) {
  return [p.id, p.name, p.summary || '', p.stack || '', p.events, p.commits, p.decisions, p.briefs,
    p.watched ? 1 : 0, p.hook ? 1 : 0, p.exists ? 1 : 0, p.lastSeenAt || 0].join('|');
}
function sidebarSig() {
  if (!state) return '';
  return state.projects.map(projectSig).join(';') + '#' + current;
}
function detailSig(p) {
  return projectSig(p) + '#' + tab + '#' + (state.llm.ready ? 1 : 0) + '#' + (state.daemon.running ? 1 : 0);
}
function typingInDetail() {
  var active = document.activeElement;
  var detail = el('detail');
  return Boolean(active && detail && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') &&
    detail.contains(active));
}

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
function put(id, html) { var node = el(id); if (node) node.innerHTML = html; }
function rel(ts) {
  if (!ts) return 'never';
  var mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var daysAgo = Math.round(hours / 24);
  if (daysAgo < 30) return daysAgo + 'd ago';
  return Math.round(daysAgo / 30) + 'mo ago';
}
function clock(ts) {
  if (!ts) return 'never';
  var d = new Date(ts);
  var now = new Date();
  var time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time + ' Today';
  return d.toLocaleDateString() + ' · ' + time;
}
function attr(value) { return esc(value); }

/* ---------------------------- buttons ---------------------------- */
function daemonFromButton(button) {
  var action = button.getAttribute('data-action');
  if (action === 'daemon-start') return startDaemon();
  if (action === 'daemon-stop') return stopDaemon();
  if (action === 'install-hooks') return installHooks(button);
  return loadState();
}

// Start/Stop/Hooks only make sense in one daemon state each, so the buttons
// say so instead of accepting a click that does nothing.
function syncDaemonButtons(daemon) {
  var start = el('btnDaemonStart');
  var stop = el('btnDaemonStop');
  var hooks = el('btnHooks');
  if (start) start.disabled = Boolean(daemon.running);
  if (stop) stop.disabled = !daemon.running;
  if (hooks) {
    var installed = (state.shells && state.shells.hooks || []).some(function (h) { return h.installed; });
    hooks.disabled = installed;
    hooks.textContent = installed ? 'Hooks ✓' : 'Hooks';
  }
}

// Inline confirmation for actions like hook installation — an alert() blocks
// the page and cannot show which files changed, this can.
function toast(html, ms) {
  var old = el('brainToast');
  if (old) old.remove();
  var node = document.createElement('div');
  node.id = 'brainToast';
  node.className = 'toast';
  node.innerHTML = '<span class="toast-x" onclick="this.parentNode.remove()">✕</span>' + html;
  document.body.appendChild(node);
  if (ms) setTimeout(function () { node.remove(); }, ms);
}
function selectFromCard(node) { selectProject(Number(node.getAttribute('data-project'))); }
function tabFromButton(button) {
  tab = button.getAttribute('data-tab');
  var found = state.projects.filter(function (p) { return p.id === current; })[0];
  if (found) renderDetail(found);
}
function askFromButton(button) { runAsk(Number(button.getAttribute('data-project'))); }
function askOnEnter(event) { if (event.key === 'Enter') runAsk(Number(event.target.getAttribute('data-project'))); }
function refreshFromButton(button) { refreshProject(Number(button.getAttribute('data-project'))); }
function unregisterFromButton(button) { unregisterProject(Number(button.getAttribute('data-project'))); }
function unregisterFromSidebar(button) { unregisterProject(Number(button.getAttribute('data-project'))); }
function briefFromButton(button) { loadBrief(Number(button.getAttribute('data-project')), false); }
function checkFromButton(button) { runCheck(Number(button.getAttribute('data-project'))); }
function checkOnEnter(event) {
  if (event.key === 'Enter') runCheck(Number(event.target.getAttribute('data-project')));
}
function relatedFromButton(button) { loadRelated(Number(button.getAttribute('data-project'))); }
function timelineFromButton(button) {
  days = Number(button.getAttribute('data-days'));
  loadTimeline(Number(button.getAttribute('data-project')), days);
}
function onSearchInput(input) { search = input.value; renderTimeline(); }
function copyText(button) {
  var text = button.getAttribute('data-copy') || '';
  if (navigator.clipboard) navigator.clipboard.writeText(text);
  button.textContent = 'copied';
  setTimeout(function () { button.textContent = 'copy'; }, 1400);
}
function openRegister() {
  el('registerModal').classList.remove('hidden');
  browse('');
  syncRegisterMode();
}
function closeRegister() { el('registerModal').classList.add('hidden'); }
function browseFromButton(button) {
  var mode = button.getAttribute('data-browse');
  browse(mode === 'home' ? homeDir : (el('folderPath').value.trim() || null));
}
function browseEntry(node) { browse(node.getAttribute('data-path')); }
function submitFolder(event) { if (event.key === 'Enter') registerFolder(); }
// A git link registers a recall-only source (cloned for history and recall), so
// the local folder picker has nothing to offer. Detecting the shape as you type
// keeps the one dialog honest about which of the two paths you are on. The
// schemes are injected from the server rule (this script cannot import it), and
// test/ui.test.ts runs both over the same inputs so they cannot drift apart.
var URL_RE = /^(?:(${GIT_URL_SCHEMES}):[/][/][^/]+[/][^ ]|(git|ssh)@)/i;
function looksLikeUrl(value) {
  return URL_RE.test(value.trim());
}
function syncRegisterMode() {
  var url = looksLikeUrl(el('folderPath').value);
  var browseRow = el('browseRow');
  var browser = el('browser');
  if (browseRow) browseRow.style.display = url ? 'none' : '';
  if (browser) browser.style.display = url ? 'none' : '';
  var button = el('btnRegister');
  if (button) button.textContent = url ? 'Register git link' : 'Register folder';
  var hint = el('registerHint');
  if (hint) {
    hint.textContent = url
      ? 'Git link — cloned into the brain home for history and recall only; nothing is captured live.'
      : 'Local folder — live capture: commands, errors, file touches and the commit hook.';
  }
}
function openPalette() {
  el('palette').classList.remove('hidden');
  var input = el('paletteInput');
  if (input) input.focus();
}
function closePalette() { el('palette').classList.add('hidden'); }
function paletteOnEnter(event) { if (event.key === 'Enter') paletteAsk(); }
function paletteAsk() {
  var input = el('paletteInput');
  var query = input ? input.value.trim() : '';
  if (!query) return;
  put('paletteBody', '<div class="spin">Searching every workspace…</div>');
  api('/api/ask?q=' + encodeURIComponent(query) + '&limit=8').then(function (data) {
    if (!data.hits.length && !(data.answer && data.answer.text)) {
      put('paletteBody', '<div class="muted small">No matches across your captured history.</div>');
      return;
    }
    var parts = [];
    if (data.answer && data.answer.text) {
      parts.push('<div class="answer">' + markdown(data.answer.text) +
        '<div class="answer-foot">' + answerGeneratorLabel(data.answer) + '</div></div>');
    }
    var head = '<div class="muted small">' + esc(data.embedder) + ' · ' + data.lexicalCount +
      ' lexical / ' + data.vectorCount + ' vector candidates · best ' + data.bestVectorScore.toFixed(2) + '</div>';
    if (data.weak) {
      head += '<div class="warn small">No keyword match — the passages below are semantic near-misses.</div>';
    }
    parts.push(head);
    parts.push(data.hits.map(function (hit, index) {
      return '<div class="entry-line"><span class="clock">' + (index + 1) + '.</span> ' +
        '<span class="badge ' + esc(hit.ownerType) + '">' + esc(hit.ownerType) + '</span> ' +
        (hit.projectName ? '<span class="badge project">' + esc(hit.projectName) + '</span> ' : '') +
        '<span class="clock">' + rel(hit.ts) + ' · ' + esc(hit.via.join('+')) + '</span>' +
        '<div class="mono">' + esc(hitSnippet(hit).slice(0, 320)) + '</div></div>';
    }).join(''));
    put('paletteBody', parts.join(''));
  }).catch(function (err) { put('paletteBody', '<div class="bad">' + esc(err.message) + '</div>'); });
}
function applyFilter(node) {
  filter = node.getAttribute('data-filter');
  syncFilterButtons();
  renderTimeline();
}
function syncFilterButtons() {
  var nodes = document.querySelectorAll('[data-filter]');
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute('data-filter') === filter) nodes[i].classList.add('active');
    else nodes[i].classList.remove('active');
  }
}

/* ---------------------------- state ---------------------------- */
function loadState() {
  api('/api/state').then(function (data) {
    state = data;
    homeDir = data.home || '';
    var daemon = data.daemon;
    put('pillDaemon', '<span class="dot ' + (daemon.running ? 'ok' : 'bad') + '"></span><span>' +
      (daemon.running ? 'daemon pid ' + daemon.pid + ' :' + daemon.port : 'daemon stopped') + '</span>');
    put('sideStatus', '<span class="dot ' + (daemon.running ? 'ok' : 'bad') + '"></span><span>' +
      (daemon.running ? 'LOCAL DAEMON ACTIVE' : 'DAEMON OFFLINE') + '</span>');
    var hooked = data.shells.hooks.filter(function (h) { return h.installed; });
    var shellOk = hooked.length > 0 && (!data.shells.invoking || hooked.some(function (h) {
      return h.shell === data.shells.invoking && h.installed;
    }));
    put('pillShell', '<span class="dot ' + (shellOk ? 'ok' : 'warn') + '"></span><span>hooks: ' +
      (hooked.length ? hooked.map(function (h) { return h.shell; }).join(', ') : 'none') + '</span>');
    put('pillLlm', '<span class="dot ' + (data.llm.ready ? 'ok' : 'warn') + '"></span><span>llm: ' +
      esc(data.llm.provider === 'none' ? 'disabled' : data.llm.model) +
      (data.llm.ready ? ' ready' : ' not installed') + '</span>');
    var t = data.totals;
    put('statFigs', '<span>' + t.projects + ' projects · ' + t.events + ' events · ' + t.commits +
      ' commits · ' + t.chatTurns + ' chat · ' + t.embeddings + ' vectors</span>');
    // The footer is where a local-first tool should say where its data lives;
    // the full paths are a hover away rather than crowding the sidebar.
    var paths = 'home: ' + data.home + NEWLINE + 'database: ' + data.database + NEWLINE + 'config: ' + data.configFile;
    put('dbSize', '<span title="' + attr(paths) + '">' + t.embeddings + ' vectors</span>');
    var hygieneBits = [];
    if (data.hygiene && data.hygiene.contradictions > 0) {
      hygieneBits.push('<span class="dot warn"></span><span>' + data.hygiene.contradictions +
        ' contradicting decision' + (data.hygiene.contradictions === 1 ? '' : 's') + '</span>');
    }
    if (data.hygiene && data.hygiene.openFailures > 0) {
      hygieneBits.push('<span class="dot bad"></span><span>' + data.hygiene.openFailures +
        ' open failure' + (data.hygiene.openFailures === 1 ? '' : 's') + '</span>');
    }
    put('footTotals', t.decisions + ' decisions · ' + t.briefs + ' briefs' +
      (hygieneBits.length ? ' · ' + hygieneBits.join(' · ') : ''));
    syncDaemonButtons(daemon);
    var warnKey = (data.warnings || []).join('~');
    if (warnKey !== lastWarningsSig) {
      lastWarningsSig = warnKey;
      if (warnKey) {
        put('warnings', '<div class="warnbox"><b>Capture health</b><ul>' + data.warnings.map(function (w) {
          return '<li>' + esc(w) + '</li>';
        }).join('') + '</ul></div>');
      } else {
        put('warnings', '');
      }
    }
    renderProjects();
    if (current === null && data.projects.length) {
      // Open the most recently active workspace so the panel never starts empty.
      var recent = data.projects.slice().sort(function (a, b) {
        return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
      })[0];
      selectProject(recent.id);
      return;
    }
    if (current !== null) {
      var still = data.projects.filter(function (p) { return p.id === current; })[0];
      if (still) {
        // Rebuild only when something about this workspace actually changed,
        // and never under a focused input — mid-sentence text must survive a
        // background poll.
        var sig = detailSig(still);
        if (sig !== lastDetailSig && !typingInDetail()) renderDetail(still);
      }
      else { current = null; put('detail', '<div class="empty">Pick a workspace on the left.</div>'); }
    }
  }).catch(function (err) {
    put('warnings', '<div class="warnbox bad"><b>UI server unreachable</b>' +
      '<div style="margin-top:6px">' + esc(err.message) + '</div>' +
      '<div class="muted small" style="margin-top:6px">This page keeps its data in a local server bound ' +
      'to 127.0.0.1. Closing its terminal window stops it.</div>' +
      '<div style="margin-top:8px"><button class="btn" onclick="loadState()">Retry now</button></div></div>');
    put('pillDaemon', '<span class="dot bad"></span><span>server offline</span>');
    put('sideStatus', '<span class="dot bad"></span><span>SERVER OFFLINE</span>');
  });
}

function renderProjects() {
  if (!state) return;
  var sig = sidebarSig();
  if (sig === lastSidebarSig) return;
  lastSidebarSig = sig;
  renderTopNav();
  if (!state.projects.length) {
    put('wsCount', '0');
    put('projects', '<div class="muted small" style="padding:8px 4px">Nothing registered yet. Register a folder to begin.</div>');
    return;
  }
  put('wsCount', state.projects.length + ' tracked');
  put('projects', state.projects.map(function (p) {
    var dotCls = p.watched ? 'ok' : (p.exists ? 'warn' : 'bad');
    var tag = p.recallOnly ? 'ro' : p.commits + 'c';
    return '<div class="ws' + (p.id === current ? ' active' : '') + '" data-project="' + p.id +
      '" onclick="selectFromCard(this)">' +
      '<div class="ws-name"><span class="ws-dot ' + dotCls + '"></span><span>' + esc(p.name) +
      (p.recallOnly ? ' <span class="ws-ro" title="recall-only: registered from a git link, no live capture">RO</span>' : '') +
      '</span></div>' +
      '<span class="ws-actions"><button class="ws-x" title="Unregister ' + esc(p.name) +
      '" onclick="event.stopPropagation(); unregisterFromSidebar(this)" data-project="' + p.id + '">✕</button></span>' +
      '<span class="ws-tag">' + tag + '</span></div>';
  }).join(''));
}

function renderTopNav() {
  var labels = { overview: 'Overview', brief: 'Brief', related: 'Related', timeline: 'Timeline', ask: 'Ask' };
  put('topnav', tabs.map(function (name) {
    return '<button class="navbtn' + (tab === name ? ' active' : '') + '" data-tab="' + name +
      '" onclick="tabFromButton(this)">' + labels[name] + '</button>';
  }).join(''));
}

function selectProject(id) {
  current = id;
  renderProjects();
  var found = state.projects.filter(function (p) { return p.id === id; })[0];
  if (found) renderDetail(found);
}

function renderDetail(project) {
  lastDetailSig = detailSig(project);
  put('crumbName', esc(project.name));
  put('statContext', 'Auto-indexing active workspace ' + esc(project.name));
  renderTopNav();
  var brief = briefHtml(project);
  var context = contextHtml(project);
  var timeline = timelineHtml(project);
  var hygiene = hygieneHtml();
  if (tab === 'brief') {
    put('detail', '<div class="split single"><div class="col-left">' + brief + context + '</div></div>');
  } else if (tab === 'related') {
    put('detail', '<div class="split single"><div class="col-left">' + checkHtml(project) + relatedHtml(project) + '</div></div>');
  } else if (tab === 'timeline') {
    put('detail', '<div class="split single"><div class="col-left">' + timeline + '</div></div>');
  } else if (tab === 'ask') {
    put('detail', '<div class="split single"><div class="col-left">' + askHtml(project) + '</div></div>');
  } else {
    put('detail', '<div class="split"><div class="col-left">' + brief + context + '</div>' +
      '<div class="col-right">' + timeline + hygiene + '</div></div>');
    loadHygiene();
  }
  syncFilterButtons();
  if (tab === 'overview' || tab === 'brief') {
    if (briefCache[project.id]) put('briefBody', briefCache[project.id]);
    else if (briefPending[project.id]) put('briefBody', '<div class="spin">Generating…</div>');
    else loadBrief(project.id, false);
  }
  if (tab === 'related') {
    var checked = checkCache[project.id];
    if (checked) {
      put('checkBody', checked.html);
      var checkBox = el('checkInput');
      if (checkBox) checkBox.value = checked.plan;
    }
    if (relatedCache[project.id]) put('relatedBody', relatedCache[project.id]);
    else if (!relatedPending[project.id]) loadRelated(project.id);
  }
  if (tab === 'overview' || tab === 'timeline') {
    if (timelineData[project.id]) renderTimeline();
    else if (!timelinePending[project.id]) loadTimeline(project.id, days);
  }
  if (tab === 'ask') {
    var asked = askCache[project.id];
    if (asked) {
      put('askAnswer', asked.answer);
      put('askBody', asked.sources);
      var askBox = el('askInput');
      if (askBox) askBox.value = asked.query;
    }
  }
}

// ---- Memory hygiene: contradictions + open failures ----

function hygieneHtml() {
  return '<section class="card"><div class="card-head"><h2><span class="ico">⚖</span>Memory hygiene</h2>' +
    '<span class="muted small">drift &amp; broken runs</span></div>' +
    '<p class="muted small card-sub">What the record disagrees with itself about: decisions that conflict, ' +
    'and commands that failed and were never re-run successfully.</p>' +
    '<div id="hygieneBody"><div class="spin">Loading…</div></div></section>';
}

function loadHygiene() {
  api('/api/hygiene').then(function (data) {
    var parts = [];
    if (data.contradictions.length === 0 && data.failures.length === 0) {
      parts.push('<div class="muted small">Clean — no contradicting decisions and no unresolved failures on record.</div>');
    }
    for (const c of data.contradictions) {
      parts.push('<div class="entry-line"><div><span class="tag bad">contradiction</span>' +
        (c.project ? '<span class="badge project">' + esc(c.project) + '</span> ' : '') +
        '<span class="badge">' + esc(c.category) + '</span>' +
        '<span class="muted small"> score ' + c.score + '</span></div>' +
        '<div class="mono">' + esc(c.a.text) + '</div>' +
        '<div class="mono">' + esc(c.b.text) + '</div>' +
        '<div class="muted small">' + esc(c.reason) + '</div>' +
        '<div style="margin-top:5px"><button class="ghost tiny" data-dismiss="' + c.id +
        '" onclick="dismissFromButton(this)">Dismiss — resolved</button></div></div>');
    }
    for (const f of data.failures) {
      parts.push('<div class="entry-line"><div><span class="tag bad">still open</span>' +
        (f.project ? '<span class="badge project">' + esc(f.project) + '</span> ' : '') +
        '<span class="clock">' + rel(f.ts) + '</span></div>' +
        '<div class="mono">$ ' + esc(f.cmd) + '</div>' +
        (f.output ? '<div class="muted small">' + esc(f.output.split(NEWLINE).filter(function (l) { return l.trim(); })[0] || '') + '</div>' : '') +
        '</div>');
    }
    put('hygieneBody', parts.join(''));
  }).catch(function (err) {
    put('hygieneBody', '<span class="bad">' + esc(err.message) + '</span>');
  });
}

function dismissFromButton(button) {
  api('/api/hygiene/dismiss', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: Number(button.getAttribute('data-dismiss')) }) }).then(function () {
    loadHygiene();
    loadState();
  }).catch(function (err) {
    toast('<b class="bad">Could not dismiss</b><div class="dim">' + esc(err.message) + '</div>', 5000);
  });
}

function metricsHtml(project) {
  var cells = [
    ['m1', project.events, 'Events'],
    ['m2', project.commits, 'Commits'],
    ['m3', project.decisions, 'Decisions'],
    ['m4', project.briefs, 'Briefs']
  ];
  return '<div class="metrics">' + cells.map(function (cell) {
    return '<div class="metric ' + cell[0] + '"><b>' + cell[1] + '</b><span>' + cell[2] + '</span></div>';
  }).join('') + '</div>';
}

function briefHtml(project) {
  return '<section class="card"><div class="card-head"><h2><span class="ico">🧠</span>Auto-Brief</h2>' +
    '<button class="ghost" data-project="' + project.id + '" onclick="briefFromButton(this)">↻ Re-synthesize</button></div>' +
    '<p class="muted small card-sub">Synthesized from this workspace captured history — commands, file touches, ' +
    'commits, decisions and chat turns.</p>' +
    '<div class="panel"><span class="panel-label">Signals from this workspace</span>' + metricsHtml(project) + '</div>' +
    '<div id="briefBody" class="md" style="margin-top:10px"><div class="spin">Loading…</div></div>' +
    '<label class="ai-toggle" style="margin-top:10px"><input type="checkbox" id="useAi">' +
    '<span>use the local LLM (' + esc(state.llm.model) + (state.llm.ready ? '' : ' — not installed') + ')</span></label>' +
    '</section>';
}

function loadBrief(id, ai) {
  briefPending[id] = true;
  var checkbox = el('useAi');
  var useAi = ai || (checkbox && checkbox.checked) ? '1' : '0';
  put('briefBody', '<div class="spin">Generating…</div>');
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

function checkHtml(project) {
  return '<section class="card"><div class="card-head"><h2><span class="ico">⚑</span>Before you build it</h2>' +
    '<span class="muted small">decisions &amp; reverts</span></div>' +
    '<p class="muted small card-sub">Diffs a plan against every decision you have logged and every revert in your ' +
    'git history, so you hear about your own past "no" now instead of after the work.</p>' +
    '<div class="panel"><span class="panel-label">Your plan</span>' +
    '<div class="row"><input type="text" id="checkInput" data-project="' + project.id +
    '" placeholder="add redis caching for the session lookup path" onkeydown="checkOnEnter(event)">' +
    '<button class="btn primary" data-project="' + project.id + '" onclick="checkFromButton(this)">Check plan</button></div>' +
    '<div id="checkBody" class="muted small" style="margin-top:8px">' +
    'It also answers from the CLI: <code>brain check "add redis caching for the session lookup path"</code></div></div>' +
    decisionHtml(project) + '</section>';
}

// Logging a decision from the panel is what keeps the two cards honest: this
// one diffs plans against decisions and the hygiene card scans them for
// conflicts, so both were telling you to open a terminal to write one.
function decisionHtml(project) {
  return '<div class="panel"><span class="panel-label">Log a decision</span>' +
    '<div class="row"><input type="text" id="decisionInput" data-project="' + project.id +
    '" placeholder="chose sqlite over postgres for the storage layer because it is embedded" ' +
    'onkeydown="decisionOnEnter(event)">' +
    '<button class="btn" data-project="' + project.id + '" onclick="logFromButton(this)">Log decision</button></div>' +
    '<div id="decisionBody" class="muted small" style="margin-top:8px">Every "chose X over Y because Z" you ' +
    'write here is what the plan check and the contradiction scan read back. #tags are pulled out of the text.</div></div>';
}

function decisionOnEnter(event) {
  if (event.key === 'Enter') logDecision(Number(event.target.getAttribute('data-project')));
}
function logFromButton(button) { logDecision(Number(button.getAttribute('data-project'))); }
function logDecision(id) {
  var box = el('decisionInput');
  var text = box ? box.value.trim() : '';
  if (!text) {
    put('decisionBody', '<span class="bad">Write it first — "chose X over Y because Z".</span>');
    return;
  }
  put('decisionBody', '<div class="spin">Recording…</div>');
  api('/api/decision', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: id, text: text }) }).then(function (data) {
    if (box) box.value = '';
    // A new decision can contradict an older one, and any cached plan diff was
    // computed without it — so both are invalidated rather than left stale.
    delete checkCache[id];
    // The refresh below re-renders the card, so the confirmation has to float
    // above it rather than being written into a node that is about to be replaced.
    toast('<b>Decision logged</b><div class="dim">' + esc(data.project) + ' now has ' + data.decisions +
      ' decision' + (data.decisions === 1 ? '' : 's') + ' — Ask searches it immediately' +
      (data.tags.length ? ', tagged ' + esc(data.tags.join(', ')) : '') + '.</div>', 5000);
    loadHygiene();
    loadState();
  }).catch(function (err) {
    put('decisionBody', '<span class="bad">' + esc(err.message) + '</span>');
  });
}

function runCheck(id) {
  var box = el('checkInput');
  var plan = box ? box.value.trim() : '';
  if (!plan) {
    put('checkBody', '<span class="bad">Type what you are about to build first.</span>');
    return;
  }
  put('checkBody', '<div class="spin">Comparing against your past decisions…</div>');
  api('/api/check?project=' + id + '&q=' + encodeURIComponent(plan)).then(function (data) {
    var html = checkReport(data);
    checkCache[id] = { plan: plan, html: html };
    put('checkBody', html);
  }).catch(function (err) {
    put('checkBody', '<span class="bad">' + esc(err.message) + '</span>');
  });
}

function checkReport(data) {
  if (data.verdict === 'clear') {
    if (data.considered === 0) {
      return '<div class="small"><b class="ok">clear</b> — nothing to compare yet: no decisions logged and no ' +
        'reverts in git. Decisions are what this reads: log one in <b>Log a decision</b> above (or ' +
        '<code>brain log "chose X over Y because Z"</code>) and this panel starts answering.</div>';
    }
    return '<div class="small"><b class="ok">clear</b> — nothing you logged contradicts this. Checked ' +
      data.considered + ' past decisions across ' + esc(data.scope) + '.</div>';
  }
  var head = data.verdict === 'rejected-before'
    ? '<b class="bad">you rejected something like this before — read the reason first</b>'
    : data.verdict === 'decided-before'
      ? '<b class="warn">already decided</b> — reuse that decision instead of re-deciding it'
      : '<b class="muted">related history only</b> — nothing here rules the plan in or out';
  var html = '<div class="small">' + head + '<span class="muted"> · ' + data.considered +
    ' past decisions checked across ' + esc(data.scope) + '</span></div>';
  html += data.findings.map(function (finding) {
    var rejected = finding.source === 'revert' || finding.status === 'rejected';
    var label = finding.source === 'revert' ? 'git revert' : rejected ? 'rejected' : 'decided';
    return '<div class="entry-line"><div><span class="tag" style="color:' +
      (rejected ? 'var(--tertiary)' : 'var(--green)') + '">' + esc(label) + '</span> ' +
      (finding.project ? '<span class="badge project">' + esc(finding.project) + '</span> ' : '') +
      '<span class="clock">' + rel(finding.ts) + '</span></div>' +
      '<div class="mono">' + esc(finding.text) + '</div>' +
      (finding.reason ? '<div class="muted small">because: ' + esc(finding.reason) + '</div>' : '') +
      '<div class="muted small">relevance: ' + esc(finding.why) +
      (finding.hash ? ' · commit ' + esc(finding.hash) : '') + '</div></div>';
  }).join('');
  return html;
}

function relatedHtml(project) {
  return '<section class="card"><div class="card-head"><h2><span class="ico">🔗</span>Knowledge Anchors</h2>' +
    '<span class="muted small">other workspaces</span></div>' +
    '<p class="muted small card-sub">Looks for the same problem already solved in your <b>other</b> projects, ' +
    'matching the shape of the problem and the role each file plays — not file names.</p>' +
    '<div class="panel"><span class="panel-label">Search other workspaces</span>' +
    '<div class="row"><button class="btn primary" data-project="' + project.id +
    '" onclick="relatedFromButton(this)">Find similar work</button>' +
    '<label class="muted small"><input type="checkbox" id="relatedSelf"> include this project too</label></div>' +
    '<div id="relatedBody" style="margin-top:8px"></div></div></section>';
}

function relatedProjectEntry(match) {
  var bits = [];
  bits.push('<div class="entry-line"><span class="badge project">' + esc(match.project) + '</span> ' +
    '<span class="muted small">' + esc(match.commits + ' commit(s)') + '</span>' +
    (match.stack && match.stack.length ? ' <span class="muted small">· ' + esc(match.stack.join(' + ')) + '</span>' : '') +
    ' <span class="muted small">· score ' + esc(String(match.score)) + '</span>');
  if (match.summary) {
    bits.push('<div class="muted small">' + esc(match.summary.slice(0, 160)) + '</div>');
  }
  var relation = match.relation;
  if (relation && relation.headline) {
    bits.push('<div class="small" style="margin-top:4px">' + esc(relation.headline) + '</div>');
  }
  var evidence = (relation && relation.evidence) || [];
  if (evidence.length) {
    var source = (relation && relation.sourceProject) || 'This project';
    bits.push('<div class="muted small" style="margin-top:2px">What is already built in <b>' +
      esc(match.project) + '</b>:</div>');
    evidence.forEach(function (concept) {
      var files = concept.files || [];
      bits.push('<div class="small" style="margin:6px 0 0 8px"><b>' + esc(concept.idea || concept.term) + '</b>');
      if (concept.uses) {
        bits.push('<div class="small">' + esc(source) + ' uses ' + esc(concept.uses) + '.</div>');
      }
      if (files.length === 0) {
        bits.push('<div class="muted small">nothing found over there yet</div>');
      }
      files.forEach(function (file) {
        bits.push('<div class="mono small" style="margin-top:2px">' + esc(file.summary || file.path) +
          (concept.source === 'doc' ? ' <span class="muted">(their README)</span>' : '') + '</div>');
        if (file.doc) bits.push('<div class="muted small">does: ' + esc(file.doc) + '</div>');
        if (file.reuse) bits.push('<div class="muted small">you can reuse: ' + esc(file.reuse) + '</div>');
      });
      bits.push('</div>');
    });
  }
  bits.push('<div class="muted small">why: ' + esc(match.why || '') + '</div>');
  bits.push('<div class="muted small">catch up: <code>' + esc(match.timeline) + '</code></div></div>');
  return bits.join('');
}

function relatedEntry(match) {
  var bits = [];
  bits.push('<div class="entry-line"><span class="badge project">' + esc(match.project) + '</span> ' +
    '<span class="mono">' + esc(match.hash) + '</span> ' + esc(match.subject) +
    (match.url ? ' <a href="' + attr(match.url) + '" target="_blank" rel="noreferrer">open ↗</a>' : ''));
  bits.push('<div class="muted small">' + rel(match.ts) +
    (match.stack && match.stack.length ? ' · ' + esc(match.stack.join(' + ')) : '') +
    ' · score ' + esc(String(match.score)) + '</div>');
  if (match.files && match.files.length) {
    bits.push('<div class="muted mono small">' + esc(match.files.join(', ')) +
      (match.insertions + match.deletions > 0 ? esc(' (+' + match.insertions + '/-' + match.deletions + ')') : '') +
      '</div>');
  }
  bits.push('<div class="muted small">why: ' + esc(match.why || '') + '</div>');
  bits.push('<div class="muted small">history: <code>brain timeline -p ' + esc(match.project) + '</code></div></div>');
  return bits.join('');
}

function loadRelated(id) {
  relatedPending[id] = true;
  var box = el('relatedSelf');
  var self = box && box.checked ? '1' : '0';
  put('relatedBody', '<div class="spin">Searching your other projects…</div>');
  api('/api/related?project=' + id + '&self=' + self + '&limit=8').then(function (data) {
    var html = '';
    var projects = data.projects || [];
    var matches = data.matches || [];
    if (projects.length) {
      html += '<div class="small" style="font-weight:600">Related projects</div>' +
        '<div class="muted small">' + projects.length + ' other project(s) whose overview reads like this one' +
        (data.commitsIndexed === 0 ? ' — matched on the README, since no commits are indexed here yet' : '') +
        ':</div>' + projects.map(relatedProjectEntry).join('');
    }
    if (matches.length) {
      html += '<div class="spacer"></div><div class="muted small">' + matches.length +
        ' solved-work matches from ' + data.projectsSearched + ' other project(s), drawn from ' + data.candidates +
        ' solved commits' + (data.focus && data.focus.capabilities.length
          ? ' · focus: ' + esc(data.focus.capabilities.slice(0, 4).join(', ')) : '') + '</div>';
      html += matches.map(relatedEntry).join('');
    }
    if (!projects.length && !matches.length) {
      html = data.commitsIndexed === 0
        ? '<div class="muted small">No commits indexed for this project yet, so there is no solved work to ' +
          'compare. Its README does not resemble another project either. Run <code>brain refresh</code> after ' +
          'your first commit, or register another repo.</div>'
        : '<div class="muted small">Nothing similar in your other projects yet. Register another repo ' +
          '(<code>brain register &lt;path&gt;</code>) and this list fills itself.</div>';
    }
    delete relatedPending[id];
    relatedCache[id] = html;
    put('relatedBody', html);
  }).catch(function (err) {
    delete relatedPending[id];
    put('relatedBody', '<div class="bad">' + esc(err.message) + '</div>');
  });
}

function contextHtml(project) {
  var rows = [
    ['summary', project.summary || 'not analysed yet — click Re-scan'],
    ['stack', project.stack || 'unknown'],
    ['remote', project.gitRemote || 'none'],
    ['last activity', rel(project.lastSeenAt)],
    ['captured', project.events + ' events · ' + project.commits + ' commits · ' + project.decisions + ' decisions'],
    ['watching', project.watched ? 'yes — the daemon is following this folder' : 'no — start the daemon'],
    ['commit hook', project.hook ? 'installed' : 'not installed']
  ];
  var connectPanel = '';
  if (project.recallOnly) {
    connectPanel = '<div class="panel" style="margin-top:8px"><span class="panel-label">Connect a local folder</span>' +
      '<div class="row"><input type="text" id="connectInput" data-project="' + project.id +
      '" placeholder="C:' + BS + 'path' + BS + 'to' + BS + 'your' + BS + 'local' + BS + 'checkout" onkeydown="connectOnEnter(event)">' +
      '<button class="btn primary" data-project="' + project.id + '" onclick="connectFromButton(this)">Connect</button></div>' +
      '<div class="muted small" style="margin-top:6px">This project was registered from a git link, so it recalls ' +
      'history but captures nothing. Point it at the folder where you actually work and the same record gains ' +
      'commands, errors and file touches — no duplicate entry.</div>' +
      '<div id="connectReport" class="muted small" style="margin-top:6px"></div></div>';
  }
  return '<section class="card"><div class="card-head"><h2><span class="ico">🗂</span>Workspace context</h2>' +
    '<span class="row"><button class="ghost" data-project="' + project.id +
    '" onclick="refreshFromButton(this)">Re-scan</button>' +
    '<button class="ghost" data-project="' + project.id +
    '" onclick="unregisterFromButton(this)">Unregister</button></span></div>' +
    '<div class="panel"><span class="panel-label">Stored metadata</span><div class="kv">' +
    rows.map(function (pair) {
      return '<div class="k">' + esc(pair[0]) + '</div><div class="v">' + esc(pair[1]) + '</div>';
    }).join('') + '</div></div>' + connectPanel +
    '<div class="muted small" style="margin-top:10px">Stored on the project row at register time and indexed ' +
    'for recall. "Re-scan" refreshes it from the folder on disk.</div></section>';
}

function connectOnEnter(event) { if (event.key === 'Enter') connectFromButton(event.target); }

function connectFromButton(button) {
  var id = Number(button.getAttribute('data-project'));
  var box = el('connectInput');
  var folder = box ? box.value.trim() : '';
  if (!folder) {
    put('connectReport', '<span class="bad">Type or paste the local folder of this repository first.</span>');
    return;
  }
  put('connectReport', '<span class="spin">Connecting and re-scanning…</span>');
  api('/api/connect', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: id, folder: folder }) }).then(function (data) {
    put('connectReport', '<span class="ok">Connected.</span> ' + data.commitsInserted +
      ' commit(s) added from the folder' + (data.watched ? ' — capture is live.' : ' — start the daemon to capture.'));
    loadState();
  }).catch(function (err) {
    put('connectReport', '<span class="bad">' + esc(err.message) + '</span>');
  });
}

function askHtml(project) {
  return '<section class="card"><div class="card-head"><h2><span class="ico">🔍</span>Ask this workspace</h2>' +
    '<span class="muted small">recall</span></div>' +
    '<p class="muted small card-sub">Answers from this workspace stored overview and newest captured evidence, ' +
    'with the passages behind them listed underneath.</p>' +
    '<div class="panel"><span class="panel-label">Question</span>' +
    '<div class="row"><input type="text" id="askInput" data-project="' + project.id +
    '" placeholder="what does this project do?" onkeydown="askOnEnter(event)">' +
    '<button class="btn primary" data-project="' + project.id + '" onclick="askFromButton(this)">Ask</button></div>' +
    '<div id="askAnswer" class="answer" style="margin-top:10px">Ask a question and this answers from the ' +
    'stored overview first, then from the newest captured evidence.</div>' +
    '<div id="askBody" class="muted small" style="margin-top:8px"></div></div></section>';
}

function answerGeneratorLabel(answer) {
  if (answer.generator === 'local-model') {
    return 'written by the local model (' + esc(answer.llm.model) + ')';
  }
  if (answer.generator === 'insufficient-evidence') {
    return 'refused: the record does not contain the evidence this question assumes';
  }
  // No chat model is installed, so say so and name the one command that fixes it.
  var source = answer.generator === 'stored-overview'
    ? 'from this workspace stored overview and structure'
    : 'assembled from your captured history';
  return source + ' · for written answers run: ollama pull ' + esc(answer.llm.model);
}

function answerHtml(data) {
  var answer = '';
  if (data.answer && data.answer.text) {
    answer = markdown(data.answer.text);
    answer += '<div class="answer-foot">' + answerGeneratorLabel(data.answer) + '</div>';
  } else {
    answer = '<div class="muted small">No answer yet.</div>';
  }
  var head = '<div class="muted small">' + esc(data.embedder) + ' · ' + data.lexicalCount +
    ' lexical / ' + data.vectorCount + ' vector candidates · best ' + data.bestVectorScore.toFixed(2) + '</div>';
  if (data.weak) {
    head += '<div class="warn small">No keyword match — the passages below are semantic near-misses.</div>';
  }
  var sources = (data.answer && data.answer.sources) || [];
  var list = sources.length
    ? '<div class="muted small" style="margin-top:8px">Passages behind this answer:</div>' + sources.map(function (src, index) {
        return '<div class="entry-line"><span class="clock">' + (index + 1) + '.</span> ' +
          '<span class="badge ' + esc(src.kind) + '">' + esc(src.kind) + '</span> ' +
          (src.project ? '<span class="badge project">' + esc(src.project) + '</span> ' : '') +
          '<span class="clock">' + rel(src.ts) + '</span>' +
          '<div class="mono">' + esc(src.snippet) + '</div></div>';
      }).join('')
    : '<div class="muted small">No passages behind this.</div>';
  return { answer: answer, sources: head + list };
}

function runAsk(id) {
  var input = el('askInput');
  var query = input ? input.value.trim() : '';
  if (!query) {
    put('askAnswer', '<span class="bad">Type a question first.</span>');
    return;
  }
  put('askAnswer', '<div class="spin">Reading this workspace history…</div>');
  put('askBody', '');
  api('/api/ask?project=' + id + '&q=' + encodeURIComponent(query) + '&limit=8').then(function (data) {
    var parts = answerHtml(data);
    askCache[id] = { query: query, answer: parts.answer, sources: parts.sources };
    put('askAnswer', parts.answer);
    put('askBody', parts.sources);
  }).catch(function (err) { put('askAnswer', '<div class="bad">' + esc(err.message) + '</div>'); });
}

function timelineHtml(project) {
  var kinds = [['all', 'All'], ['cmd', 'Commands'], ['error', 'Errors'], ['commit', 'Commits'],
    ['decision', 'Decisions'], ['file', 'File Touches'], ['chat', 'IDE Chats']];
  return '<section class="card"><div class="card-head"><h2><span class="ico">🗓</span>Unified Timeline</h2>' +
    '<span class="muted small">live capture</span></div>' +
    '<div class="tl-head">' +
    '<label class="search"><span class="search-ico">⌕</span>' +
    '<input type="text" id="timelineSearch" placeholder="Filter by command, file, or hash…" oninput="onSearchInput(this)"></label>' +
    '<span class="pill live-pill"><span class="dot ok"></span>Live Feed</span></div>' +
    '<div class="chips">' + kinds.map(function (pair) {
      return '<button class="chip' + (filter === pair[0] ? ' active' : '') + '" data-filter="' + pair[0] +
        '" onclick="applyFilter(this)">' + pair[1] + ' <span class="chip-n" data-count="' + pair[0] + '">0</span></button>';
    }).join('') + '</div>' +
    '<div class="tl-days">' + [1, 7, 30, 365].map(function (d) {
      return '<button class="ghost tiny' + (days === d ? ' active' : '') + '" data-project="' + project.id +
        '" data-days="' + d + '" onclick="timelineFromButton(this)">' + d + 'd</button>';
    }).join('') + '<span id="timelineInfo" class="muted"></span></div>' +
    '<div class="stream" id="timelineBody"><div class="spin">Loading…</div></div></section>';
}

function loadTimeline(id, span) {
  timelinePending[id] = true;
  put('timelineBody', '<div class="spin">Loading…</div>');
  api('/api/timeline?project=' + id + '&days=' + span + '&limit=120').then(function (data) {
    // An empty default window hides a real history: widen once to a year and
    // move the day buttons with it, so the stream is never blank for nothing.
    if (!data.entries.length && span < 365 && !timelineWidened[id]) {
      timelineWidened[id] = true;
      days = 365;
      var buttons = document.querySelectorAll('[data-days]');
      for (var i = 0; i < buttons.length; i++) {
        if (Number(buttons[i].getAttribute('data-days')) === 365) buttons[i].classList.add('active');
        else buttons[i].classList.remove('active');
      }
      loadTimeline(id, 365);
      return;
    }
    timelineData[id] = data.entries;
    timelineInfo[id] = data.entries.length + ' entries · last ' + span + ' day(s)';
    delete timelinePending[id];
    renderTimeline();
  }).catch(function (err) {
    delete timelinePending[id];
    put('timelineBody', '<div class="bad">' + esc(err.message) + '</div>');
  });
}

function kindLabel(kind) {
  if (kind === 'cmd') return 'Command';
  if (kind === 'error') return 'Error';
  if (kind === 'commit') return 'Git Commit';
  if (kind === 'decision') return 'Decision';
  if (kind === 'file') return 'File Touch';
  if (kind === 'chat') return 'IDE Chat';
  return kind;
}

function timelineEntry(entry) {
  return '<div class="tl-item">' +
    '<div class="tl-node ' + esc(entry.kind) + '"><span></span></div>' +
    '<div class="tl-card"><div class="tl-meta">' +
    '<span class="badge ' + esc(entry.kind) + '">' + esc(kindLabel(entry.kind)) + '</span>' +
    '<span class="clock">' + esc(clock(entry.ts)) + '</span>' +
    (entry.source ? '<span class="tl-src">' + esc(entry.source) + '</span>' : '') +
    '<span class="grow"></span>' +
    '<button class="ghost tiny" data-copy="' + attr(entry.text) + '" onclick="copyText(this)">copy</button>' +
    '</div>' +
    '<div class="tl-text' + (entry.kind === 'cmd' || entry.kind === 'error' ? '' : ' plain') + '">' + esc(entry.text) + '</div>' +
    (entry.detail ? '<div class="tl-detail">' + esc(entry.detail) + '</div>' : '') +
    '</div></div>';
}

function renderTimeline() {
  var body = el('timelineBody');
  if (!body) return;
  var entries = current !== null ? timelineData[current] : null;
  if (!entries) { body.innerHTML = '<div class="spin">Loading…</div>'; return; }
  var counts = { all: entries.length, cmd: 0, error: 0, commit: 0, decision: 0, file: 0, chat: 0 };
  entries.forEach(function (entry) { if (counts[entry.kind] !== undefined) counts[entry.kind]++; });
  var nodes = document.querySelectorAll('.chip-n');
  for (var i = 0; i < nodes.length; i++) {
    var key = nodes[i].getAttribute('data-count');
    nodes[i].textContent = counts[key] === undefined ? 0 : counts[key];
  }
  var info = el('timelineInfo');
  if (info) info.textContent = timelineInfo[current] || '';
  var needle = search.toLowerCase();
  var shown = entries.filter(function (entry) {
    if (filter !== 'all' && entry.kind !== filter) return false;
    if (!needle) return true;
    var hay = (entry.text + ' ' + (entry.detail || '') + ' ' + entry.kind).toLowerCase();
    return hay.indexOf(needle) >= 0;
  });
  if (!shown.length) {
    body.innerHTML = '<div class="muted small">Nothing captured here yet. If you expected commands, check the ' +
      'shell hooks and the daemon in the capture-health banner above.</div>';
    return;
  }
  body.innerHTML = shown.map(timelineEntry).join('');
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
    syncRegisterMode();
  }).catch(function (err) { put('browser', '<div class="entry bad">' + esc(err.message) + '</div>'); });
}

function registerFolder() {
  var path = el('folderPath').value.trim();
  if (!path) { put('registerReport', '<div class="report bad">Enter or pick a folder, or paste a git link, first.</div>'); return; }
  var url = looksLikeUrl(path);
  put('registerReport', '<div class="report spin">' + (url
    ? 'Cloning the repository, backfilling its history and indexing…'
    : 'Scanning the folder, backfilling git history and indexing…') + '</div>');
  api('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: path, name: el('folderName').value.trim() || undefined })
  }).then(function (data) {
    var p = data.profile;
    var rows = [
      ['project', data.project.name + ' (id ' + data.project.id + ')'],
      ['capture', data.recallOnly ? 'recall-only (git link) — history and recall, no live capture' : 'live (folder)'],
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
        return '<div class="k">' + esc(pair[0]) + '</div><div class="v">' + esc(pair[1]) + '</div>';
      }).join('') + '</div>' +
      (data.warnings.length ? '<div class="warn small" style="margin-top:8px">' +
        data.warnings.map(function (w) { return esc(w); }).join('<br>') + '</div>' : '') + '</div>');
    loadState();
    closeRegister();
    selectProject(data.project.id);
  }).catch(function (err) {
    put('registerReport', '<div class="report bad">' + esc(err.message) + '</div>');
  });
}

function refreshProject(id) {
  put('crumbName', 'Re-scanning…');
  api('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: id }) }).then(function () { loadState(); })
    .catch(function (err) { put('warnings', '<div class="warnbox bad">' + esc(err.message) + '</div>'); });
}

function unregisterProject(id) {
  var found = state.projects.filter(function (p) { return p.id === id; })[0];
  if (!window.confirm('Stop tracking ' + (found ? found.name : 'this project') + ' and delete its captured data?')) return;
  api('/api/unregister', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: id }) }).then(function () {
    current = null;
    put('detail', '<div class="empty">Unregistered.</div>');
    loadState();
  }).catch(function (err) { put('warnings', '<div class="warnbox bad">' + esc(err.message) + '</div>'); });
}

function startDaemon() {
  api('/api/daemon', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start' }) }).then(function () { setTimeout(loadState, 1200); });
}
function stopDaemon() {
  api('/api/daemon', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }) }).then(function () { setTimeout(loadState, 400); });
}
function installHooks(button) {
  if (button) button.disabled = true;
  api('/api/shell/install', { method: 'POST' }).then(function (data) {
    var lines = data.shells.map(function (s) {
      return '<div class="mono">' + esc(s.shell) + ' → ' + esc(s.rcFile) +
        (s.installed ? '' : ' <span class="dim">(already present)</span>') + '</div>';
    });
    toast('<b>Capture hooks installed</b>' + lines.join('') +
      '<div class="dim" style="margin-top:6px">Open a new terminal so the hooks load.</div>', 0);
    loadState();
  }).catch(function (err) {
    if (button) button.disabled = false;
    toast('<b class="bad">Could not install hooks</b><div class="dim">' + esc(err.message) + '</div>', 6000);
  });
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

window.addEventListener('keydown', function (event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
  }
  if (event.key === 'Escape') { closePalette(); closeRegister(); }
});

loadState();
setInterval(loadState, 20000);
</script>
</body>
</html>
`;
}
