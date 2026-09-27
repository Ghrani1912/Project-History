import fs from 'node:fs';
import path from 'node:path';
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
import { ensureRemoteClone, looksLikeGitUrl } from '../git/remote.js';
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
  /**
   * Captured stdout/stderr tail. A failing command that carries output is
   * stored as an `error` event so failed work becomes its own searchable class
   * rather than a command line with a non-zero exit code.
   */
  output?: string | null;
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
  const exitCode = input.exitCode ?? 0;
  const output = input.output ? truncate(input.output, 4000) : '';
  // A failure *with* output is a different thing from a command line: it is the
  // error text itself, which is what you actually search for months later.
  const failed = exitCode !== 0 && output.length > 0;
  const eventId = insertEvent(db, {
    projectId: project?.id ?? null,
    type: failed ? 'error' : 'cmd',
    payload: failed ? { cmd, cwd: normalizePath(input.cwd), output } : { cmd, cwd: normalizePath(input.cwd) },
    exitCode,
    ts,
    source: input.source,
    sessionId: input.sessionId ?? null,
  });
  if (project) touchProject(db, project.id, ts);
  const noteworthy = isNoteworthyCommand(cmd, exitCode);
  if (noteworthy) {
    // The error output is indexed alongside the command so `brain ask "how did I
    // fix this error"` matches on the message the terminal printed, not just on
    // the command name.
    const text = failed
      ? `error (exit ${exitCode}): ${cmd}\n${truncate(output, 2000)}`
      : `command: ${cmd}${exitCode ? ` (exit ${exitCode})` : ''}`;
    await index([
      {
        ownerType: 'event',
        ownerId: eventId,
        projectId: project?.id ?? null,
        ts,
        text,
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
  // A git URL registers a recall-only source: clone it shallowly into the
  // brain home and treat the clone as the project folder. Capture surfaces
  // (watcher, hooks, commands) do not apply and are reported as such.
  // NOTE: this check runs on the raw input — normalizePath would resolve a URL
  // against the working directory and destroy it.
  if (looksLikeGitUrl(projectPath.trim())) {
    const url = projectPath.trim();
    const clone = await ensureRemoteClone(url, { limit: options.limit });
    return finishOnboard(db, index, clone.path, {
      ...options,
      remoteUrl: url,
      recallOnly: true,
      skipHook: true,
      skipWatch: true,
    });
  }
  const normalized = normalizePath(projectPath);
  if (!fs.existsSync(normalized)) throw new Error(`path does not exist: ${normalized}`);
  if (fs.statSync(normalized).isFile()) throw new Error(`expected a folder, got a file: ${normalized}`);

  return finishOnboard(db, index, normalized, options);
}

/** The shared tail of every registration path: index history + profile. */
async function finishOnboard(
  db: Db,
  index: Indexer,
  folder: string,
  options: OnboardOptions & { remoteUrl?: string; recallOnly?: boolean; skipHook?: boolean; skipWatch?: boolean },
): Promise<OnboardResult> {
  const { project, created } = registerProject(db, folder, { name: options.name });
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
  if (options.recallOnly) {
    warnings.push(
      'recall-only source: cloned from git for history and recall — no live capture (commands, errors, file touches need a working folder)',
    );
  } else if (options.installHook !== false) {
    hook = installPostCommitHook(folder);
    if (!hook.installed && hook.reason && hook.reason !== 'not a git repository') {
      warnings.push(`could not install the post-commit hook: ${hook.reason}`);
    }
  }

  let watched = false;
  if (options.config && !options.skipWatch) {
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

export interface ConnectResult {
  project: ProjectRow;
  /** Commit rows gained by merging the working folder's full history in. */
  commitsInserted: number;
  commitsIndexed: number;
  watched: boolean;
  hook: HookResult | null;
  warnings: string[];
}

/**
 * Point an existing recall-only project at a real working folder: the same row
 * keeps its id, decisions, briefs and history — it just gains capture. Commits
 * from the local clone upsert on top of the fetched ones (hash-keyed), so the
 * timeline merges rather than duplicates.
 */
export async function connectProjectFolder(
  db: Db,
  index: Indexer,
  projectId: number,
  folder: string,
  options: { config?: BrainConfig } = {},
): Promise<ConnectResult> {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
  if (!existing) throw new Error(`no project with id ${projectId}`);
  const normalized = normalizePath(folder);
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
    throw new Error(`not a folder: ${normalized}`);
  }

  // If the folder is a checkout of a different repo, refuse: connecting is for
  // the same code, not for re-pointing the project at unrelated work.
  const { git: runGit } = await import('../git/git.js');
  const localRemote = await runGit(['remote', 'get-url', 'origin'], normalized);
  const wanted = (existing.git_remote ?? '').replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
  const found = localRemote.code === 0 ? localRemote.stdout.trim().replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase() : '';
  if (wanted && found && wanted !== found) {
    throw new Error(
      `that folder points at ${found || 'no remote'} — this project tracks ${wanted}. Use unregister + register instead.`,
    );
  }
  // Every validation passed: the path swap below must succeed. A folder that is
  // already its own registered project collides with projects.path UNIQUE —
  // say that plainly instead of leaking the SQLite error.
  const clash = db
    .prepare('SELECT id, name FROM projects WHERE path = ? AND id != ?')
    .get(normalized, projectId) as { id: number; name: string } | undefined;
  if (clash) {
    throw new Error(`"${clash.name}" (project #${clash.id}) is already registered at that folder — unregister it first if you want to merge`);
  }

  setProjectMeta(db, projectId, { name: path.basename(normalized) || existing.name });
  db.prepare('UPDATE projects SET path = ?, last_seen_at = ? WHERE id = ?').run(normalized, Date.now(), projectId);

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow;
  const backfill = await backfillHistory(db, project, {});
  const profile = await buildProjectProfile(db, project);
  setProjectMeta(db, projectId, {
    stack: profile.stack.length > 0 ? profile.stack.join(', ') : null,
    summary: profile.summary,
    git_remote: profile.isGitRepo ? profile.gitRemote : null,
  });
  const commitsIndexed = await indexProjectCommits(db, index, projectId);
  await index([{ ownerType: 'project', ownerId: projectId, projectId, ts: Date.now(), text: profile.doc }]);

  const hook = installPostCommitHook(normalized);
  const warnings: string[] = [];
  if (!hook.installed && hook.reason && hook.reason !== 'not a git repository') {
    warnings.push(`could not install the post-commit hook: ${hook.reason}`);
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

  const refreshed = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow;
  return {
    project: refreshed,
    commitsInserted: backfill.inserted,
    commitsIndexed,
    watched,
    hook,
    warnings,
  };
}
