
Second Brain OS — Product Requirements Document

Owner: Ghrani · Status: Draft v0.2 · Platform: Local-first, runs on your laptop
1. Problem

You re-explain project context, re-look-up commands, and re-derive decisions you already made. There's no single system that captures what you did, why, and how — so context gets rebuilt from scratch every session (with Claude, with yourself, with teammates).
2. Goal

A local-first "Second Brain" that passively captures project state — commands run, files touched, git history, decisions made, and (optionally) IDE chat context — and makes it instantly retrievable, so you never re-explain or re-research something already known.
3. Non-goals (v1)

    Not a general note-taking app (no manual journaling UI required)
    Not cloud-synced or multi-device (single laptop, local storage)
    Not a replacement for git — it ingests git history rather than duplicating it

4. Core capabilities
# 	Capability 	What it does
1 	Command capture 	Logs shell commands per-project (cwd, exit code, timestamp)
2 	File-touch tracking 	Watches which files were created/edited per session
3 	Git history ingestion 	Backfills full commit history on project registration; captures new commits via post-commit hook (message, author, files changed, diff stats)
4 	Decision log 	Structured entries: "decided X because Y, rejected Z" — captured via CLI or auto-extracted from commit/chat text
5 	IDE chat ingestion (optional) 	Pulls prior AI-chat context from supported IDEs, merged into the same timeline
6 	Project memory 	Per-project summary: stack, structure, open threads, last state
7 	Recall/search 	Natural-language query → relevant past commands/files/commits/decisions ("how did I set up NFC auth last time?")
8 	Auto-brief 	On cd into a project or on demand, surfaces a short "here's where you left off" summary
5. Architecture

┌─────────────────────────────────────────────────┐
│  Capture Layer (background, always-on)          │
│  - shell hook (bash/zsh preexec+precmd)          │
│  - file watcher (chokidar/fswatch, per repo)     │
│  - git backfill (on register) + post-commit hook │
│  - IDE chat adapters (per-IDE, pluggable)         │
└───────────────────┬───────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────┐
│  Storage Layer                                    │
│  - SQLite (events: commands, file-touches,        │
│    commits, chat-turns)                            │
│  - Local vector DB (SQLite+sqlite-vec, or          │
│    Chroma) for semantic recall of decisions/chat   │
└───────────────────┬───────────────────────────────┘
                    ▼
┌─────────────────────────────────────────────────┐
│  Retrieval / Interface Layer                      │
│  - CLI: `brain log`, `brain ask "..."`            │
│  - Embeddings via local model (Ollama) or         │
│    API for indexing decision/chat text             │
│  - Summarizer: LLM call to compress raw logs      │
│    into human-readable briefs, timeline-sorted     │
│    across all sources                              │
└─────────────────────────────────────────────────┘

6. How it runs on the laptop

    Background daemon: a small Node.js/TypeScript process (or Python) started at login (launchd/systemd/Task Scheduler), watching active shell sessions and project directories.
    Shell integration: hook into .zshrc/.bashrc via preexec/precmd to pipe each command + cwd + exit code to the daemon over a local socket.
    File watching: per-registered-project chokidar watcher, debounced, ignoring node_modules/.git.
    Git ingestion: git log --all --numstat --format=... run once on registration to backfill history; post-commit hook installed per repo to stream new commits going forward.
    IDE chat adapters: pluggable parsers per IDE (see section 8, Phase 5) that watch each IDE's local chat-storage location and emit normalized {ts, project, text, source_ide} events.
    Storage: single SQLite file at ~/.secondbrain/db.sqlite — no external DB server needed.
    Embeddings/LLM: use local Ollama model for zero-cost, offline summarization + embedding; fallback to Claude/OpenAI API if higher quality needed and online.
    CLI: brain command (Node CLI, installed via npm link or global install) — brain status, brain log "decided to use SQLite over Postgres for simplicity", brain ask "what auth method did I use for VERA?".
    Optional VS Code extension: shows a sidebar "brief" panel per open project, pulling from the same SQLite DB.

7. Data model (SQLite)

projects(id, name, path, created_at)
events(id, project_id, type[cmd|file|commit|chat], payload, exit_code, ts, source)
commits(id, project_id, hash, author, message, files_changed, insertions, deletions, ts)
chat_turns(id, project_id, source_ide, role, text, embedding_id, ts)
decisions(id, project_id, text, tags, embedding_id, ts)
briefs(id, project_id, summary_text, generated_at)

ts is always parsed from the content itself (git commit timestamp, chat message timestamp) rather than file mtime, so cross-source events merge-sort correctly into one timeline regardless of which IDE or when a file was last touched on disk.
8. Implementation phases

Phase 1 — Capture + Git (Week 1-2)

    SQLite schema + daemon skeleton
    Shell hook for command logging
    Git backfill on project registration + post-commit hook
    Manual brain log for decisions

Phase 2 — Retrieval (Week 2-3)

    File watcher integration
    Embedding pipeline (Ollama nomic-embed-text or similar) for decisions + commits
    brain ask semantic search over decisions, commits, and recent events

Phase 3 — Auto-brief (Week 3-4)

    Summarizer that compresses last N events (including commit history) into a short brief
    Trigger on cd (via shell hook) or brain status
    Auto-suggest decision entries from commit messages

Phase 4 — Polish

    VS Code sidebar extension
    Config file to register/ignore projects
    Export/backup of SQLite db

Phase 5 — IDE chat adapters (optional, incremental)

    One small parser module per IDE, each emitting {ts, project, text, source_ide} into chat_turns
    Start with whichever IDE you use most; add others one at a time
    Known sources and difficulty:
        Claude Code: JSONL session transcripts — clean, stable, easy
        Cursor / VS Code Copilot Chat: SQLite state.vscdb in workspaceStorage, JSON blobs under undocumented keys — moderate effort, may break on IDE updates
        Tools that drop a per-project dotfile/folder (e.g. .cursor/, .windsurf/-style tools): easiest case — just watch it like any other file
        Skip any IDE whose storage format is too obfuscated to reverse-engineer cheaply
    All sources merge-sorted by in-content timestamp (never file mtime) into one cross-IDE timeline

9. Tech stack

    Runtime: Node.js + TypeScript (matches your existing local-ai-coder CLI work)
    Storage: SQLite (better-sqlite3), vector search via sqlite-vec extension
    LLM/embeddings: Ollama (local, offline-first), optional cloud fallback
    Shell hooks: POSIX-compatible (zsh/bash), Windows via PowerShell profile if needed
    File watching: chokidar
    Git parsing: simple-git or raw git log shell-out
    CLI: commander or yargs

10. Success metrics

    Time-to-context on returning to a project drops (subjective, but track: # of times you re-ask "what was I doing here")
    of decisions/commits logged and successfully retrieved via brain ask
    Daemon uptime / capture reliability (no missed commands over a normal session)

11. Risks / open questions

    Noise: raw command/chat logs are noisy — summarization quality is the make-or-break piece
    Privacy: everything stays local by default; flag before any cloud LLM call
    Cross-project decisions: some decisions apply globally, not per-project — needs a "global" project bucket
    IDE format churn: chat-storage adapters (Phase 5) are the most fragile piece and may need periodic maintenance as IDEs update

