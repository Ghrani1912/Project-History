# Second Brain OS

A local-first "second brain" that passively captures **what you did, why, and how** while you work
on a project, and makes it instantly retrievable — so you never re-explain or re-research something
you already know.

Everything lives on your laptop in one SQLite file. No account, no sync, no server.

```
┌──────────────────── Capture (background) ────────────────────┐
│ shell hook (bash/zsh preexec+precmd)  → commands + exit codes │
│ chokidar watcher per project          → files created/edited  │
│ git backfill + post-commit hook       → full commit history   │
│ IDE chat adapters                     → Claude Code, editors  │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────────────── Storage ─────────────────────────────┐
│ ~/.secondbrain/db.sqlite                                     │
│   events · commits · chat_turns · decisions · briefs         │
│   search_docs + FTS5 (lexical) · embeddings (vector)         │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────── Retrieval / Interface ───────────────────────┐
│ brain ask · brain timeline · brain brief · brain status       │
│ embeddings via Ollama (offline) with a deterministic fallback │
└──────────────────────────────────────────────────────────────┘
```

## Quickstart

```bash
npm install
npm run build
npm link                 # puts `brain` on your PATH (optional but recommended)

brain init               # home dir + db + config + shell hook
cd ~/code/my-project
brain register           # backfills git history, installs the post-commit hook, starts capture
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
| Shell commands | bash DEBUG trap / zsh `preexec`+`precmd`, written straight to the daemon socket | `events` (type `cmd`, with cwd + exit code) |
| File touches | one chokidar watcher per registered project, debounced + rate limited | `events` (type `file`) |
| Git history | `git log --all --numstat` on register; `post-commit` hook afterwards | `commits` |
| Decisions | `brain log`, plus `brain decisions --suggest` mining commit messages | `decisions` |
| IDE chat | pluggable adapters (Claude Code JSONL, VS Code/Cursor/Windsurf `state.vscdb`, dot-folders) | `chat_turns` |

**Timestamps always come from the content itself** — the git commit time, the chat message time, the
shell wall clock — never from a file mtime. That is what lets events from different sources
merge-sort into one honest timeline.

## Commands

**Projects**
- `brain init [--no-shell]` — create home, database, config, shell hook
- `brain register [path] [--name] [--limit n] [--no-hook]` — register + backfill + watch
- `brain projects [--json]` — list with per-project capture stats
- `brain unregister <project> [--keep-hook]` — stop tracking and delete captured data

**Memory**
- `brain log "<text>" [-p project] [-g] [--tags a,b]` — record a decision (`#tags` also parsed)
- `brain decisions [--suggest] [--save-suggestions]` — list or mine decisions from commit history
- `brain ask "<query>" [-p project] [--days n] [--types decision,commit,chat,event] [--json]`

**Insight**
- `brain brief [-p project] [--cached] [--heuristic] [--auto]` — summary of where you left off
- `brain timeline [--days n] [--kinds cmd,file,commit,chat,decision] [--asc] [--json]`
- `brain status [--json]` — daemon, database and index state

**Capture**
- `brain daemon start|stop|restart|status` — the background capture daemon
- `brain watch [--once]` — foreground file watching with no socket
- `brain shell install|uninstall|print|status` — shell integration
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

## Recall

`brain ask` is a hybrid retriever:

- **lexical** — SQLite FTS5 (porter stemming, BM25 ranking) over decisions, commits, chat turns and
  noteworthy commands; every user token is quoted, so punctuation can never be parsed as FTS syntax;
- **vector** — cosine similarity over stored embeddings, brute-forced in JS (fine at personal scale:
  no native extension to install, no sqlite-vec build);
- **fusion** — reciprocal rank fusion, so a document that both matches keywords and is semantically
  close outranks one that only does one.

Embeddings come from **Ollama** (`nomic-embed-text` by default) when it is reachable **and the model
is installed**. Otherwise `brain` falls back to a deterministic hashed bag-of-words embedder, so
recall works with zero setup and no network. Summaries use the same logic: Ollama when available,
otherwise a high-quality deterministic brief.

## Configuration

`~/.secondbrain/config.json` (defaults shown; nested values merge over these):

```jsonc
{
  "port": 47615,                          // daemon port (bumps automatically if busy)
  "daemon": { "autostart": true },        // start capture on demand instead of silently failing
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
npm test              # build, then node:test suite (46 tests)
npm run test:fast     # suite only, against the existing build
```

The suite covers schema/migration behaviour, path normalisation, project resolution, git log parsing
and real-repo backfill, hook install/chain/uninstall, ingestion filters, FTS-query safety, hybrid
recall ranking, timeline merging, brief generation, the shell snippet contract, the watcher's ignore
rules (with a real chokidar run), and each chat adapter against fixtures.

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
  both to `C:/...` so shell-captured cwd values match deliberately registered project paths.
  MSYS's `/tmp` has no equivalent on the Windows side and will not resolve to a project.
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
  capture/              shell hook, line protocol, TCP daemon server, client, chokidar watcher, ingestion
  adapters/             IDE chat adapters (claude-code, vscode-chat, dotfile)
  git/                  git shell-out, history parsing, backfill, hook lifecycle
  llm/                  Ollama generation client
  summarize/            stack detection, brief generation (LLM + heuristic)
  util/                 paths, logger, formatting
test/                   node:test suite + fixtures helpers
```
