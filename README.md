# Second Brain OS

A local-first "second brain" that passively captures **what you did, why, and how** while you work
on a project, and makes it instantly retrievable — so you never re-explain or re-research something
you already know.

Everything lives on your laptop in one SQLite file. No account, no sync, no server.

```
┌──────────────────── Capture (background) ────────────────────┐
│ shell hook: bash/zsh traps + PowerShell $PROFILE             │
│                                       → commands + exit codes │
│ chokidar watcher per project          → files created/edited  │
│ git backfill + post-commit hook       → full commit history   │
│ IDE chat adapters                     → Claude Code, editors  │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────────────── Storage ─────────────────────────────┐
│ ~/.secondbrain/db.sqlite                                     │
│   events · commits · chat_turns · decisions · briefs         │
│   search_docs + FTS5 (lexical) · embeddings (vector)         │
│   project profiles: stack, languages, layout, README excerpt │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────── Retrieval / Interface ───────────────────────┐
│ brain ui (local web app: pick a folder, register, read)      │
│ brain ask · brain timeline · brain brief · brain status       │
│ embeddings via Ollama (offline) with a deterministic fallback │
└──────────────────────────────────────────────────────────────┘
```

## Quickstart

```bash
npm install
npm run build
npm link                 # puts `brain` on your PATH (optional but recommended)

brain init               # home dir + db + config + shell hooks (bash, zsh, PowerShell)
```

Then either use the UI — no commands to remember:

```bash
brain ui                 # opens a local web app; type or click a folder and press "Register folder"
```

or stay in the terminal:

```bash
cd ~/code/my-project
brain register           # scans the folder, backfills git history, installs the hook, starts capture
```

Open a new terminal (so the shell hook loads), then:

```bash
brain brief                          # "here is where you left off"
brain ask "how did I set up auth?"   # semantic recall over everything captured
brain timeline --days 7              # merged cross-source history
brain log "decided SQLite over Postgres #storage"   # record a decision
```

Run `brain info` for orientation and `brain doctor` when capture looks wrong.

## What gets captured

| Source | How | Where it lands |
| --- | --- | --- |
| Shell commands | bash DEBUG trap, zsh `preexec`+`precmd`, PowerShell `PSReadLine` + prompt wrapper — all written straight to the daemon socket | `events` (type `cmd`, with cwd + exit code) |
| Project profile | built on register/refresh: stack, languages, layout, entry points, README excerpt, remote, commit summary | `projects` row + a `search_docs` document |
| File touches | one chokidar watcher per registered project, debounced + rate limited | `events` (type `file`) |
| Git history | `git log --all --numstat` on register; `post-commit` hook afterwards | `commits` |
| Decisions | `brain log`, plus `brain decisions --suggest` mining commit messages | `decisions` |
| IDE chat | pluggable adapters (Claude Code JSONL, VS Code/Cursor/Windsurf `state.vscdb`, dot-folders) | `chat_turns` |

**Timestamps always come from the content itself** — the git commit time, the chat message time, the
shell wall clock — never from a file mtime. That is what lets events from different sources
merge-sort into one honest timeline.

## Commands

**Projects**
- `brain ui [--port n] [--no-open]` — local web UI: folder browser, one-click register, briefs, timeline, recall
- `brain init [--no-shell] [--shell s]` — create home, database, config, shell hooks
- `brain register [path] [--name] [--limit n] [--no-hook]` — register + scan + backfill + watch
- `brain projects [--json]` — list with the stored summary, stack, remote and capture stats
- `brain refresh [project]` — re-scan folder(s) and rebuild the stored overview documents
- `brain unregister <project> [--keep-hook]` — stop tracking and delete captured data

**Memory**
- `brain log "<text>" [-p project] [-g] [--tags a,b]` — record a decision (`#tags` also parsed)
- `brain decisions [--suggest] [--save-suggestions]` — list or mine decisions from commit history
- `brain ask "<query>" [-p project] [--days n] [--types decision,commit,chat,event] [--json]`

**Insight**
- `brain brief [-p project] [--cached] [--heuristic] [--auto]` — the handover note, in three prose
  sections: **What it is** (scope read from the project's own README/PRD), **Where it stands** (did the last
  session finish an increment or stop mid-task, which features the docs list as implemented, what its own
  documents claim, and what is still open: unchecked backlog items, TODO/FIXME markers, new modules with no
  test), and **What could come next** (the project's own roadmap, attributed). Loose ends, decisions and
  capture health follow only when they have something to say; the commit-by-commit history stays in
  `brain timeline`
- `brain timeline [--days n] [--kinds cmd,file,commit,chat,decision] [--asc] [--json]` — commits list the
  files they touched
- `brain status [--json]` — daemon, shell hooks, LLM readiness, database and index state, plus a
  "needs attention" list when something would silently silence capture

**Capture**
- `brain daemon start|stop|restart|status` — the background capture daemon
- `brain watch [--once]` — foreground file watching with no socket
- `brain shell install|uninstall|print|status [--shell bash|zsh|powershell]` — shell integration
- `brain autostart install|uninstall|show` — login item (systemd / LaunchAgent / Startup folder)
- `brain hook cmd|line|commit` — internals used by the shell and git hooks
- `brain emit --cmd "<command>"` — push an event in from another tool
- `brain ingest-chat [--adapter id] [--list] [--days n]` — pull AI chat history

**Maintenance**
- `brain reindex [--provider auto|ollama|hash]` — rebuild embeddings after changing models
- `brain config [--set key=value] [--path] [--reset]` — inspect or edit config
- `brain export [--format sqlite|json] [-o file]` — backup / export
- `brain reset --yes [--all]` — delete captured data
- `brain doctor` — environment checks

## How capture actually runs

`brain daemon start` spawns a detached Node process that listens on **127.0.0.1** and owns the file
watchers. Three details make the shell hook fast and reliable:

1. **No process per command.** The hook writes one tab-delimited line (`SB1 …`) straight to the
   daemon socket using bash's `/dev/tcp` or zsh's `ztcp`. No JSON escaping, no spawn.
2. **It still works without the daemon.** If the socket is unreachable the hook falls back to
   `brain hook line`, which writes directly to the database. Nothing is dropped because the daemon
   was down.
3. **Credentials come from a shell-sourceable file.** The daemon writes port/token to
   `~/.secondbrain/daemon.env`, and `~/.secondbrain/brain` is a tiny shim so the hook never depends
   on `brain` being on PATH (and survives paths with spaces).

The hook ignores its own bookkeeping, records the exit status of the command that just ran, and on
directory change calls `brain brief --auto`, which is a silent no-op unless the new directory is a
registered project that is due a brief (throttled by `brief.minIntervalMinutes`).

### PowerShell

Windows users type into PowerShell, so `brain init` / `brain shell install` detect the invoking shell
from the process ancestry and install into the real profile path (asked from `$PROFILE`, so OneDrive
redirects are handled, and both PowerShell 5.1 and 7 profile files are written when both exist):

```powershell
brain shell status        # which shells can actually capture right now
brain shell install       # writes into every applicable profile on this machine
. $PROFILE                # or just open a new terminal
```

The PowerShell hook uses `PSReadLine`'s `AddToHistoryHandler` to see the exact command line, wraps
the prompt to flush it with the exit status and working directory, writes the same tab-delimited
socket line as the POSIX hook, and never raises an error into your prompt.

## The local UI

`brain ui` serves a single self-contained page on **127.0.0.1** (port `ui.port`, default 47700) and
opens it in your browser. It exists so you never have to remember the order of `init` → `cd` →
`register` again:

- **Track a folder** — type a path or click through a built-in folder browser (drives on Windows,
  git repos and already-tracked folders tagged). Registering runs the exact same flow as
  `brain register` and reports what it stored: summary, stack, languages, layout, entry points,
  commits scanned/indexed, hook, watching state.
- **Capture health banner** — the same checks as `brain status`/`doctor`, phrased as something
  actionable ("your powershell shell has no hook — commands typed there are not captured").
- **Projects** — every project with its stored summary, stack, counts and watch state.
- **Per project** — *Overview* (what is stored on the row), *Brief* (regenerate, optionally with the
  local LLM), *Timeline* (1d/7d/30d/1y with the files each commit touched), *Ask* (hybrid recall
  with lexical/vector candidate counts and an honest warning when the results are semantic near-misses).

Mutations are gated by a random per-run token embedded in the page, so another website cannot drive
the loopback API. Nothing is uploaded: the page has no external assets at all.

## Recall

`brain ask` is a hybrid retriever:

- **lexical** — SQLite FTS5 (porter stemming, BM25 ranking) over project overviews, decisions,
  commits, chat turns and noteworthy commands; every user token is quoted, so punctuation can never
  be parsed as FTS syntax;
- **vector** — cosine similarity over stored embeddings, brute-forced in JS (fine at personal scale:
  no native extension to install, no sqlite-vec build);
- **fusion** — reciprocal rank fusion, so a document that both matches keywords and is semantically
  close outranks one that only does one.

Each registered project also gets an **overview document** (README opening prose, stack, languages,
layout, entry points, test command, recent commit subjects) indexed alongside the raw captures. That
is why "what does this project do?" returns a real answer instead of the vaguest commit message —
and why `ask` says `lexical 0` out loud when a query shares no words with anything you captured.

Embeddings come from **Ollama** (`nomic-embed-text` by default) when it is reachable **and the model
is installed**. Otherwise `brain` falls back to a deterministic hashed bag-of-words embedder, so
recall works with zero setup and no network. Summaries use the same logic: Ollama when available,
otherwise a high-quality deterministic brief — and when the LLM is skipped, `brain brief` prints
*why* and the exact command that fixes it (`ollama pull llama3.2`).

## Configuration

`~/.secondbrain/config.json` (defaults shown; nested values merge over these):

```jsonc
{
  "port": 47615,                          // daemon port (bumps automatically if busy)
  "daemon": { "autostart": true },        // start capture on demand instead of silently failing
  "ui": { "port": 47700 },                // brain ui (bumps automatically if busy)
  "embedding": {
    "provider": "auto",                   // auto | ollama | hash
    "model": "nomic-embed-text",
    "ollamaUrl": "http://127.0.0.1:11434",
    "hashDim": 512
  },
  "llm": {
    "provider": "auto",                   // auto | ollama | none
    "model": "llama3.2",
    "ollamaUrl": "http://127.0.0.1:11434",
    "timeoutMs": 20000
  },
  "watch": {
    "enabled": true,
    "debounceMs": 400,
    "maxEventsPerMinute": 600,            // per-project throttle for build storms
    "ignore": ["**/node_modules/**", "**/.git/**", "**/dist/**", "..."]
  },
  "brief": { "onCd": true, "minIntervalMinutes": 20, "maxEvents": 200 },
  "adapters": {
    "claudeCode": true,
    "claudeCodeDir": null,                // defaults to ~/.claude/projects
    "vscodeChat": true,                   // experimental, see below
    "dotfilePaths": [".cursor/chat", ".windsurf/chat", ".brain-notes"]
  }
}
```

Edit with `brain config --set brief.minIntervalMinutes=5` or `brain config --path` and your editor.

## Testing

```bash
npm run typecheck     # tsc --noEmit over src
npm test              # build, then node:test suite (59 tests)
npm run test:fast     # suite only, against the existing build
```

The suite covers schema/migration behaviour, path normalisation, project resolution, git log parsing
and real-repo backfill, hook install/chain/uninstall, ingestion filters, FTS-query safety, hybrid
recall ranking, timeline merging, brief generation, the bash/zsh **and PowerShell** snippet
contracts, project-profile extraction and metadata round trips, recall of the project overview
document, the watcher's ignore rules (with a real chokidar run), each chat adapter against fixtures,
and a `vm.Script` compile check of the emitted UI page so a broken template escape cannot ship.

## Limits and known trade-offs

- **Adapter fragility.** `vscode-chat` reads undocumented `state.vscdb` keys. It is defensive —
  anything it cannot parse is skipped, never guessed — but editor updates can break it. Claude Code
  JSONL is the stable path; `--list` shows what is enabled.
- **Dot-folder notes need timestamps.** Per-project note files are only ingested when each entry
  carries its own timestamp (`[ISO date] text`, or a `ts`/`timestamp` field). Undated notes are
  skipped rather than being stamped with a file mtime, which would corrupt the timeline.
- **Vector search is brute force.** Intentional: at personal scale (thousands of items) an O(n)
  cosine scan is faster than loading a native extension. Swap in `sqlite-vec` if the index grows
  past ~100k items.
- **Windows path dialects.** Git Bash reports `/c/Users/...` and WSL `/mnt/c/...`; `brain` translates
  both to `C:/...` so shell-captured cwd values match deliberately registered project paths, and
  `/tmp/...` is mapped to the real Windows temp directory.
- **Shells other than bash/zsh/PowerShell.** `cmd.exe` has no hook mechanism worth installing, and
  fish/nushell are not covered. `brain shell print` shows the snippet to adapt.
- **`global://` bucket.** Cross-project decisions live in a synthetic project hidden from listings;
  project-scoped `ask` still includes it.
- Every command is stored locally. Nothing leaves the machine unless you point the LLM/embeddings at
  a remote endpoint yourself.

## Layout

```
src/
  index.ts              CLI entry (commander)
  config.ts             config shape, defaults, merge
  cli/                  one module per command group + shared context/output helpers
  core/                 projects, events, commits, decisions, chat, briefs, indexing, recall, timeline
  db/                   schema + open/migrate/wipe
  embeddings/           embedder (Ollama + offline hash), vector store, cosine
  capture/              shell hooks (bash/zsh/PowerShell), line protocol, TCP daemon server, client, watcher, ingestion
  ui/                   local web app (`brain ui`): loopback JSON API + single-page front end
  adapters/             IDE chat adapters (claude-code, vscode-chat, dotfile)
  git/                  git shell-out, history parsing, backfill, hook lifecycle
  llm/                  Ollama generation client
  summarize/            stack/language detection, project profiles, briefs (LLM + heuristic)
  util/                 paths, logger, formatting
test/                   node:test suite + fixtures helpers
```
