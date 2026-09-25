import type { BrainConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { getProject, resolveProjectForPath, ensureGlobalProject } from '../core/projects.js';
import type { ProjectRow } from '../core/types.js';
import { openDatabase, type Db } from '../db/index.js';
import { createEmbedder, type Embedder } from '../embeddings/embedder.js';
import { error } from './output.js';

export interface CliContext {
  config: BrainConfig;
  db: Db;
  close(): void;
}

export function createContext(options: { dbPath?: string } = {}): CliContext {
  const config = loadConfig();
  const db = openDatabase({ path: options.dbPath });
  return {
    config,
    db,
    close: () => db.close(),
  };
}

export async function getEmbedder(config: BrainConfig, force?: 'auto' | 'ollama' | 'hash'): Promise<Embedder> {
  return createEmbedder(config, force);
}

export interface ProjectSelector {
  /** Explicit `--project` value (id, name or path). */
  project?: string;
  /** `--global` flag: use the cross-project bucket. */
  global?: boolean;
  /** Override cwd (used by shell hooks). */
  cwd?: string;
}

/**
 * Resolve which project a command targets:
 * explicit flag > cwd lookup > null (meaning "all projects").
 */
export function resolveSelectedProject(db: Db, selector: ProjectSelector): ProjectRow | null {
  if (selector.global) return ensureGlobalProject(db);
  if (selector.project) {
    const found = getProject(db, selector.project);
    if (!found) {
      error(`no project matching "${selector.project}" (see \`brain projects\`)`);
      return null;
    }
    return found;
  }
  return resolveProjectForPath(db, selector.cwd ?? process.cwd());
}

export function requireProject(db: Db, selector: ProjectSelector): ProjectRow {
  const project = resolveSelectedProject(db, selector);
  if (!project) {
    throw new Error(
      'no project selected — run this inside a registered project, pass --project <name>, or use --global',
    );
  }
  return project;
}

/** Wrap a command action so every failure exits cleanly with a message. */
export function action<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<void> | void,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    try {
      await fn(...args);
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      if (process.env.SECOND_BRAIN_DEBUG) console.error(err);
      process.exitCode = 1;
    }
  };
}
