import type { Command } from 'commander';
import { ask } from '../core/recall.js';
import type { OwnerType, SearchHit } from '../core/types.js';
import { relativeTime, truncate } from '../util/format.js';
import { action, createContext, getEmbedder, resolveSelectedProject } from './context.js';
import { c, heading, kindBadge, out, printJson, warn } from './output.js';

function renderHit(hit: SearchHit, index: number): void {
  const scope = hit.projectName ? c.grey(hit.projectName) : c.grey('global');
  out(
    `${c.grey(String(index + 1).padStart(2))}. ${kindBadge(hit.ownerType)} ${c.grey(
      relativeTime(hit.ts).padEnd(14),
    )} ${scope} ${c.grey(`[${hit.via.join('+')}]`)}`,
  );
  out(`    ${truncate(hit.text, 160)}`);
}

export function registerRecallCommands(program: Command): void {
  program
    .command('ask')
    .description('Natural-language recall across decisions, commits, commands and chat')
    .argument('<query...>', 'what you want to remember')
    .option('-p, --project <project>', 'limit to a project (global decisions always included)')
    .option('-g, --global', 'only cross-project memory')
    .option('-l, --limit <n>', 'max results', (v) => Number(v), 8)
    .option('--days <n>', 'only consider activity from the last N days', (v) => Number(v))
    .option('--types <types>', 'comma-separated: decision,commit,chat,event')
    .option('--provider <provider>', 'auto|ollama|hash')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          words: string[],
          options: {
            project?: string;
            global?: boolean;
            limit: number;
            days?: number;
            types?: string;
            provider?: 'auto' | 'ollama' | 'hash';
            json?: boolean;
          },
        ) => {
          const query = words.join(' ').trim();
          if (query.length === 0) throw new Error('empty query');
          const { db, config, close } = createContext();
          try {
            const embedder = await getEmbedder(config, options.provider);
            const project = resolveSelectedProject(db, options);
            const ownerTypes = options.types
              ? (options.types.split(',').map((t) => t.trim()) as OwnerType[])
              : undefined;
            const since = options.days ? Date.now() - options.days * 86_400_000 : undefined;
            const result = await ask(db, embedder, query, {
              projectId: project?.id ?? null,
              limit: options.limit,
              since,
              ownerTypes,
            });
            if (options.json) {
              printJson({
                query,
                project: project?.name ?? null,
                embedder: result.embedderModel,
                lexicalCandidates: result.lexicalCount,
                vectorCandidates: result.vectorCount,
                hits: result.hits,
              });
              return;
            }
            heading(`“${query}”${project ? ` — ${project.name}` : ''}`);
            out(c.grey(`  ${result.embedderModel} · ${result.lexicalCount} lexical / ${result.vectorCount} vector candidates`));
            out('');
            if (result.hits.length === 0) {
              warn('nothing matched — try fewer words, or `brain ask` after capturing more activity');
              return;
            }
            result.hits.forEach(renderHit);
            out('');
            out(c.grey(`  full text: brain timeline ${project ? `--project ${project.name} ` : ''}--json`));
          } finally {
            close();
          }
        },
      ),
    );
}
