import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { DEFAULT_CONFIG, saveConfig } from '../config.js';
import { countBriefs } from '../core/briefs.js';
import { countCommits } from '../core/commits.js';
import { countDecisions } from '../core/decisions.js';
import { countEvents } from '../core/events.js';
import { listProjects, registerProject, removeProject, setProjectMeta, findProjectByPath } from '../core/projects.js';
import { indexProjectCommits, makeIndexer } from '../capture/ingest.js';
import { connect, request } from '../capture/client.js';
import { installPostCommitHook, hasPostCommitHook, gitRemote, isGitRepo, uninstallPostCommitHook } from '../git/git.js';
import { backfillHistory } from '../git/git.js';
import { detectStack } from '../summarize/stack.js';
import { configPath, dbPath, brainHome } from '../util/paths.js';
import { normalizePath } from '../util/paths.js';
import { relativeTime, shortPath } from '../util/format.js';
import { installShellHook, detectShell } from '../capture/shellHook.js';
import { action, createContext, getEmbedder } from './context.js';
import { bullet, c, heading, keyValue, ok, out, printJson } from './output.js';
export function registerProjectCommands(program: Command): void {
  program
    .command('init')
    .description('Create the Second Brain home, database, config and shell hook')
    .option('--no-shell', 'skip installing the shell hook')
    .option('--shell <shell>', 'shell to install the hook into (bash|zsh)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { shell?: string | boolean; json?: boolean }) => {
        const shellOpt = typeof options.shell === 'string' ? options.shell : undefined;
        const { config, close } = createContext();
        try {
          const home = brainHome();
          if (!fs.existsSync(configPath())) saveConfig(DEFAULT_CONFIG);
          const shell = detectShell(shellOpt);
          const install = options.shell === false ? null : installShellHook(shell);
          const payload = {
            home,
            database: dbPath(),
            config: configPath(),
            shell: install
              ? { shell: install.shell, rcFile: install.rcFile, installed: install.installed, alreadyPresent: install.alreadyPresent }
              : null,
            embeddingProvider: config.embedding.provider,
            llmProvider: config.llm.provider,
          };
          if (options.json) {
            printJson(payload);
            return;
          }
          ok(`Second Brain home ready at ${home}`);
          keyValue('database', dbPath());
          keyValue('config', configPath());
          if (install) {
            if (install.alreadyPresent) out(`  shell hook already present in ${install.rcFile}`);
            else out(`  shell hook installed in ${install.rcFile} ${c.grey('(open a new terminal to activate)')}`);
          }
          out('');
          heading('Next steps');
          bullet('brain register            # capture this project + backfill git history');
          bullet('brain daemon start        # background capture (commands, file touches, commits)');
          bullet('brain ask "how did I set up auth?"');
        } finally {
          close();
        }
      }),
    );

  program
    .command('register')
    .argument('[path]', 'project directory', process.cwd())
    .option('-n, --name <name>', 'friendly project name')
    .option('--limit <n>', 'cap the number of commits backfilled', (v) => Number(v))
    .option('--no-hook', 'do not install the post-commit git hook')
    .option('--json', 'machine-readable output')
    .description('Register a project: backfill git history and start capturing')
    .action(
      action(async (target: string, options: { name?: string; limit?: number; hook: boolean; json?: boolean }) => {
        const projectPath = normalizePath(target);
        if (!fs.existsSync(projectPath)) throw new Error(`path does not exist: ${projectPath}`);
        const { db, config, close } = createContext();
        try {
          const embedder = await getEmbedder(config);
          const index = makeIndexer(db, embedder);
          const { project, created } = registerProject(db, projectPath, { name: options.name });
          const stack = detectStack(projectPath);
          const remote = (await isGitRepo(projectPath)) ? await gitRemote(projectPath) : null;
          setProjectMeta(db, project.id, {
            stack: stack.length > 0 ? stack.join(', ') : null,
            git_remote: remote,
          });
          const backfill = await backfillHistory(db, project, { limit: options.limit });
          const indexed = await indexProjectCommits(db, index, project.id);
          let hook: { installed: boolean; path: string; chained?: boolean } | null = null;
          if (options.hook) hook = installPostCommitHook(projectPath);
          // Bring the daemon up (config default) and tell it to watch this project now
          // rather than waiting for its periodic re-sync.
          const daemon = await connect(config).catch(() => null);
          if (daemon) await request('syncWatch', undefined, { record: daemon }).catch(() => null);

          const payload = {
            id: project.id,
            name: project.name,
            path: project.path,
            created,
            stack,
            gitRemote: remote,
            commitsScanned: backfill.scanned,
            commitsInserted: backfill.inserted,
            commitsIndexed: indexed,
            hookInstalled: hook?.installed ?? false,
            hookPath: hook?.path ?? null,
          };
          if (options.json) {
            printJson(payload);
            return;
          }
          ok(`${created ? 'registered' : 'refreshed'} ${c.bold(project.name)} ${c.grey(`(id ${project.id})`)}`);
          keyValue('path', shortPath(project.path, 70));
          if (stack.length > 0) keyValue('stack', stack.join(', '));
          if (remote) keyValue('remote', remote);
          keyValue('commits', `${backfill.inserted} new, ${backfill.scanned} scanned, ${indexed} indexed for recall`);
          if (hook) {
            keyValue('post-commit', hook.installed ? `${hook.path}${hook.chained ? ' (chained)' : ''}` : 'not installed');
          }
        } finally {
          close();
        }
      }),
    );

  program
    .command('unregister')
    .argument('<project>', 'project name, id or path')
    .option('--keep-hook', 'leave the post-commit hook in place')
    .description('Stop tracking a project and delete its captured data')
    .action(
      action(async (target: string, options: { keepHook?: boolean }) => {
        const { db, close } = createContext();
        try {
          const project =
            findProjectByPath(db, target) ??
            (listProjects(db).find((p) => p.name === target || String(p.id) === target) ?? null);
          if (!project) throw new Error(`no project matching "${target}"`);
          if (!options.keepHook && fs.existsSync(path.join(project.path, '.git'))) {
            uninstallPostCommitHook(project.path);
          }
          removeProject(db, project.id);
          ok(`unregistered ${project.name} and removed its captured data`);
        } finally {
          close();
        }
      }),
    );

  program
    .command('projects')
    .description('List registered projects with capture stats')
    .option('--ignored', 'include projects marked ignored')
    .option('--json', 'machine-readable output')
    .action(
      action((options: { ignored?: boolean; json?: boolean }) => {
        const { db, close } = createContext();
        try {
          const projects = listProjects(db, options.ignored);
          const rows = projects.map((project) => ({
            id: project.id,
            name: project.name,
            path: project.path,
            stack: project.stack,
            lastSeenAt: project.last_seen_at,
            lastSeen: project.last_seen_at ? relativeTime(project.last_seen_at) : 'never',
            events: countEvents(db, project.id),
            commits: countCommits(db, project.id),
            decisions: countDecisions(db, project.id),
            briefs: countBriefs(db, project.id),
            hook: fs.existsSync(path.join(project.path, '.git')) ? hasPostCommitHook(project.path) : false,
          }));
          if (options.json) {
            printJson(rows);
            return;
          }
          if (rows.length === 0) {
            out('No projects registered. Run `brain register` in a project directory.');
            return;
          }
          heading(`${rows.length} project(s)`);
          for (const row of rows) {
            out(
              `  ${c.bold(row.name)} ${c.grey(`#${row.id}`)} ${c.grey(row.lastSeen)}\n    ${c.grey(
                shortPath(row.path, 72),
              )}\n    ${row.events} events · ${row.commits} commits · ${row.decisions} decisions · ${row.briefs} briefs${
                row.hook ? ` · ${c.green('hook')}` : ` · ${c.grey('no hook')}`
              }`,
            );
          }
        } finally {
          close();
        }
      }),
    );
}
