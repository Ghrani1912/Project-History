import fs from 'node:fs';
import path from 'node:path';
import type { BrainConfig } from '../config.js';
import { listProjects } from '../core/projects.js';
import type { Db } from '../db/index.js';
import { log } from '../util/logger.js';
import { truncate } from '../util/format.js';
import type { Adapter, CollectOptions, RawChatEvent } from './types.js';

const TEXT_EXTENSIONS = new Set(['.md', '.json', '.jsonl', '.txt', '.log']);

/**
 * Editors and tools that keep a per-project dot-folder (`.cursor/chat`,
 * `.brain-notes`, …) are the easiest source: we just read files. To keep the
 * unified timeline honest we only ingest entries that carry their own timestamp —
 * a leading `[ISO date]` or a `ts`/`timestamp` field in JSON/JSONL.
 */
export function parseTimestampedText(file: string, raw: string): Array<{ ts: number; text: string }> {
  const out: Array<{ ts: number; text: string }> = [];
  if (file.endsWith('.jsonl')) {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const ts = coerceTs(parsed.ts ?? parsed.timestamp ?? parsed.time ?? parsed.createdAt);
        const text = [parsed.text, parsed.content, parsed.message, parsed.role]
          .filter((v): v is string => typeof v === 'string')
          .join(' ');
        if (ts !== null && text.trim().length > 0) out.push({ ts, text: text.trim() });
      } catch {
        const inline = parseInlineTimestamp(trimmed);
        if (inline) out.push(inline);
      }
    }
    return out;
  }
  if (file.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const ts = coerceTs(record.ts ?? record.timestamp ?? record.time ?? record.createdAt);
        const text = [record.text, record.content, record.message, record.title]
          .filter((v): v is string => typeof v === 'string')
          .join(' ');
        if (ts !== null && text.trim().length > 0) out.push({ ts, text: text.trim() });
      }
    } catch {
      // Not valid JSON; fall through to the line parser.
    }
    return out;
  }
  for (const line of raw.split('\n')) {
    const inline = parseInlineTimestamp(line);
    if (inline) out.push(inline);
  }
  return out;
}

function coerceTs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `[2026-01-02T10:00:00Z] some note` */
function parseInlineTimestamp(line: string): { ts: number; text: string } | null {
  const match = /^\s*\[([^\]]{8,40})\]\s*(.+)$/.exec(line);
  if (!match) return null;
  const ts = coerceTs(match[1]);
  const text = (match[2] ?? '').trim();
  if (ts === null || text.length === 0) return null;
  return { ts, text };
}

function listFiles(dir: string, limit: number): string[] {
  const files: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (files.length >= limit) return;
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  walk(dir, 0);
  return files;
}

export function dotfileAdapter(db: Db): Adapter {
  return {
    id: 'dotfile',
    description: 'Per-project dot-folders (.cursor/chat, .brain-notes, …) with timestamped notes',
    enabled(config: BrainConfig): boolean {
      return config.adapters.dotfilePaths.length > 0;
    },
    async collect(config: BrainConfig, options: CollectOptions): Promise<RawChatEvent[]> {
      const events: RawChatEvent[] = [];
      const limit = options.limit ?? 2000;
      for (const project of listProjects(db)) {
        for (const relative of config.adapters.dotfilePaths) {
          const target = path.join(project.path, relative);
          if (!fs.existsSync(target)) continue;
          const files = fs.statSync(target).isDirectory() ? listFiles(target, 200) : [target];
          for (const file of files) {
            if (events.length >= limit) break;
            let raw: string;
            try {
              raw = fs.readFileSync(file, 'utf8');
            } catch (err) {
              log.debug(`dotfile adapter cannot read ${file}: ${String(err)}`);
              continue;
            }
            const entries = parseTimestampedText(file, raw);
            entries.forEach((entry, index) => {
              if (options.since && entry.ts < options.since) return;
              events.push({
                sourceIde: 'dotfile',
                role: 'note',
                text: truncate(entry.text, 20000),
                ts: entry.ts,
                sourceRef: `${file}#${index}`,
                cwd: project.path,
              });
            });
          }
        }
      }
      return events;
    },
  };
}
