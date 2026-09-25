import type { BrainConfig } from '../config.js';
import { resolveProjectForPath } from '../core/projects.js';
import type { Db } from '../db/index.js';
import { recordChatTurn, type Indexer } from '../capture/ingest.js';
import { log } from '../util/logger.js';
import { claudeCodeAdapter } from './claudeCode.js';
import { dotfileAdapter } from './dotfile.js';
import { vscodeChatAdapter } from './vscodeChat.js';
import type { Adapter, AdapterReport, CollectOptions } from './types.js';

export function allAdapters(db: Db): Adapter[] {
  return [claudeCodeAdapter, vscodeChatAdapter, dotfileAdapter(db)];
}

export function findAdapter(db: Db, id: string): Adapter | null {
  return allAdapters(db).find((adapter) => adapter.id === id) ?? null;
}

export interface RunAdaptersOptions extends CollectOptions {
  /** Restrict to a single adapter id. */
  only?: string;
  /** Project scope: skip chats whose cwd resolves elsewhere. */
  projectId?: number | null;
}

export async function runAdapters(
  db: Db,
  index: Indexer,
  config: BrainConfig,
  options: RunAdaptersOptions = {},
): Promise<AdapterReport[]> {
  const reports: AdapterReport[] = [];
  const adapters = options.only
    ? allAdapters(db).filter((adapter) => adapter.id === options.only)
    : allAdapters(db);
  if (options.only && adapters.length === 0) {
    throw new Error(`unknown adapter "${options.only}" (try: ${allAdapters(db).map((a) => a.id).join(', ')})`);
  }
  for (const adapter of adapters) {
    if (!adapter.enabled(config)) {
      reports.push({ adapter: adapter.id, scanned: 0, inserted: 0, skipped: true, reason: 'disabled in config' });
      continue;
    }
    try {
      const events = await adapter.collect(config, { limit: options.limit, since: options.since });
      let inserted = 0;
      for (const event of events) {
        let projectId: number | null = null;
        if (event.cwd) {
          const project = resolveProjectForPath(db, event.cwd);
          projectId = project?.id ?? null;
        }
        if (options.projectId !== undefined && options.projectId !== null) {
          if (projectId !== options.projectId) continue;
        }
        const result = await recordChatTurn(db, index, {
          projectId,
          sourceIde: event.sourceIde,
          role: event.role,
          text: event.text,
          ts: event.ts,
          sourceRef: event.sourceRef,
        });
        if (result.created) inserted++;
      }
      reports.push({ adapter: adapter.id, scanned: events.length, inserted, skipped: false });
    } catch (err) {
      log.warn(`adapter ${adapter.id} failed: ${String(err)}`);
      reports.push({ adapter: adapter.id, scanned: 0, inserted: 0, skipped: true, reason: String(err) });
    }
  }
  return reports;
}
