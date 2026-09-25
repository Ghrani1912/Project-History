import type { EventType } from '../core/types.js';

export const PROTOCOL_VERSION = 1;

export interface CapturePayload {
  type: EventType;
  /** Working directory the capture happened in (used to resolve the project). */
  cwd: string;
  cmd?: string;
  exitCode?: number | null;
  path?: string;
  action?: 'create' | 'change' | 'delete';
  /** Epoch millis parsed from the content itself, when known. */
  ts?: number;
  source: string;
  sessionId?: string | null;
  text?: string;
}

export interface DecisionPayload {
  cwd?: string;
  project?: string;
  text: string;
  tags?: string[];
  source?: string;
  ts?: number;
}

export type RequestOp =
  | 'ping'
  | 'capture'
  | 'captureBatch'
  | 'decision'
  | 'status'
  | 'syncWatch'
  | 'brief'
  | 'shutdown';

export interface RequestMessage {
  id: string;
  token?: string;
  op: RequestOp;
  payload?: unknown;
}

export interface ResponseMessage<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Shell fast path: a tab-delimited line protocol. Shells cannot encode JSON
 * safely without spawning a process, so `brain shell install` sends these
 * lines straight to the socket over /dev/tcp (bash) or ztcp (zsh).
 * ------------------------------------------------------------------ */

export const LINE_PREFIX = 'SB1';

export interface LineMessage {
  op: 'ping' | 'cmd' | 'file' | 'brief';
  token: string;
  fields: string[];
}

/** Serialise a line-protocol message. Tabs/newlines in fields become spaces. */
export function encodeLine(message: LineMessage): string {
  return [LINE_PREFIX, message.token, message.op, ...message.fields].join('\t').replace(/[\r\n]/g, ' ');
}

export function parseLine(line: string): LineMessage | null {
  if (!line.startsWith(`${LINE_PREFIX}\t`)) return null;
  const parts = line.split('\t');
  const [, token, op, ...fields] = parts;
  if (!token || !op) return null;
  if (op !== 'ping' && op !== 'cmd' && op !== 'file' && op !== 'brief') return null;
  return { op, token, fields };
}

export interface DaemonRecord {
  pid: number;
  port: number;
  host: string;
  token: string;
  startedAt: number;
  version: string;
}
