/**
 * SQLite schema for Second Brain OS.
 *
 * Every table that surfaces on the unified timeline carries `ts` parsed from the
 * *content* (git commit time, chat message time, command wall-clock), never from
 * file mtime, so cross-source events merge-sort correctly.
 */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  path          TEXT    NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  git_remote    TEXT,
  stack         TEXT,
  summary       TEXT,
  open_threads  TEXT,
  ignored       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  exit_code   INTEGER,
  ts          INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  session_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_ts         ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type       ON events(type);

CREATE TABLE IF NOT EXISTS commits (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hash          TEXT    NOT NULL,
  author        TEXT,
  message       TEXT,
  files_changed INTEGER NOT NULL DEFAULT 0,
  insertions    INTEGER NOT NULL DEFAULT 0,
  deletions     INTEGER NOT NULL DEFAULT 0,
  files         TEXT,
  ts            INTEGER NOT NULL,
  UNIQUE(project_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_commits_project_ts ON commits(project_id, ts DESC);

CREATE TABLE IF NOT EXISTS chat_turns (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  source_ide  TEXT    NOT NULL,
  role        TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  ts          INTEGER NOT NULL,
  source_ref  TEXT,
  UNIQUE(source_ide, source_ref)
);
CREATE INDEX IF NOT EXISTS idx_chat_project_ts ON chat_turns(project_id, ts DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  text        TEXT    NOT NULL,
  tags        TEXT,
  source      TEXT,
  ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_project_ts ON decisions(project_id, ts DESC);

CREATE TABLE IF NOT EXISTS contradictions (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  a_id        INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  b_id        INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  category    TEXT    NOT NULL,
  choice_a    TEXT    NOT NULL,
  choice_b    TEXT    NOT NULL,
  score       REAL    NOT NULL DEFAULT 0,
  reason      TEXT    NOT NULL,
  detected_at INTEGER NOT NULL,
  dismissed   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(a_id, b_id)
);
CREATE INDEX IF NOT EXISTS idx_contradictions_project ON contradictions(project_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS briefs (
  id               INTEGER PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  summary_text     TEXT    NOT NULL,
  generated_at     INTEGER NOT NULL,
  event_watermark  INTEGER,
  generator        TEXT
);
CREATE INDEX IF NOT EXISTS idx_briefs_project ON briefs(project_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS embeddings (
  id          INTEGER PRIMARY KEY,
  owner_type  TEXT    NOT NULL,
  owner_id    INTEGER NOT NULL,
  project_id  INTEGER,
  model       TEXT    NOT NULL,
  dim         INTEGER NOT NULL,
  vector      BLOB    NOT NULL,
  text        TEXT    NOT NULL,
  ts          INTEGER NOT NULL,
  UNIQUE(owner_type, owner_id, model)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_owner   ON embeddings(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_project ON embeddings(project_id);

-- Unified lexical index over decisions, commits, chat turns and noteworthy events.
CREATE TABLE IF NOT EXISTS search_docs (
  id         INTEGER PRIMARY KEY,
  owner_type TEXT    NOT NULL,
  owner_id   INTEGER NOT NULL,
  project_id INTEGER,
  ts         INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  UNIQUE(owner_type, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_search_docs_project ON search_docs(project_id, ts DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  text,
  content='search_docs',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO search_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

/** Tables wiped by `brain reset --data` (schema is recreated on next open). */
export const DATA_TABLES = [
  'embeddings',
  'search_docs',
  'contradictions',
  'briefs',
  'decisions',
  'chat_turns',
  'commits',
  'events',
  'projects',
] as const;
