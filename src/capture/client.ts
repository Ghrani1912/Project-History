import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { BrainConfig } from '../config.js';
import { cliEntryPath, daemonFile } from '../util/paths.js';
import { log } from '../util/logger.js';
import type { DaemonRecord, RequestMessage, RequestOp, ResponseMessage } from './protocol.js';

export function readDaemonRecord(): DaemonRecord | null {
  try {
    if (!fs.existsSync(daemonFile())) return null;
    const record = JSON.parse(fs.readFileSync(daemonFile(), 'utf8')) as DaemonRecord;
    if (!record.port || !record.token) return null;
    return record;
  } catch {
    return null;
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  record?: DaemonRecord;
}

/** Send one request to the daemon. Rejects when the daemon is unreachable. */
export function request<T = unknown>(
  op: RequestOp,
  payload?: unknown,
  options: RequestOptions = {},
): Promise<ResponseMessage<T>> {
  const record = options.record ?? readDaemonRecord();
  if (!record) return Promise.reject(new Error('daemon is not running'));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const message: RequestMessage = {
    id: crypto.randomUUID(),
    token: record.token,
    op,
    payload,
  };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: record.host ?? '127.0.0.1', port: record.port });
    let buffer = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`daemon request timed out (${op})`))), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as ResponseMessage<T>;
        finish(() => resolve(response));
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      finish(() => reject(err));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      finish(() => reject(new Error('daemon closed the connection')));
    });
  });
}

/**
 * Whether a pid exists and could be signalled (EPERM means it exists but is
 * somebody else's). Used to tell a *live* record from a stale one without
 * pinging it — after a crash the port may already have been re-bound by the
 * process doing the asking, and a ping would then answer from ourselves.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function pingDaemon(record?: DaemonRecord, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await request('ping', undefined, { record: record ?? undefined, timeoutMs });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ping a port with no recorded token.
 *
 * `ping` is the unauthenticated op by design (it is how a shell hook checks the
 * daemon is up before sending anything), and that is what makes discovery
 * possible: a daemon whose record was overwritten by a later start can still be
 * identified by sweeping the port range. Returns null when nothing — or nothing
 * speaking this protocol — answers.
 */
export async function pingPort(
  port: number,
  timeoutMs = 250,
): Promise<{ pid: number; home: string | null; version: string | null } | null> {
  const probe: DaemonRecord = { pid: 0, port, host: '127.0.0.1', token: '', startedAt: 0, version: '' };
  try {
    const res = await request<{ pid?: unknown; home?: unknown; version?: unknown }>('ping', undefined, {
      record: probe,
      timeoutMs,
    });
    if (!res.ok || !res.result) return null;
    const pid = Number(res.result.pid ?? 0);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      pid,
      home: typeof res.result.home === 'string' ? res.result.home : null,
      version: typeof res.result.version === 'string' ? res.result.version : null,
    };
  } catch {
    return null;
  }
}

/**
 * Watched project ids from a daemon `status` reply.
 *
 * Accepts both shapes on purpose: older daemons reported a *count* here, and a
 * stale daemon left running across an upgrade is completely normal. Treating a
 * count as an array used to throw `watched.includes is not a function` and take
 * the whole status/UI response down with it.
 */
export function watchedProjectIds(status: unknown): number[] {
  const value = (status as { watched?: unknown } | null | undefined)?.watched;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is number => typeof id === 'number');
}

/** Watched project count, whichever shape the daemon reported. */
export function watchedProjectCount(status: unknown): number {
  const value = (status as { watched?: unknown } | null | undefined)?.watched;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return watchedProjectIds(status).length;
}

/** Spawn the daemon detached from the current process, logging to daemon.log. */
export function startDaemonDetached(): void {
  // Must be the CLI entry, not whatever process happens to be importing us.
  const entry = cliEntryPath();
  if (!entry) throw new Error('cannot determine CLI entry point for autostart');
  const child = spawn(process.execPath, [entry, 'daemon', 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function waitForDaemon(timeoutMs = 5000): Promise<DaemonRecord | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const record = readDaemonRecord();
    // The pid has to be alive too: while a restarting daemon holds the port but
    // has not published its own record yet, a ping can answer from that very
    // process and the stale record would look like a successful start.
    if (record && isProcessAlive(record.pid) && (await pingDaemon(record))) return record;
  }
  return null;
}

/** Connect, autostarting the daemon when configured to do so. */
export async function connect(
  config?: BrainConfig,
  options: { autostart?: boolean } = {},
): Promise<DaemonRecord | null> {
  const existing = readDaemonRecord();
  if (existing && (await pingDaemon(existing))) return existing;
  const allowAutostart = options.autostart ?? config?.daemon.autostart ?? true;
  if (!allowAutostart) return null;
  try {
    startDaemonDetached();
  } catch (err) {
    log.debug(`autostart failed: ${String(err)}`);
    return null;
  }
  return waitForDaemon();
}
