import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { BrainConfig } from '../config.js';
import { daemonFile } from '../util/paths.js';
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

export async function pingDaemon(record?: DaemonRecord, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await request('ping', undefined, { record: record ?? undefined, timeoutMs });
    return res.ok;
  } catch {
    return false;
  }
}

/** Spawn the daemon detached from the current process, logging to daemon.log. */
export function startDaemonDetached(): void {
  const entry = process.argv[1];
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
    if (record && (await pingDaemon(record))) return record;
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
