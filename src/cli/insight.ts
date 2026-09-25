import type { Command } from 'commander';
import { countBriefs, latestBrief } from '../core/briefs.js';
import { countChatTurns } from '../core/chat.js';
import { countCommits } from '../core/commits.js';
import { countDecisions } from '../core/decisions.js';
import { countEvents, lastEventId } from '../core/events.js';
import { listProjects, resolveProjectForPath } from '../core/projects.js';
import { buildTimeline } from '../core/timeline.js';
import type { ProjectRow, TimelineKind } from '../core/types.js';
import { generateBrief, shouldAutoBrief } from '../summarize/brief.js';
import { readDaemonRecord, pingDaemon, request, watchedProjectIds } from '../capture/client.js';
import { countEmbeddings } from '../embeddings/store.js';
import { createEmbedder, hasOllamaModel, listOllamaModels } from '../embeddings/embedder.js';
import { detectInvokingShell, shellHookFiles, type SupportedShell } from '../capture/shellHook.js';
import { brainHome, configPath, dbPath } from '../util/paths.js';
import { formatDay, formatTimestamp, plural, relativeTime, shortPath, truncate } from '../util/format.js';
import { action, createContext, requireProject, resolveSelectedProject } from './context.js';
import { c, heading, keyValue, kindBadge, out, printJson, warn } from './output.js';

function renderTimelineDetail(detail: string): void {
  for (const line of detail.split('\n')) {
    const text = line.trim();
    if (text.length > 0) out(`            ${c.grey(truncate(text, 110))}`);
  }
}

export function registerInsightCommands(program: Command): void {
  program
    .command('brief')
    .description('"Here is where you left off" summary for a project')
    .option('-p, --project <project>', 'project name, id or path')
    .option('-g, --global', 'use the cross-project bucket')
    .option('--cwd <dir>', 'resolve the project from this directory')
    .option('--auto', 'quiet no-op unless the cwd is a registered project that is due a brief (used by the shell hook)')
    .option('--cached', 'print the last stored brief without regenerating')
    .option('--heuristic', 'skip the LLM and use the deterministic summary')
    .option('--max-events <n>', 'how many timeline entries to consider', (v) => Number(v), 200)
    .option('--days <n>', 'only consider activity from the last N days', (v) => Number(v))
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (options: {
          project?: string;
          global?: boolean;
          cwd?: string;
          auto?: boolean;
          cached?: boolean;
          heuristic?: boolean;
          maxEvents: number;
          days?: number;
          json?: boolean;
        }) => {
          const { db, config, close } = createContext();
          try {
            if (options.auto) {
              const project = resolveProjectForPath(db, options.cwd ?? process.cwd());
              if (!project) return;
              if (!config.brief.onCd) return;
              if (!shouldAutoBrief(db, project.id, config.brief.minIntervalMinutes)) return;
              const generated = await generateBrief(db, config, project, {
                maxEvents: config.brief.maxEvents,
                heuristicOnly: options.heuristic,
              });
              out('');
              out(generated.text);
              out('');
              return;
            }

            const project = requireProject(db, options);
            if (options.cached) {
              const brief = latestBrief(db, project.id);
              if (!brief) throw new Error(`no brief stored for ${project.name} yet`);
              if (options.json) {
                printJson(brief);
                return;
              }
              out(brief.summary_text);
              return;
            }
            const since = options.days ? Date.now() - options.days * 86_400_000 : undefined;
            const generated = await generateBrief(db, config, project, {
              maxEvents: options.maxEvents,
              heuristicOnly: options.heuristic,
              since,
            });
            if (options.json) {
              printJson({ ...generated, project: project.name });
              return;
            }
            out(generated.text);
            out(
              c.grey(
                `  — ${generated.generator}, watermark event ${generated.watermark}, generated ${relativeTime(
                  generated.createdAt,
                )}`,
              ),
            );
            if (!generated.llm.used && generated.llm.reason) {
              out(c.grey(`  LLM summary skipped: ${generated.llm.reason}`));
              out(c.grey('  richer prose needs a local model, e.g.: ollama pull llama3.2'));
            }
          } finally {
            close();
          }
        },
      ),
    );

  program
    .command('timeline')
    .description('Merged, timestamp-sorted timeline across every capture source')
    .option('-p, --project <project>', 'project name, id or path')
    .option('-g, --global', 'use the cross-project bucket')
    .option('-l, --limit <n>', 'max entries', (v) => Number(v), 40)
    .option('--days <n>', 'only the last N days', (v) => Number(v))
    .option('--kinds <kinds>', 'comma-separated: cmd,file,commit,chat,decision')
    .option('--asc', 'oldest first')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (options: {
          project?: string;
          global?: boolean;
          limit: number;
          days?: number;
          kinds?: string;
          asc?: boolean;
          json?: boolean;
        }) => {
          const { db, close } = createContext();
          try {
            const project = resolveSelectedProject(db, options);
            const since = options.days ? Date.now() - options.days * 86_400_000 : undefined;
            const kinds = options.kinds
              ? (options.kinds.split(',').map((k) => k.trim()) as TimelineKind[])
              : undefined;
            const entries = buildTimeline(db, {
              projectId: project?.id ?? null,
              limit: options.limit,
              since,
              kinds,
            });
            const ordered = options.asc ? [...entries].reverse() : entries;
            if (options.json) {
              printJson(ordered);
              return;
            }
            const names = new Map(listProjects(db, true).map((p) => [p.id, p.name]));
            const counts = new Map<string, number>();
            for (const entry of ordered) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
            heading(
              `${project ? project.name : 'All projects'}${options.days ? ` — last ${options.days} day(s)` : ''}`,
            );
            out(
              c.grey(
                `  ${plural(ordered.length, 'entry', 'entries')}${
                  project
                    ? ` · ${plural(countEvents(db, project.id), 'event')} captured · ${plural(
                        countCommits(db, project.id),
                        'commit',
                      )} · ${plural(countChatTurns(db, project.id), 'chat turn')}`
                    : ''
                }`,
              ),
            );
            if (ordered.length === 0) {
              out('');
              warn('nothing captured for this range — see `brain status` for capture problems');
              return;
            }
            let currentDay = '';
            for (const entry of ordered) {
              const day = formatDay(entry.ts);
              if (day !== currentDay) {
                currentDay = day;
                out('');
                heading(day);
              }
              const scope = project ? '' : c.grey(` ${entry.projectId ? names.get(entry.projectId) ?? '?' : 'global'}`);
              out(
                `  ${c.grey(formatTimestamp(entry.ts).slice(11, 16))} ${kindBadge(entry.kind)}${scope} ${truncate(
                  entry.text,
                  110,
                )}`,
              );
              if (entry.detail) renderTimelineDetail(entry.detail);
            }
            out('');
            out(
              c.grey(
                `  ${[...counts.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([kind, n]) => plural(n, kind))
                  .join(' · ')}`,
              ),
            );
            out('');
          } finally {
            close();
          }
        },
      ),
    );

  program
    .command('status')
    .description('Capture daemon, shell hooks, database and index status')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { json?: boolean }) => {
        const { db, config, close } = createContext();
        try {
          const record = readDaemonRecord();
          const running = record ? await pingDaemon(record) : false;
          const projects = listProjects(db);
          const embedder = await createEmbedder(config);
          const invoking = await detectInvokingShell();
          const hooks = (['bash', 'zsh', 'powershell'] as SupportedShell[]).map((shell) => ({
            shell,
            files: shellHookFiles(shell),
          }));
          const hooked = hooks.filter((entry) => entry.files.length > 0);

          let llmReady = false;
          let llmDetail = 'disabled (heuristic briefs only)';
          if (config.llm.provider !== 'none') {
            const models = await listOllamaModels(config.llm.ollamaUrl);
            llmReady = Boolean(models && hasOllamaModel(models, config.llm.model));
            llmDetail = models === null
              ? `${config.llm.model} — Ollama not reachable at ${config.llm.ollamaUrl}`
              : llmReady
                ? `${config.llm.model} ready`
                : `${config.llm.model} not installed — run: ollama pull ${config.llm.model}`;
          }

          let watched: number[] = [];
          if (record && running) {
            const status = await request<unknown>('status', undefined, { record }).catch(() => null);
            watched = watchedProjectIds(status?.result);
          }

          const totals = {
            events: countEvents(db),
            commits: projects.reduce((sum, project) => sum + countCommits(db, project.id), 0),
            decisions: countDecisions(db),
            chatTurns: countChatTurns(db),
            briefs: countBriefs(db),
            embeddings: countEmbeddings(db),
          };

          const problems: string[] = [];
          if (!running) problems.push('the daemon is not running — nothing is being captured in the background');
          if (hooked.length === 0) {
            problems.push('no shell hook installed — commands are not captured. Fix: brain shell install');
          } else if (invoking && !hooked.some((entry) => entry.shell === invoking)) {
            problems.push(`this shell (${invoking}) has no hook — commands typed here are not captured`);
          }
          if (!llmReady && config.llm.provider !== 'none') {
            problems.push(`the LLM summary is unavailable (${llmDetail}) — briefs stay deterministic`);
          }

          const payload = {
            home: brainHome(),
            database: dbPath(),
            configFile: configPath(),
            daemon: {
              running,
              pid: record?.pid ?? null,
              port: record?.port ?? null,
              startedAt: record?.startedAt ?? null,
              watched,
            },
            projects: projects.length,
            ...totals,
            lastEventId: lastEventId(db),
            embedder: embedder.model,
            llm: { provider: config.llm.provider, model: config.llm.model, ready: llmReady, detail: llmDetail },
            shells: { invoking, hooks },
            problems,
          };
          if (options.json) {
            printJson(payload);
            return;
          }

          heading('Second Brain status');
          keyValue('home', payload.home);
          keyValue(
            'database',
            `${payload.database} ${c.grey(`(${plural(payload.projects, 'project')})`)}`,
          );
          keyValue(
            'daemon',
            running
              ? `${c.green('running')} pid ${record?.pid} on 127.0.0.1:${record?.port} ${c.grey(
                  `(up ${record ? relativeTime(record.startedAt) : '?'}${watched.length > 0 ? `, watching ${watched.length}` : ''})`,
                )}`
              : c.yellow('not running') + c.grey('  — start with `brain daemon start`'),
          );
          keyValue('events', totals.events);
          keyValue('commits', totals.commits);
          keyValue('decisions', totals.decisions);
          keyValue('chat turns', totals.chatTurns);
          keyValue('briefs', totals.briefs);
          keyValue('embeddings', `${totals.embeddings} (${payload.embedder})`);
          keyValue('llm', llmReady ? c.green(llmDetail) : c.yellow(llmDetail));
          keyValue(
            'shell hooks',
            hooked.length > 0
              ? `${c.green(hooked.map((entry) => entry.shell).join(', '))}${invoking ? c.grey(` (this shell: ${invoking})`) : ''}`
              : c.yellow('none') + c.grey('  — fix with `brain shell install`'),
          );

          if (projects.length > 0) {
            out('');
            heading('Projects');
            for (const project of projects.slice(0, 10)) {
              printProjectLine(db, project, watched);
            }
          }

          if (problems.length > 0) {
            out('');
            heading('Needs attention');
            for (const problem of problems) warn(problem);
          }
        } finally {
          close();
        }
      }),
    );
}

function printProjectLine(db: ReturnType<typeof createContext>['db'], project: ProjectRow, watched: number[]): void {
  const bits: string[] = [];
  if (project.stack) bits.push(project.stack);
  bits.push(plural(countEvents(db, project.id), 'event'));
  bits.push(plural(countCommits(db, project.id), 'commit'));
  bits.push(plural(countDecisions(db, project.id), 'decision'));
  out(`  ${c.bold(project.name.padEnd(18))} ${c.grey(bits.join(' · '))}`);
  out(
    `  ${' '.repeat(18)} ${c.grey(shortPath(project.path, 66))} ${
      watched.includes(project.id) ? c.green('watched') : c.grey('not watched')
    } ${c.grey(`· last activity ${relativeTime(project.last_seen_at ?? project.created_at)}`)}`,
  );
}
