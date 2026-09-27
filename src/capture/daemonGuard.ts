import fs from 'node:fs';
import type { BrainConfig } from '../config.js';
import { brainHome, daemonFile, normalizePath } from '../util/paths.js';
import { pingPort, readDaemonRecord, request } from './client.js';
import type { DaemonRecord } from './protocol.js';

/**
 * One capture daemon per brain home.
 *
 * `daemon.json` is a single file, so a second daemon used to bind the next free
 * port and overwrite it — leaving the first one running, watching the same
 * folders, and unreachable by `brain daemon stop`, which only ever knew the
 * newest pid. That is how one home ends up with three daemons.
 *
 * The guard closes that from both ends:
 *  - `claimDaemonRecord` publishes the record exclusively (`wx`), so a second
 *    daemon cannot make itself known at all: it finds a live holder and backs
 *    off instead of serving alongside it.
 *  - `findDaemons` sweeps the daemon port range with the unauthenticated ping
 *    and reports everything that answers, so a daemon started by an older
 *    version — one that had no claim to respect — can still be found and stopped
 *    rather than accumulating forever. It is adopted only when the record
 *    describes it; see `daemonSituation` for why that distinction matters.
 */

/** Consecutive ports `CaptureServer.start()` may fall back through when one is busy. */
export const DAEMON_PORT_ATTEMPTS = 25;

export interface LiveDaemon {
  pid: number;
  port: number;
  /** The brain home it reported, or null for a daemon older than the guard. */
  home: string | null;
  version: string | null;
}

/**
 * Publish this daemon's record, exclusively. False means the record already
 * exists: the caller decides whether its holder is alive (back off) or stale
 * (take the claim over).
 */
export function claimDaemonRecord(record: DaemonRecord): boolean {
  try {
    fs.writeFileSync(daemonFile(), JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Ports this home may be using: the configured one, its fallback range, and any already recorded. */
export function daemonPortRange(config: BrainConfig, extraPorts: number[] = []): number[] {
  const ports = new Set<number>();
  for (let offset = 0; offset <= DAEMON_PORT_ATTEMPTS; offset++) ports.add(config.port + offset);
  for (const port of extraPorts) {
    if (Number.isFinite(port) && port > 0) ports.add(port);
  }
  return [...ports];
}

/** Every daemon of any version that answers the ping inside this home's port range. */
export async function findDaemons(config: BrainConfig, extraPorts: number[] = []): Promise<LiveDaemon[]> {
  const replies = await Promise.all(
    daemonPortRange(config, extraPorts).map(async (port): Promise<LiveDaemon | null> => {
      const reply = await pingPort(port);
      return reply ? { pid: reply.pid, port, home: reply.home, version: reply.version } : null;
    }),
  );
  return replies
    .filter((entry): entry is LiveDaemon => entry !== null)
    .sort((left, right) => left.port - right.port);
}

/** Same directory, however the reporting process spelled it. */
function sameHome(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export interface DaemonCensus {
  /** Confirmed to serve this home. */
  mine: LiveDaemon[];
  /**
   * Identified as a second-brain daemon, but not as this home's. A daemon built
   * before the guard reports no home at all, so it lands here: real, reachable
   * and stoppable, but it cannot prove which home it serves.
   */
  unknown: LiveDaemon[];
}

export function censusDaemons(live: LiveDaemon[], home: string): DaemonCensus {
  const mine: LiveDaemon[] = [];
  const unknown: LiveDaemon[] = [];
  for (const daemon of live) {
    if (daemon.home !== null && sameHome(daemon.home, home)) mine.push(daemon);
    else unknown.push(daemon);
  }
  return { mine, unknown };
}

export interface DaemonSituation {
  /** The daemon the record describes, when it is answering — the one hooks can authenticate to. */
  recorded: LiveDaemon | null;
  /** Every daemon serving this home, the recorded one included. */
  mine: LiveDaemon[];
  /** Serving this home, but not described by the record, so no client can reach them. */
  unreachable: LiveDaemon[];
  /** Answering without saying which home they serve — a leftover from before the guard. */
  unattributed: LiveDaemon[];
}

/**
 * What this home's daemon situation actually is, in one sweep.
 *
 * Two things are being told apart, and neither is visible from the record alone:
 *
 *  - A daemon the record describes is *reachable*: its token is what the shell
 *    hook and every client authenticate with. One the record does not describe is
 *    not adoptable — the hooks have no token for it, so capture stays broken while
 *    it runs and `start` has to replace it rather than report success.
 *  - A daemon built before this guard answers the ping without saying which home
 *    it serves. When it is the one the record names, the record is proof enough
 *    that it is ours — otherwise the daemon `status` has just talked to would be
 *    listed as a stranger in the same breath.
 */
export async function daemonSituation(config: BrainConfig): Promise<DaemonSituation> {
  const record = readDaemonRecord();
  const live = await findDaemons(config, record ? [record.port] : []);
  const { mine: attributed, unknown } = censusDaemons(live, brainHome());
  const recorded = record ? (live.find((daemon) => daemon.pid === record.pid) ?? null) : null;
  const mine =
    recorded && !attributed.some((daemon) => daemon.pid === recorded.pid)
      ? [...attributed, recorded].sort((left, right) => left.port - right.port)
      : attributed;
  return {
    recorded,
    mine,
    unreachable: mine.filter((daemon) => daemon.pid !== recorded?.pid),
    unattributed: unknown.filter((daemon) => daemon.pid !== recorded?.pid),
  };
}

/**
 * Ask one daemon to stop, killing it only when it cannot be asked. A daemon
 * whose record is gone has no token to authenticate `shutdown` with, and a
 * daemon that is alive but wedged is still holding the port and the watchers.
 */
export async function stopDaemon(daemon: LiveDaemon): Promise<boolean> {
  const record = readDaemonRecord();
  if (record && record.pid === daemon.pid) {
    try {
      await request('shutdown', undefined, { record, timeoutMs: 3000 });
      return true;
    } catch {
      // Fall through to the kill.
    }
  }
  try {
    process.kill(daemon.pid);
    return true;
  } catch {
    return false;
  }
}

export interface StopReport {
  /** Pids that were asked and are gone (or were killed). */
  stopped: number[];
  /** Targeted but could not be stopped. */
  left: LiveDaemon[];
  /** Deliberately untouched: no proof they serve this home (only `force` takes these). */
  untouched: LiveDaemon[];
}

/**
 * Stop every daemon serving this home.
 *
 * `force` also takes the ones that did not report a home — a leftover from
 * before the guard. They are only stopped on request because the tool cannot
 * prove whose they are, and killing another home's capture would be worse than
 * leaving a stray process behind.
 */
export async function stopDaemonsForHome(config: BrainConfig, options: { force?: boolean } = {}): Promise<StopReport> {
  const situation = await daemonSituation(config);
  const targets = options.force ? [...situation.mine, ...situation.unattributed] : situation.mine;
  const stopped: number[] = [];
  const left: LiveDaemon[] = [];
  for (const daemon of targets) {
    if (await stopDaemon(daemon)) stopped.push(daemon.pid);
    else left.push(daemon);
  }
  return { stopped, left, untouched: options.force ? [] : situation.unattributed };
}

/**
 * After a start: any *other* daemon still serving this home is a leftover — the
 * new one owns the record now, so nothing else should be watching these folders.
 */
export async function stopLeftoverDaemons(config: BrainConfig, keepPid: number): Promise<number[]> {
  const { mine } = await daemonSituation(config);
  const stopped: number[] = [];
  for (const daemon of mine) {
    if (daemon.pid === keepPid) continue;
    if (await stopDaemon(daemon)) stopped.push(daemon.pid);
  }
  return stopped;
}

/** `pid 123 :47615` — the shape every daemon warning uses. */
export function describeDaemons(list: LiveDaemon[]): string {
  return list.map((daemon) => `pid ${daemon.pid} :${daemon.port}`).join(', ');
}

/**
 * The wording that agrees with how many daemons are named. These messages are
 * read when something is already wrong, and "pid 1 :47615 also serve this home"
 * for one daemon reads like a second failure stacked on the first.
 */
export function agree(list: LiveDaemon[], one: string, many: string): string {
  return list.length === 1 ? one : many;
}

/**
 * `pid 1 :47615 also serves this home — stop it with: brain daemon stop`. Built
 * here so callers cannot get the agreement wrong for a single stray.
 */
export function strayWarning(list: LiveDaemon[], command: string): string {
  return `${describeDaemons(list)} also ${agree(list, 'serves', 'serve')} this home — stop ${agree(list, 'it', 'them')} with: brain daemon ${command}`;
}
