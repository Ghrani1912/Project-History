import fs from 'node:fs';
import path from 'node:path';
import { brainHome, normalizePath } from '../util/paths.js';
import { git } from './git.js';
import type { ProjectRow } from '../core/types.js';

/**
 * Recall-only sources: a repository you read but do not work in. Instead of a
 * working checkout, we keep a shallow bare clone under the brain home, so
 * briefs, commits and recall all read real git history from the disk — while
 * the things that genuinely need a live workspace (commands, errors, file
 * touches, IDE chat) are honestly reported as unavailable rather than faked.
 */

/**
 * The schemes git itself accepts. Kept as a string in one place because the
 * local UI re-implements the detection rule — its script is a self-contained
 * string and cannot import this module — and a divergent rule there means the
 * dialog promises "Register git link" for something this side rejects as a
 * missing folder. test/ui.test.ts runs both over the same inputs so they cannot
 * drift apart again.
 */
export const GIT_URL_SCHEMES = 'https?|ssh|git';

/** Git URLs (https/ssh/git) as opposed to local paths. */
export function looksLikeGitUrl(target: string): boolean {
  // Any accepted scheme with a host and a path component can only be a remote —
  // a local path never starts with a scheme — so the .git suffix is optional.
  // The scp-like `git@host:owner/repo` form carries no scheme and is matched
  // separately.
  if (new RegExp(`^(${GIT_URL_SCHEMES})://[^/]+/\\S+`, 'i').test(target)) return true;
  return /^(git|ssh)@/i.test(target);
}

/** Cache dir for remote clones: ~/.secondbrain/remotes/<host>-<owner>-<repo> */
export function remoteCachePath(url: string): string {
  const m = url.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)?([^/:]+)[/:](.+?)(?:\.git)?\/?$/i);
  if (!m) return path.join(brainHome(), 'remotes', url.replace(/[^a-z0-9]+/gi, '-').slice(0, 60));
  const [owner, repo] = m[2]!.split('/');
  const safe = `${m[1]}-${owner ?? 'x'}-${(repo ?? 'x').replace(/\.git$/i, '')}`.replace(/[^a-z0-9.-]+/gi, '-');
  return path.join(brainHome(), 'remotes', safe.toLowerCase());
}

/** Root of the remote clone cache — membership here is what marks a recall-only source. */
export function remoteCacheRoot(): string {
  return normalizePath(path.join(brainHome(), 'remotes'));
}

/**
 * A project registered from a git URL lives in the clone cache and captures
 * nothing. Derived from the path rather than stored, so it needs no schema
 * change and survives imports/exports.
 */
export function isRecallOnly(project: Pick<ProjectRow, 'path' | 'git_remote'>): boolean {
  return project.path.startsWith(remoteCacheRoot());
}

export interface RemoteCloneResult {
  path: string;
  created: boolean;
  /** Commit count available in the clone, so the caller can report honestly. */
  updated: boolean;
}

/**
 * Shallow clone (or refresh of one). A working-tree clone (not bare) is
 * deliberate: the profile builder reads the README, stack and layout straight
 * from disk, which a bare clone keeps locked inside the packfile. Shallow
 * bounds the history we pull — recall wants "recent, quotable history", not
 * every commit ever.
 */
export async function ensureRemoteClone(url: string, options: { limit?: number } = {}): Promise<RemoteCloneResult> {
  const target = remoteCachePath(url);
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));
  if (fs.existsSync(path.join(target, '.git'))) {
    // Refresh in place: fetch the newest window instead of re-cloning.
    const head = await git(['fetch', '--depth', String(limit), 'origin', '--force'], target, 64 * 1024 * 1024, {
      GIT_TERMINAL_PROMPT: '0',
    });
    if (head.code !== 0) {
      // A source we cannot reach is an error, not a soft skip: otherwise a
      // dead remote registers as an empty project and looks "captured".
      throw new Error(`could not refresh ${url}: ${head.stderr.trim().split('\n')[0] ?? 'git error'}`);
    }
    await git(['reset', '--hard', 'origin/HEAD'], target).catch(() => null);
    return { path: target, created: false, updated: true };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // GIT_TERMINAL_PROMPT=0 stops terminal username/password prompts from
  // hanging a UI request, but the system credential helper (Windows Credential
  // Manager, macOS keychain…) still runs — so private repos the user has
  // already authenticated with clone without any prompting.
  const res = await git(
    ['clone', '--depth', String(limit), '--single-branch', url, target],
    brainHome(),
    64 * 1024 * 1024,
    { GIT_TERMINAL_PROMPT: '0' },
  );
  if (res.code !== 0) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error(`could not clone ${url}: ${res.stderr.trim().split('\n')[0] ?? 'git error'}`);
  }
  return { path: target, created: true, updated: false };
}

/** Registered remote sources are recall-only: no watcher, no hook, no capture. */
export function describeRemoteSource(clonePath: string): string {
  const normalized = normalizePath(clonePath);
  return normalized;
}
