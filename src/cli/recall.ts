import type { Command } from 'commander';
import { answerQuestion, detectEvidenceGap } from '../core/answer.js';
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

/** Word-wrap prose to the terminal width so paragraphs read like text, not one long line. */
function wrapParagraph(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim().length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (current.length === 0) current = word;
      else if (current.length + 1 + word.length <= width) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current.length > 0) lines.push(current);
  }
  return lines;
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
    // Parity with the UI panel: the same answer layer writes the prose here.
    // --no-answer keeps the old ranked-list-only behaviour for scripts.
    .option('--no-answer', 'skip the written answer, print ranked hits only')
    .option('--no-ai', 'build the answer deterministically, never ask the local model')
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
            answer: boolean;
            ai: boolean;
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
            const answer =
              options.answer && !gap
                ? await answerQuestion(db, config, {
                    query,
                    project,
                    hits: result.hits,
                    weak: result.weak,
                    useLlm: options.ai,
                  })
                : null;
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
                answer: answer
                  ? {
                      text: answer.text,
                      generator: answer.generator,
                      partial: answer.partial,
                      llm: answer.llm,
                    }
                  : null,
                hits: result.hits,
              });
              return;
            }
            if (gap) {
              warn(gap.reason);
              return;
            }
            if (answer) {
              heading(`“${query}”${project ? ` — ${project.name}` : ''}`);
              const width = Math.max(60, (process.stdout.columns ?? 100) - 2);
              for (const line of wrapParagraph(answer.text, width)) out(line);
              const how =
                answer.generator === 'local-model'
                  ? c.grey(`written by ${answer.llm.model}`)
                  : answer.generator === 'insufficient-evidence'
                    ? c.grey('not enough on record to answer this')
                    : c.grey('built from your records (deterministic)');
              out('');
              out(c.grey(`  ${how} · ${result.embedderModel} · ${result.lexicalCount} lexical / ${result.vectorCount} vector candidates`));
              out('');
              out(c.grey('  sources below — the passages the answer was built from:'));
              out('');
            } else {
              heading(`“${query}”${project ? ` — ${project.name}` : ''}`);
              out(
                c.grey(
                  `  ${result.embedderModel} · ${result.lexicalCount} lexical / ${result.vectorCount} vector candidates · best similarity ${result.bestVectorScore.toFixed(2)}`,
                ),
              );
              if (project?.summary) out(c.grey(`  project summary: ${truncate(project.summary, 140)}`));
              out('');
            }
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
