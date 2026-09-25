import type { Command } from 'commander';
import { parseDecisionText } from '../core/decisions.js';
import { listDecisions } from '../core/decisions.js';
import { makeIndexer, recordDecision } from '../capture/ingest.js';
import { suggestDecisionsFromCommits } from '../summarize/brief.js';
import { relativeTime, truncate } from '../util/format.js';
import { action, createContext, getEmbedder, requireProject, resolveSelectedProject } from './context.js';
import { bullet, c, heading, keyValue, ok, out, printJson, warn } from './output.js';

export function registerMemoryCommands(program: Command): void {
  program
    .command('log')
    .description('Record a decision: "decided X because Y, rejected Z"')
    .argument('<text...>', 'the decision text (#tags are extracted)')
    .option('-p, --project <project>', 'project name, id or path')
    .option('-g, --global', 'log against the cross-project bucket')
    .option('-t, --tags <tags>', 'comma-separated tags')
    .option('--cwd <dir>', 'resolve the project from this directory')
    .option('--at <iso>', 'timestamp from the decision text itself (ISO date)')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          words: string[],
          options: { project?: string; global?: boolean; tags?: string; cwd?: string; at?: string; json?: boolean },
        ) => {
          const text = words.join(' ').trim();
          if (text.length === 0) throw new Error('nothing to log');
          const { db, config, close } = createContext();
          try {
            const project = requireProject(db, options);
            const embedder = await getEmbedder(config);
            const index = makeIndexer(db, embedder);
            const ts = options.at ? Date.parse(options.at) : undefined;
            if (options.at && !Number.isFinite(ts as number)) throw new Error(`invalid --at timestamp: ${options.at}`);
            const parsed = parseDecisionText(text);
            const result = await recordDecision(db, index, {
              projectId: project.id,
              text,
              tags: options.tags?.split(',').map((t) => t.trim()).filter(Boolean),
              source: 'cli',
              ts,
            });
            if (options.json) {
              printJson({ ...result, project: project.name, tags: parsed.tags });
              return;
            }
            ok(`logged decision #${result.decisionId} for ${c.bold(project.name)}`);
            keyValue('text', truncate(parsed.text, 90));
            if (parsed.tags.length > 0) keyValue('tags', parsed.tags.join(', '));
          } finally {
            close();
          }
        },
      ),
    );

  program
    .command('decisions')
    .description('List logged decisions, or suggest new ones from commit history')
    .option('-p, --project <project>', 'project name, id or path')
    .option('-g, --global', 'only the cross-project bucket')
    .option('-l, --limit <n>', 'how many to show', (v) => Number(v), 20)
    .option('--suggest', 'suggest decision entries extracted from commit messages')
    .option('--save-suggestions', 'with --suggest: actually write the suggestions')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (options: {
          project?: string;
          global?: boolean;
          limit: number;
          suggest?: boolean;
          saveSuggestions?: boolean;
          json?: boolean;
        }) => {
          const { db, config, close } = createContext();
          try {
            const project = resolveSelectedProject(db, options);
            if (project && options.suggest) {
              const suggestions = suggestDecisionsFromCommits(db, project.id, options.limit);
              {
                if (options.json) {
                  printJson({ project: project.name, suggestions });
                  return;
                }
                heading(`Suggested decisions from commits in ${project.name}`);
                if (suggestions.length === 0) out('  none — commit messages rarely state a decision yet');
                else for (const suggestion of suggestions) bullet(suggestion);
                if (options.saveSuggestions && suggestions.length > 0) {
                  const embedder = await getEmbedder(config);
                  const index = makeIndexer(db, embedder);
                  for (const suggestion of suggestions) {
                    await recordDecision(db, index, {
                      projectId: project.id,
                      text: suggestion,
                      source: 'commit-suggestion',
                    });
                  }
                  ok(`saved ${suggestions.length} suggested decision(s)`);
                } else if (suggestions.length > 0) {
                  warn('re-run with --save-suggestions to store them');
                }
                return;
              }
            }
            const decisions = listDecisions(db, project?.id ?? null, options.limit);
            if (options.json) {
              printJson(decisions);
              return;
            }
            if (decisions.length === 0) {
              out('No decisions logged yet. Try: brain log "decided to use SQLite over Postgres for simplicity"');
              return;
            }
            heading(`${decisions.length} decision(s)`);
            for (const decision of decisions) {
              out(
                `  ${c.grey(relativeTime(decision.ts).padEnd(14))} ${decision.text}${
                  decision.tags ? ` ${c.cyan(`#${decision.tags.split(',').join(' #')}`)}` : ''
                }`,
              );
            }
            if (!options.suggest) {
              out('');
              out(c.grey('  tip: `brain decisions --suggest` mines commit messages for decisions'));
            }
          } finally {
            close();
          }
        },
      ),
    );
}
