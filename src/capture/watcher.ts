import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ProjectRow } from '../core/types.js';
import { log } from '../util/logger.js';

/**
 * Translate a `**`-style glob into a RegExp.
 *
 * chokidar 4 removed glob support from `ignored`, so the config keeps globs as
 * its readable format and we compile them here.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          // `**/` — any number of leading path segments.
          i++;
          source += '(?:.*/)?';
        } else {
          // Trailing `**` — everything below this point, at any depth.
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

/** Compile ignore globs into a predicate over forward-slashed absolute paths. */
export function buildIgnoreMatcher(patterns: string[]): (candidate: string) => boolean {
  const regexes = patterns.map(globToRegExp);
  return (candidate: string): boolean => {
    const normalized = candidate.replace(/\\/g, '/');
    return regexes.some((regex) => regex.test(normalized) || regex.test(`/${normalized}`));
  };
}

export interface FileTouch {
  projectId: number;
  action: 'create' | 'change' | 'delete';
  /** Path relative to the project root, forward slashes. */
  path: string;
  ts: number;
}

export type FileTouchHandler = (touch: FileTouch) => void;

export interface WatcherOptions {
  ignore: string[];
  debounceMs: number;
  maxEventsPerMinute: number;
}

/** Paths that are pure noise for a "what did I touch" timeline. */
export const DEFAULT_IGNORE_EXTRA = ['**/*.log', '**/*.lock', '**/*.tmp', '**/.DS_Store'];

/**
 * One chokidar watcher per registered project. Debounced and rate-limited so a
 * build storm cannot flood the timeline.
 */
export class ProjectWatcher {
  private readonly watchers = new Map<number, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly windowStart = new Map<number, number>();
  private readonly windowCount = new Map<number, number>();

  constructor(
    private readonly options: WatcherOptions,
    private readonly onTouch: FileTouchHandler,
  ) {}

  watch(project: ProjectRow): boolean {
    if (this.watchers.has(project.id)) return false;
    const isIgnored = buildIgnoreMatcher([...this.options.ignore, ...DEFAULT_IGNORE_EXTRA]);
    const watcher = chokidar.watch(project.path, {
      ignored: (candidate: string) => isIgnored(candidate),
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      depth: 12,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    watcher.on('add', (file) => this.enqueue(project, 'create', file));
    watcher.on('change', (file) => this.enqueue(project, 'change', file));
    watcher.on('unlink', (file) => this.enqueue(project, 'delete', file));
    watcher.on('error', (err) => log.warn(`watcher error in ${project.path}: ${String(err)}`));
    this.watchers.set(project.id, watcher);
    log.debug(`watching ${project.path}`);
    return true;
  }

  unwatch(projectId: number): void {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return;
    void watcher.close();
    this.watchers.delete(projectId);
  }

  /** Reconcile the set of watched projects with the current registry. */
  sync(projects: ProjectRow[]): { watching: number[]; stopped: number[] } {
    const watching: number[] = [];
    const stopped: number[] = [];
    const wanted = new Set(projects.filter((p) => p.ignored === 0).map((p) => p.id));
    for (const project of projects) {
      if (project.ignored === 0 && this.watch(project)) watching.push(project.id);
    }
    for (const id of [...this.watchers.keys()]) {
      if (!wanted.has(id)) {
        this.unwatch(id);
        stopped.push(id);
      }
    }
    return { watching, stopped };
  }

  list(): number[] {
    return [...this.watchers.keys()];
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
  }

  private rateLimited(projectId: number, now: number): boolean {
    if (this.options.maxEventsPerMinute <= 0) return false;
    const start = this.windowStart.get(projectId) ?? 0;
    if (now - start > 60_000) {
      this.windowStart.set(projectId, now);
      this.windowCount.set(projectId, 0);
    }
    const count = (this.windowCount.get(projectId) ?? 0) + 1;
    this.windowCount.set(projectId, count);
    return count > this.options.maxEventsPerMinute;
  }

  private enqueue(project: ProjectRow, action: FileTouch['action'], absolutePath: string): void {
    const relative = path.relative(project.path, absolutePath).replace(/\\/g, '/');
    if (relative.startsWith('..')) return;
    const key = `${project.id}:${relative}:${action}`;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      const now = Date.now();
      if (this.rateLimited(project.id, now)) return;
      this.onTouch({ projectId: project.id, action, path: relative, ts: now });
    }, this.options.debounceMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }
}
