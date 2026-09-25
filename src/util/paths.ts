import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root of all on-disk state. Overridable so tests (and power users) can isolate it. */
export function brainHome(): string {
  const env = process.env.SECOND_BRAIN_HOME;
  if (env && env.trim().length > 0) return path.resolve(env);
  return path.join(os.homedir(), '.secondbrain');
}

export function ensureHome(): string {
  const home = brainHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export function dbPath(): string {
  const env = process.env.SECOND_BRAIN_DB;
  if (env && env.trim().length > 0) return path.resolve(env);
  return path.join(brainHome(), 'db.sqlite');
}

export function configPath(): string {
  return path.join(brainHome(), 'config.json');
}

/** Where the daemon publishes its listen address + auth token. */
export function daemonFile(): string {
  return path.join(brainHome(), 'daemon.json');
}

export function logPath(): string {
  return path.join(brainHome(), 'daemon.log');
}

export function pidPath(): string {
  return path.join(brainHome(), 'daemon.pid');
}

/** Shell-sourceable daemon credentials, read by the shell hook fast path. */
export function shellEnvFile(): string {
  return path.join(brainHome(), 'daemon.env');
}

/**
 * Canonical form used for every path we store or compare: absolute, `~` expanded,
 * forward slashes only. Node accepts forward slashes on Windows, so one form works
 * for both the database and shelling out to git.
 */
export function normalizePath(input: string, base?: string): string {
  // Translate shell dialects *before* path.resolve, otherwise `path.resolve`
  // already mangles `/c/Users/x` into `C:\c\Users\x` on Windows.
  const expanded = expandHome(translatePosixMount(input));
  const resolved = base ? path.resolve(base, expanded) : expanded;
  return resolved.replace(/\\/g, '/');
}

/**
 * On Windows, shells report paths in their own dialect: Git Bash/MSYS uses
 * `/c/Users/...` and WSL uses `/mnt/c/Users/...`, while Node sees
 * `C:/Users/...`. Translating keeps shell-captured cwd values matching the
 * deliberately-registered project paths.
 */
function translatePosixMount(input: string): string {
  if (process.platform !== 'win32') return input;
  const wsl = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(input);
  if (wsl && wsl[1] && wsl[2]) return `${wsl[1].toUpperCase()}:/${wsl[2]}`;
  const msys = /^\/([a-zA-Z])\/(.*)$/.exec(input);
  if (msys && msys[1] && msys[2]) return `${msys[1].toUpperCase()}:/${msys[2]}`;
  return input;
}

/** Expand a leading `~` and normalise separators so paths compare predictably. */
export function expandHome(input: string): string {
  let p = input;
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}
