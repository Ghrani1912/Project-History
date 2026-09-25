import fs from 'node:fs';
import { configPath, ensureHome, expandHome } from './util/paths.js';

export type EmbeddingProvider = 'auto' | 'ollama' | 'hash';
export type LlmProvider = 'auto' | 'ollama' | 'none';

export interface BrainConfig {
  /** Loopback port the capture daemon listens on. */
  port: number;
  daemon: {
    /** Start the daemon automatically when another CLI command needs it. */
    autostart: boolean;
  };
  embedding: {
    provider: EmbeddingProvider;
    model: string;
    ollamaUrl: string;
    /** Dimensions used by the offline hashing embedder. */
    hashDim: number;
  };
  llm: {
    provider: LlmProvider;
    model: string;
    ollamaUrl: string;
    /** Hard timeout for a summarization call. */
    timeoutMs: number;
  };
  watch: {
    enabled: boolean;
    debounceMs: number;
    /** Per-project throttle so a build storm cannot flood the timeline. */
    maxEventsPerMinute: number;
    ignore: string[];
  };
  brief: {
    /** Print a short brief when the shell cwd enters a registered project. */
    onCd: boolean;
    /** Don't re-brief the same project more often than this. */
    minIntervalMinutes: number;
    maxEvents: number;
  };
  adapters: {
    claudeCode: boolean;
    claudeCodeDir: string | null;
    vscodeChat: boolean;
    /** Extra per-project dot-directories to watch for chat-ish text files. */
    dotfilePaths: string[];
  };
}

export const DEFAULT_CONFIG: BrainConfig = {
  port: 47615,
  daemon: { autostart: true },
  embedding: {
    provider: 'auto',
    model: 'nomic-embed-text',
    ollamaUrl: 'http://127.0.0.1:11434',
    hashDim: 512,
  },
  llm: {
    provider: 'auto',
    model: 'llama3.2',
    ollamaUrl: 'http://127.0.0.1:11434',
    timeoutMs: 20000,
  },
  watch: {
    enabled: true,
    debounceMs: 400,
    maxEventsPerMinute: 600,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/.next/**',
      '**/target/**',
      '**/__pycache__/**',
      '**/.venv/**',
      '**/venv/**',
      '**/.DS_Store',
      '**/*.swp',
    ],
  },
  brief: { onCd: true, minIntervalMinutes: 20, maxEvents: 200 },
  adapters: {
    claudeCode: true,
    claudeCodeDir: null,
    vscodeChat: true,
    dotfilePaths: ['.cursor/chat', '.windsurf/chat', '.brain-notes'],
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursive merge of a partial file config over the defaults. */
export function mergeConfig(base: BrainConfig, patch: unknown): BrainConfig {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = mergeConfig(current as unknown as BrainConfig, value);
    } else {
      out[key] = value;
    }
  }
  return out as unknown as BrainConfig;
}

export function loadConfig(): BrainConfig {
  const file = configPath();
  if (!fs.existsSync(file)) return DEFAULT_CONFIG;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: BrainConfig): string {
  const file = configPath();
  ensureHome();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return file;
}

/** Resolve the Claude Code transcript directory for the current user. */
export function defaultClaudeCodeDir(): string {
  return expandHome('~/.claude/projects');
}
