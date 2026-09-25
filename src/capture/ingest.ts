import fs from 'node:fs';
import type { BrainConfig } from '../config.js';
import type { Db } from '../db/index.js';
import type { Embedder } from '../embeddings/embedder.js';
import { addDecision } from '../core/decisions.js';
import { insertChatTurn } from '../core/chat.js';
import { insertEvent } from '../core/events.js';
import { indexBatch, type IndexInput } from '../core/indexing.js';
import { registerProject, resolveProjectForPath, setProjectMeta, touchProject } from '../core/projects.js';
import type { ProjectRow } from '../core/types.js';
import { backfillHistory, installPostCommitHook, type HookResult } from '../git/git.js';
import { buildProjectProfile, type ProjectProfile } from '../summarize/profile.js';
import { normalizePath } from '../util/paths.js';
import { truncate } from '../util/format.js';
import { connect, request } from './client.js';

/** Deferred indexing hook so capture paths stay usable without an embedder. */
export type Indexer = (inputs: IndexInput[]) => Promise<void>;

export function makeIndexer(db: Db, embedder: Embedder | null): Indexer {
  return async (inputs: IndexInput[]) => {
    if (embedder) {
      await indexBatch(db, embedder, inputs);
    } else {
      const { indexLexically } = await import('../core/indexing.js');
      indexLexically(db, inputs);
    }
  };
}

const TRIVIAL_COMMANDS = new Set([
  'ls',
  'll',
  'la',
  'lsa',
  'cd',
  'pwd',
  'clear',
  'cls',
  'exit',
  'logout',
  'history',
  'which',
  'true',
  'false',
  'fg',
  'bg',
  'jobs',
  'echo',
  'date',
  'whoami',
]);

/**
 * A command is worth indexing when it carries signal: not a bare navigation
 * command, not our own CLI, and not a giant paste.
 */
export function isNoteworthyCommand(cmd: string, exitCode?: number | null): boolean {
  const trimmed = cmd.trim();
  if (trimmed.length < 3) return false;
  if (trimmed.length > 2000) return false;
  if (/^brain\b/.test(trimmed)) return false;
  if ((exitCode ?? 0) !== 0) return true;
  const first = trimmed.split(/\s+/)[0] ?? '';
  if (TRIVIAL_COMMANDS.has(first) && !trimmed.includes('|') && !trimmed.includes('>')) return false;
  return true;
}

export interface CommandInput {
  cwd: string;
  cmd: string;
  exitCode?: number | null;
  ts?: number;
  source: string;
  sessionId?: string | null;
}

export interface IngestOutcome {
  projectId: number | null;
  projectName: string | null;
  eventId: number;
  indexed: boolean;
}

export async function recordCommand(db: Db, index: Indexer, input: CommandInput): Promise<IngestOutcome> {
  const ts = input.ts ?? Date.now();
  const project = resolveProjectForPath(db, input.cwd);
  const cmd = truncate(input.cmd, 4000);
  const eventId = insertEvent(db, {
    projectId: project?.id ?? null,
    type: 'cmd',
    payload: { cmd, cwd: normalizePath(input.cwd) },
    exitCode: input.exitCode ?? 0,
    ts,
    source: input.source,
    sessionId: input.sessionId ?? null,
  });
  if (project) touchProject(db, project.id, ts);
  const noteworthy = isNoteworthyCommand(cmd, input.exitCode);
  if (noteworthy) {
    await index([
      {
        ownerType: 'event',
        ownerId: eventId,
        projectId: project?.id ?? null,
        ts,
        text: `command: ${cmd}${input.exitCode ? ` (exit ${input.exitCode})` : ''}`,
      },
    ]);
  }
  return {
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    eventId,
    indexed: noteworthy,
  };
}

export interface FileTouchInput {
  cwd: string;
  path: string;
  action: 'create' | 'change' | 'delete';
  ts?: number;
  source?: string;
}

export function recordFileTouch(db: Db, input: FileTouchInput): IngestOutcome {
  const ts = input.ts ?? Date.now();
  const project = resolveProjectForPath(db, input.cwd);
  const eventId = insertEvent(db, {
    projectId: project?.id ?? null,
    type: 'file',
    payload: { path: input.path, action: input.action },
    ts,
    source: input.source ?? 'watcher',
  });
  if (project) touchProject(db, project.id, ts);
  return { projectId: project?.id ?? null, projectName: project?.name ?? null, eventId, indexed: false };
}

export interface CommitIngestResult {
  project: ProjectRow | null;
  scanned: number;
  inserted: number;
}

/** Incrementally ingest new commits for a repo (called from the post-commit hook). */
export async function recordRepoCommits(db: Db, repoPath: string, limit = 50): Promise<CommitIngestResult> {
  const project = resolveProjectForPath(db, repoPath);
  if (!project) return { project: null, scanned: 0, inserted: 0 };
  const result = await backfillHistory(db, project, { limit, headOnly: true });
  return { project, scanned: result.scanned, inserted: result.inserted };
}

export interface DecisionInput {
  cwd?: string;
  projectId?: number | null;
  text: string;
  tags?: string[];
  source?: string;
  ts?: number;
}

export interface DecisionOutcome extends IngestOutcome {
  decisionId: number;
}

export async function recordDecision(db: Db, index: Indexer, input: DecisionInput): Promise<DecisionOutcome> {
  const ts = input.ts ?? Date.now();
  let projectId = input.projectId ?? null;
  if (projectId === null && input.cwd) {
    projectId = resolveProjectForPath(db, input.cwd)?.id ?? null;
  }
  const decisionId = addDecision(db, {
    projectId,
    text: input.text,
    tags: input.tags,
    source: input.source ?? 'manual',
    ts,
  });
  const row = db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as
    | import('../core/types.js').DecisionRow
    | undefined;
  await index([
    {
      ownerType: 'decision',
      ownerId: decisionId,
      projectId,
      ts,
      text: `decision: ${row?.text ?? input.text}`,
    },
  ]);
  return { projectId, projectName: null, eventId: decisionId, indexed: true, decisionId };
}

/** Index every commit the project already has in the database. */
export async function indexProjectCommits(db: Db, index: Indexer, projectId: number, limit = 500): Promise<number> {
  const rows = db
    .prepare('SELECT id, project_id, hash, author, message, ts, files_changed, insertions, deletions FROM commits WHERE project_id = ? ORDER BY ts DESC LIMIT ?')
    .all(projectId, limit) as Array<{
    id: number;
    project_id: number;
    hash: string;
    author: string | null;
    message: string | null;
    ts: number;
    files_changed: number;
    insertions: number;
    deletions: number;
  }>;
  if (rows.length === 0) return 0;
  const inputs: IndexInput[] = rows.map((row) => ({
    ownerType: 'commit',
    ownerId: row.id,
    projectId: row.project_id,
    ts: row.ts,
    text: `commit ${row.hash.slice(0, 7)} by ${row.author ?? 'unknown'}: ${row.message ?? ''}`.trim(),
  }));
  await index(inputs);
  return inputs.length;
}

export interface ChatIngestInput {
  cwd?: string;
  projectId?: number | null;
  sourceIde: string;
  role: string;
  text: string;
  ts: number;
  sourceRef?: string | null;
}

export async function recordChatTurn(
  db: Db,
  index: Indexer,
  input: ChatIngestInput,
): Promise<{ id: number; created: boolean; projectId: number | null }> {
  let projectId = input.projectId ?? null;
  if (projectId === null && input.cwd) {
    const project = resolveProjectForPath(db, input.cwd);
    projectId = project?.id ?? null;
  }
  const { id, created } = insertChatTurn(db, {
    projectId,
    sourceIde: input.sourceIde,
    role: input.role,
    text: input.text,
    ts: input.ts,
    sourceRef: input.sourceRef ?? null,
  });
  if (created) {
    await index([
      {
        ownerType: 'chat',
        ownerId: id,
        projectId,
        ts: input.ts,
        text: `chat (${input.sourceIde}/${input.role}): ${truncate(input.text, 4000)}`,
      },
    ]);
  }
  return { id, created, projectId };
}

export interface OnboardOptions {
  /** Cap the number of commits backfilled. */
  limit?: number;
  /** Friendly project name override. */
  name?: string;
  /** Install the git post-commit hook (default true; ignored outside a repo). */
  installHook?: boolean;
  /** When provided, a running daemon is asked to start watching immediately. */
  config?: BrainConfig;
}

export interface OnboardResult {
  project: ProjectRow;
  created: boolean;
  profile: ProjectProfile;
  commitsScanned: number;
  commitsInserted: number;
  commitsIndexed: number;
  profileIndexed: boolean;
  hook: HookResult | null;
  watched: boolean;
  warnings: string[];
}

/**
 * The whole "start tracking this folder" flow: register, scan the project,
 * store its metadata, index it for recall, install the commit hook and tell the
 * daemon to watch it. Shared by `brain register` and the local UI so both paths
 * behave identically.
 */
export async function onboardProject(
  db: Db,
  index: Indexer,
  projectPath: string,
  options: OnboardOptions = {},
): Promise<OnboardResult> {
  const normalized = normalizePath(projectPath);
  if (!fs.existsSync(normalized)) throw new Error(`path does not exist: ${normalized}`);
  if (fs.statSync(normalized).isFile()) throw new Error(`expected a folder, got a file: ${normalized}`);

  const { project, created } = registerProject(db, normalized, { name: options.name });
  const backfill = await backfillHistory(db, project, { limit: options.limit });
  const profile = await buildProjectProfile(db, project);

  setProjectMeta(db, project.id, {
    stack: profile.stack.length > 0 ? profile.stack.join(', ') : null,
    summary: profile.summary,
    git_remote: profile.isGitRepo ? profile.gitRemote : null,
  });

  const commitsIndexed = await indexProjectCommits(db, index, project.id);
  await index([
    {
      ownerType: 'project',
      ownerId: project.id,
      projectId: project.id,
      ts: Date.now(),
      text: profile.doc,
    },
  ]);

  const warnings: string[] = [];
  let hook: HookResult | null = null;
  if (options.installHook !== false) {
    hook = installPostCommitHook(normalized);
    if (!hook.installed && hook.reason && hook.reason !== 'not a git repository') {
      warnings.push(`could not install the post-commit hook: ${hook.reason}`);
    }
  }

  let watched = false;
  if (options.config) {
    const daemon = await connect(options.config).catch(() => null);
    if (daemon) {
      const response = await request('syncWatch', undefined, { record: daemon }).catch(() => null);
      watched = response?.ok === true;
    } else {
      warnings.push('the capture daemon is not running — start it with `brain daemon start`');
    }
  }

  const refreshed = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) as ProjectRow;
  return {
    project: refreshed,
    created,
    profile,
    commitsScanned: backfill.scanned,
    commitsInserted: backfill.inserted,
    commitsIndexed,
    profileIndexed: true,
    hook,
    watched,
    warnings,
  };
}
