import fs from 'node:fs';
import type { Command } from 'commander';
import { latestBrief } from '../core/briefs.js';
import { countChatTurns } from '../core/chat.js';
import { countDecisions } from '../core/decisions.js';
import { countEvents, lastEventId } from '../core/events.js';
import { listProjects, resolveProjectForPath } from '../core/projects.js';
import { buildTimeline } from '../core/timeline.js';
import type { TimelineKind } from '../core/types.js';
import { generateBrief, shouldAutoBrief } from '../summarize/brief.js';
import { readDaemonRecord, pingDaemon } from '../capture/client.js';
import { countEmbeddings } from '../embeddings/store.js';
import { countBriefs } from '../core/briefs.js';
import { createEmbedder } from '../embeddings/embedder.js';
import { brainHome, configPath, dbPath } from '../util/paths.js';
import { formatDay, formatTimestamp, plural, relativeTime, truncate } from '../util/format.js';
import { action, createContext, requireProject, resolveSelectedProject } from './context.js';
import { c, heading, keyValue, kindBadge, out, printJson, warn } from './output.js';

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
            out(c.grey(`  — ${generated.generator}, watermark event ${generated.watermark}`));
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
            if (ordered.length === 0) {
              out('Nothing captured yet. Try `brain register` then `brain daemon start`.');
              return;
            }
            const names = new Map(listProjects(db, true).map((p) => [p.id, p.name]));
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
              if (entry.detail) out(`            ${c.grey(truncate(entry.detail, 100))}`);
            }
            out('');
          } finally {
            close();
          }
        },
      ),
    );

  program
    .command('status')
    .description('Capture daemon, database and index status')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { json?: boolean }) => {
        const { db, config, close } = createContext();
        try {
          const record = readDaemonRecord();
          const running = record ? await pingDaemon(record) : false;
          const projects = listProjects(db);
          const embedder = await createEmbedder(config);
          const payload = {
            home: brainHome(),
            database: dbPath(),
            configFile: configPath(),
            daemon: {
              running,
              pid: record?.pid ?? null,
              port: record?.port ?? null,
              startedAt: record?.startedAt ?? null,
            },
            projects: projects.length,
            events: countEvents(db),
            decisions: countDecisions(db),
            chatTurns: countChatTurns(db),
            briefs: countBriefs(db),
            embeddings: countEmbeddings(db),
            embedder: embedder.model,
            lastEventId: lastEventId(db),
            llm: config.llm.provider === 'none' ? 'disabled' : `${config.llm.provider} (${config.llm.model})`,
            shellHook: fs.existsSync(configPath()),
          };
          if (options.json) {
            printJson(payload);
            return;
          }
          heading('Second Brain status');
          keyValue('home', payload.home);
          keyValue('database', payload.database);
          keyValue(
            'daemon',
            running
              ? `${c.green('running')} pid ${record?.pid} on 127.0.0.1:${record?.port} (up ${record ? relativeTime(record.startedAt) : '?'})`
              : c.yellow('not running') + c.grey('  — start with `brain daemon start`'),
          );
          keyValue('projects', projects.length);
          keyValue('events', countEvents(db));
          keyValue('decisions', payload.decisions);
          keyValue('chat turns', payload.chatTurns);
          keyValue('briefs', payload.briefs);
          keyValue('embeddings', `${payload.embeddings} (${payload.embedder})`);
          keyValue('llm', payload.llm);
          if (projects.length > 0) {
            out('');
            heading('Projects');
            for (const project of projects.slice(0, 10)) {
              out(
                `  ${c.bold(project.name.padEnd(20))} ${plural(countEvents(db, project.id), 'event')} · ${relativeTime(
                  project.last_seen_at ?? project.created_at,
                )}`,
              );
            }
          }
          if (!running) {
            out('');
            warn('the daemon is not running — shell commands, file touches and commits are not being captured');
          }
        } finally {
          close();
        }
      }),
    );
}
