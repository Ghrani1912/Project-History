import fs from 'node:fs';
import path from 'node:path';
import { defaultClaudeCodeDir, type BrainConfig } from '../config.js';
import { log } from '../util/logger.js';
import { truncate } from '../util/format.js';
import type { Adapter, CollectOptions, RawChatEvent } from './types.js';

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block === 'object') {
      const typed = block as { type?: string; text?: string; content?: unknown; name?: string };
      if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text);
      else if (typed.type === 'tool_use' && typed.name) parts.push(`[tool: ${typed.name}]`);
      else if (typeof typed.content === 'string') parts.push(typed.content);
    }
  }
  return parts.join('\n').trim();
}

function listTranscripts(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(dir, 0);
  return out.sort();
}

/**
 * Claude Code writes one JSONL transcript per session under
 * `~/.claude/projects/<slugged-cwd>/<session>.jsonl`. Every record carries its own
 * `timestamp` and `cwd`, so we never fall back to file mtime.
 */
export const claudeCodeAdapter: Adapter = {
  id: 'claude-code',
  description: 'Claude Code JSONL session transcripts (~/.claude/projects)',

  enabled(config: BrainConfig): boolean {
    return config.adapters.claudeCode;
  },

  async collect(config: BrainConfig, options: CollectOptions): Promise<RawChatEvent[]> {
    const dir = config.adapters.claudeCodeDir ?? defaultClaudeCodeDir();
    if (!fs.existsSync(dir)) return [];
    const events: RawChatEvent[] = [];
    const limit = options.limit ?? 5000;
    const files = listTranscripts(dir);
    for (const file of files) {
      if (events.length >= limit) break;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      // Cheap pre-filter: nothing new since the requested cut-off.
      if (options.since && stat.mtimeMs < options.since) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch (err) {
        log.debug(`claude-code: cannot read ${file}: ${String(err)}`);
        continue;
      }
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim().length === 0) continue;
        let record: TranscriptLine;
        try {
          record = JSON.parse(line) as TranscriptLine;
        } catch {
          continue;
        }
        const role = record.message?.role ?? record.type ?? 'unknown';
        if (role !== 'user' && role !== 'assistant') continue;
        const text = truncate(extractText(record.message?.content), 20000);
        if (text.length === 0) continue;
        const ts = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
        if (!Number.isFinite(ts)) continue;
        if (options.since && ts < options.since) continue;
        events.push({
          sourceIde: 'claude-code',
          role,
          text,
          ts,
          sourceRef: `${file}#${record.uuid ?? i}`,
          cwd: record.cwd ?? null,
        });
        if (events.length >= limit) break;
      }
    }
    return events;
  },
};
