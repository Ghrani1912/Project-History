import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BrainConfig } from '../config.js';
import { log } from '../util/logger.js';
import { truncate } from '../util/format.js';
import type { Adapter, CollectOptions, RawChatEvent } from './types.js';

/**
 * Editor builds whose chat history lives in a SQLite `state.vscdb`.
 * Format is undocumented and churns between releases — this adapter is
 * deliberately defensive: anything it cannot parse is skipped, never guessed.
 */
const PRODUCTS = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium'];

function productUserDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  const products = PRODUCTS;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    for (const product of products) dirs.push(path.join(appData, product, 'User'));
  } else if (process.platform === 'darwin') {
    for (const product of products) dirs.push(path.join(home, 'Library', 'Application Support', product, 'User'));
  } else {
    for (const product of products) dirs.push(path.join(home, '.config', product, 'User'));
  }
  return dirs.filter((dir) => fs.existsSync(dir));
}

function stateDbFiles(userDir: string): string[] {
  const files: string[] = [];
  const globalDb = path.join(userDir, 'globalStorage', 'state.vscdb');
  if (fs.existsSync(globalDb)) files.push(globalDb);
  const workspaceStorage = path.join(userDir, 'workspaceStorage');
  if (!fs.existsSync(workspaceStorage)) return files;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(workspaceStorage, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const db = path.join(workspaceStorage, entry.name, 'state.vscdb');
    if (fs.existsSync(db)) files.push(db);
  }
  return files;
}

/** Recover the workspace folder path from `workspace.json` next to the db. */
function workspaceFolderFor(dbFile: string): string | null {
  const workspaceJson = path.join(path.dirname(dbFile), 'workspace.json');
  if (!fs.existsSync(workspaceJson)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(workspaceJson, 'utf8')) as { folder?: string; workspace?: string };
    const uri = parsed.folder ?? parsed.workspace;
    if (!uri) return null;
    const decoded = decodeURIComponent(uri.replace(/^file:\/\/\//, '').replace(/^file:\/\//, ''));
    return process.platform === 'win32' ? decoded.replace(/\//g, '/') : `/${decoded}`.replace(/\/\//g, '/');
  } catch {
    return null;
  }
}

export interface Messageish {
  role: string;
  text: string;
  ts: number;
}

function pickTimestamp(value: Record<string, unknown>): number | null {
  for (const key of ['timestamp', 'ts', 'createdAt', 'time', 'date', 'creationDate']) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickText(value: Record<string, unknown>): string | null {
  for (const key of ['text', 'value', 'content', 'markdown', 'message', 'response', 'body']) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  }
  return null;
}

function pickRole(value: Record<string, unknown>): string | null {
  for (const key of ['role', 'sender', 'author', 'type', 'kind']) {
    const raw = value[key];
    if (typeof raw !== 'string') continue;
    const lower = raw.toLowerCase();
    if (['user', 'human', 'request', 'prompt'].includes(lower)) return 'user';
    if (['assistant', 'ai', 'bot', 'response', 'model'].includes(lower)) return 'assistant';
  }
  return null;
}

/**
 * Walk an arbitrary JSON structure looking for `{role, text, timestamp}` triples.
 * Requires a real timestamp on the message itself so cross-source merge-sort stays honest.
 */
export function walkForMessages(node: unknown, out: Messageish[], depth = 0): void {
  if (depth > 8 || out.length > 5000) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForMessages(item, out, depth + 1);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;

  const role = pickRole(record);
  const text = pickText(record);
  const ts = pickTimestamp(record);
  if (role && text && ts !== null && text.trim().length > 0) {
    out.push({ role, text: truncate(text, 20000), ts });
  }

  // Copilot Chat shape: requests[].message / requests[].response[]
  const requests = record.requests;
  if (Array.isArray(requests)) {
    for (const request of requests) {
      if (!request || typeof request !== 'object') continue;
      const item = request as Record<string, unknown>;
      const requestTs = pickTimestamp(item);
      const message = item.message;
      if (requestTs !== null) {
        if (message && typeof message === 'object') {
          const text2 = pickText(message as Record<string, unknown>);
          if (text2) out.push({ role: 'user', text: truncate(text2, 20000), ts: requestTs });
        }
        const response = item.response;
        if (Array.isArray(response)) {
          for (const part of response) {
            if (part && typeof part === 'object') {
              const text3 = pickText(part as Record<string, unknown>);
              if (text3) out.push({ role: 'assistant', text: truncate(text3, 20000), ts: requestTs });
            }
          }
        }
      }
    }
  }

  for (const value of Object.values(record)) walkForMessages(value, out, depth + 1);
}

function readChatMessages(dbFile: string): Messageish[] {
  const messages: Messageish[] = [];
  let db: Database.Database | null = null;
  try {
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT key, value FROM ItemTable').all() as Array<{ key: string; value: unknown }>;
    for (const row of rows) {
      if (!/chat|composer|conversation|aichat/i.test(row.key)) continue;
      const value = row.value;
      const text = typeof value === 'string' ? value : value instanceof Buffer ? value.toString('utf8') : null;
      if (!text) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      walkForMessages(parsed, messages);
    }
  } catch (err) {
    log.debug(`vscode/ cursor chat adapter could not read ${dbFile}: ${String(err)}`);
  } finally {
    db?.close();
  }
  return messages;
}

export const vscodeChatAdapter: Adapter = {
  id: 'vscode-chat',
  description: 'VS Code / Cursor / Windsurf chat rows in state.vscdb (experimental, format may change)',
  experimental: true,

  enabled(config: BrainConfig): boolean {
    return config.adapters.vscodeChat;
  },

  async collect(_config: BrainConfig, options: CollectOptions): Promise<RawChatEvent[]> {
    const events: RawChatEvent[] = [];
    const limit = options.limit ?? 5000;
    for (const userDir of productUserDirs()) {
      const product = path.basename(path.dirname(userDir));
      for (const dbFile of stateDbFiles(userDir)) {
        if (events.length >= limit) break;
        const cwd = workspaceFolderFor(dbFile);
        const messages = readChatMessages(dbFile);
        for (let i = 0; i < messages.length; i++) {
          const message = messages[i] as Messageish;
          if (options.since && message.ts < options.since) continue;
          events.push({
            sourceIde: `${product.toLowerCase().replace(/\s+/g, '-')}-chat`,
            role: message.role,
            text: message.text,
            ts: message.ts,
            sourceRef: `${dbFile}#${i}`,
            cwd,
          });
          if (events.length >= limit) break;
        }
      }
    }
    return events;
  },
};
