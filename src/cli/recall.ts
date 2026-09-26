import type { Command } from 'commander';
import { detectEvidenceGap } from '../core/answer.js';
import { ask } from '../core/recall.js';
import type { OwnerType, SearchHit } from '../core/types.js';
import { relativeTime, truncate } from '../util/format.js';
import { action, createContext, getEmbedder, resolveSelectedProject } from './context.js';
import { c, heading, kindBadge, out, printJson, warn } from './output.js';

/** The interesting part of a hit: project docs start with a noisy header. */
function hitSnippet(hit: SearchHit): string {
  if (hit.ownerType === 'project') {
    const summary = hit.text.split('\n').find((line) => line.startsWith('summary:'));
    if (summary) return truncate(summary.replace(/^summary:\s*/, ''), 200);
  }
  return truncate(hit.text.replace(/^commit [0-9a-f]{7} by [^:]*:\s*/, ''), 170);
}

function renderHit(hit: SearchHit, index: number): void {
  const scope = hit.projectName ? c.grey(hit.projectName) : c.grey('global');
  out(
    `${c.grey(String(index + 1).padStart(2))}. ${kindBadge(hit.ownerType)} ${c.grey(
      relativeTime(hit.ts).padEnd(14),
    )} ${scope} ${c.grey(`[${hit.via.join('+')}]`)}`,
  );
  out(`    ${hitSnippet(hit)}`);
}

export function registerRecallCommands(program: Command): void {
  program
    .command('ask')
    .description('Natural-language recall across project overviews, decisions, commits, commands and chat')
    .argument('<query...>', 'what you want to remember')
    .option('-p, --project <project>', 'limit to a project (global decisions always included)')
    .option('-g, --global', 'only cross-project memory')
    .option('-l, --limit <n>', 'max results', (v) => Number(v), 8)
    .option('--days <n>', 'only consider activity from the last N days', (v) => Number(v))
    .option('--types <types>', 'comma-separated: project,decision,commit,chat,event')
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
            // Same evidence guard the UI answers use: a negative premise with no
            // recorded failure, or an architecture question retrieval cannot
            // ground, is refused here too rather than dressed up as results.
            const gap = detectEvidenceGap(db, project?.id ?? null, query, result.hits[0]?.score ?? 0);
            if (options.json) {
              printJson({
                query,
                project: project?.name ?? null,
                embedder: result.embedderModel,
                lexicalCandidates: result.lexicalCount,
                vectorCandidates: result.vectorCount,
                bestVectorScore: result.bestVectorScore,
                ownerTypes: result.ownerTypes,
                weak: result.weak,
                refusal: gap ? gap.reason : null,
                hits: result.hits,
              });
              return;
            }
            if (gap) {
              warn(gap.reason);
              return;
            }
            heading(`“${query}”${project ? ` — ${project.name}` : ''}`);
            out(
              c.grey(
                `  ${result.embedderModel} · ${result.lexicalCount} lexical / ${result.vectorCount} vector candidates · best similarity ${result.bestVectorScore.toFixed(2)}`,
              ),
            );
            if (project?.summary) out(c.grey(`  project summary: ${truncate(project.summary, 140)}`));
            out('');
            if (result.hits.length === 0) {
              warn('nothing matched — try fewer words, or capture more activity first (`brain status`)');
              return;
            }
            result.hits.forEach((hit, index) => renderHit(hit, index));
            out('');
            if (result.weak) {
              warn(
                'no keyword match — these are semantic near-misses, not exact answers. Ask with words that appear in your notes (file names, command names, decisions).',
              );
            }
            if (project && !project.summary && !result.ownerTypes.project) {
              out(
                c.grey(
                  '  tip: this project has no stored overview — re-run `brain register` (or use `brain ui`) to index a profile you can ask about',
                ),
              );
            }
            out(c.grey(`  full text: brain timeline ${project ? `--project ${project.name} ` : ''}--json`));
          } finally {
            close();
          }
        },
      ),
    );
}
