import type { BrainConfig } from '../config.js';

/** A normalised chat message emitted by any adapter. */
export interface RawChatEvent {
  sourceIde: string;
  role: string;
  text: string;
  /** Epoch millis parsed from the message itself — never the file mtime. */
  ts: number;
  /** Stable pointer so re-ingesting the same transcript is idempotent. */
  sourceRef: string;
  /** Working directory the conversation belongs to, when the source records it. */
  cwd?: string | null;
}

export interface CollectOptions {
  /** Cap how many events a single run may emit. */
  limit?: number;
  /** Only emit events newer than this epoch-ms value. */
  since?: number;
}

export interface Adapter {
  readonly id: string;
  readonly description: string;
  readonly experimental?: boolean;
  /** Whether the adapter should run for this configuration/environment. */
  enabled(config: BrainConfig): boolean;
  collect(config: BrainConfig, options: CollectOptions): Promise<RawChatEvent[]>;
}

export interface AdapterReport {
  adapter: string;
  scanned: number;
  inserted: number;
  skipped: boolean;
  reason?: string;
}
