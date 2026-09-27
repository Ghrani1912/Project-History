import type { Command } from 'commander';
import {
  detectContradictions,
  dismissContradiction,
  listContradictions,
  persistContradictions,
} from '../core/contradictions.js';
import { relativeTime, truncate } from '../util/format.js';
import { action, createContext, resolveSelectedProject } from './context.js';
import { c, heading, ok, out, printJson, warn } from './output.js';

export function registerContradictionCommands(program: Command): void {
  program
    .command('contradictions')
    .description('Decisions that conflict with each other (e.g. "SQLite here but Postgres there")')
    .option('-p, --project <project>', 'limit to a project')
    .option('-l, --limit <n>', 'how many to show', (v) => Number(v), 10)
    .option('--cached', 'show the last background scan instead of re-running it')
    .option('--dismiss <id>', 'mark a finding as resolved', (v) => Number(v))
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (options: { project?: string; limit: number; cached?: boolean; dismiss?: number; json?: boolean }) => {
          const { db, close } = createContext();
          try {
            const project = options.project ? resolveSelectedProject(db, options) : null;
            const projectId = project?.id ?? null;

            if (options.dismiss !== undefined) {
              const removed = dismissContradiction(db, options.dismiss);
              if (options.json) {
                printJson({ dismissed: options.dismiss, found: removed });
              } else if (removed) {
                ok(`dismissed contradiction #${options.dismiss}`);
              } else {
                warn(`no contradiction with id ${options.dismiss}`);
              }
              return;
            }

            if (!options.cached) {
              const found = detectContradictions(db, { projectId });
              const inserted = persistContradictions(db, found);
              if (!options.json && inserted > 0) ok(`scan found ${inserted} new contradiction(s)`);
            }

            const findings = listContradictions(db, projectId, options.limit);
            if (options.json) {
              printJson({ project: project?.name ?? null, contradictions: findings });
              return;
            }
            heading(`Contradicting decisions${project ? ` — ${project.name}` : ''}`);
            if (findings.length === 0) {
              out('  none detected — your logged decisions do not conflict yet');
              return;
            }
            for (const finding of findings) {
              out(
                `  ${c.grey(`#${finding.id}`)} ${c.magenta(finding.category)} ${c.grey(
                  `(score ${finding.score})`,
                )}`,
              );
              out(`    ${relativeTime(finding.a.ts)}  ${truncate(finding.a.text, 150)}`);
              out(`    ${relativeTime(finding.b.ts)}  ${truncate(finding.b.text, 150)}`);
              out(`    ${c.grey(finding.reason)}`);
              out('');
            }
            out(c.grey('  resolve one with: brain contradictions --dismiss <id>'));
          } finally {
            close();
          }
        },
      ),
    );
}
