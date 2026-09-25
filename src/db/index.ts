import Database from 'better-sqlite3';
import { dbPath, ensureHome } from '../util/paths.js';
import { DATA_TABLES, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type Db = Database.Database;

export interface OpenOptions {
  /** Override the database file (':memory:' is supported). */
  path?: string;
  readonly?: boolean;
}

export function openDatabase(options: OpenOptions = {}): Db {
  const file = options.path ?? dbPath();
  if (file !== ':memory:') ensureHome();
  const db = new Database(file, { readonly: options.readonly === true });
  if (!options.readonly) migrate(db);
  return db;
}

/** Idempotently apply the schema and record the schema version. */
export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  if (current === SCHEMA_VERSION) return;
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Delete all captured rows but keep the file (and schema) in place. */
export function wipeData(db: Db): void {
  const tx = db.transaction(() => {
    for (const table of DATA_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare("INSERT INTO search_fts(search_fts) VALUES('rebuild')").run();
  });
  tx();
}
