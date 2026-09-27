import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { DEFAULT_CONFIG, saveConfig } from '../config.js';
import { countBriefs } from '../core/briefs.js';
import { countCommits } from '../core/commits.js';
import { countDecisions } from '../core/decisions.js';
import { countEvents } from '../core/events.js';
import { listProjects, removeProject, findProjectByPath } from '../core/projects.js';
import { makeIndexer, onboardProject, connectProjectFolder } from '../capture/ingest.js';
import { pingDaemon, readDaemonRecord, request, watchedProjectIds } from '../capture/client.js';
import { hasPostCommitHook, uninstallPostCommitHook } from '../git/git.js';
import { looksLikeGitUrl } from '../git/remote.js';
import { configPath, dbPath, brainHome, normalizePath } from '../util/paths.js';
import { plural, relativeTime, shortPath, truncate } from '../util/format.js';
import {
  defaultShells,
  detectInvokingShell,
  installShellHooks,
  shellHookFiles,
  SUPPORTED_SHELLS,
  type SupportedShell,
} from '../capture/shellHook.js';
import { action, createContext, getEmbedder } from './context.js';
import { bullet, c, heading, keyValue, ok, out, printJson, warn } from './output.js';

/** Which shells can currently capture commands, for honest reporting. */
async function captureHealth(): Promise<{ invoking: string | null; hooked: string[]; shells: string[] }> {
  const shells = await defaultShells();
  return {
    invoking: await detectInvokingShell(),
    hooked: shells.filter((shell) => shellHookFiles(shell).length > 0),
    shells,
  };
}

export function registerProjectCommands(program: Command): void {
  program
    .command('init')
    .description('Create the Second Brain home, database, config and shell hooks')
    .option('--no-shell', 'skip installing the shell hooks')
    .option('--shell <shell>', 'install for one shell only (bash|zsh|powershell)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { shell?: string | boolean; json?: boolean }) => {
        const shellOpt = typeof options.shell === 'string' ? options.shell : undefined;
        const { config, close } = createContext();
        try {
          const home = brainHome();
          if (!fs.existsSync(configPath())) saveConfig(DEFAULT_CONFIG);
          const invoking = await detectInvokingShell();
          const explicit = shellOpt
            ? SUPPORTED_SHELLS.find((s) => s === shellOpt || (shellOpt === 'pwsh' && s === 'powershell'))
            : undefined;
          if (shellOpt && !explicit) throw new Error(`unsupported shell "${shellOpt}" (bash, zsh or powershell)`);
          const shells: SupportedShell[] =
            options.shell === false ? [] : explicit ? [explicit] : await defaultShells();
          const installs = shells.length > 0 ? await installShellHooks(shells) : [];
          const payload = {
            home,
            database: dbPath(),
            config: configPath(),
            detectedShell: invoking,
            shells: installs.map((install) => ({
              shell: install.shell,
              rcFile: install.rcFile,
              installed: install.installed,
              alreadyPresent: install.alreadyPresent,
            })),
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
          if (invoking) keyValue('this shell', invoking);
          for (const install of installs) {
            if (install.alreadyPresent) out(`  ${c.grey('present')} ${install.shell.padEnd(11)} ${install.rcFile}`);
            else {
              ok(`installed ${c.bold(install.shell)} hook in ${install.rcFile}`);
            }
          }
          if (installs.some((install) => install.installed)) {
            out(
              c.grey(
                installs.some((install) => install.shell === 'powershell')
                  ? '  open a new terminal (or run: . $PROFILE) to start capturing commands'
                  : '  open a new terminal (or source your rc file) to start capturing commands',
              ),
            );
          }
          out('');
          heading('Next steps');
          bullet('brain ui                  open the local UI and register a folder by clicking');
          bullet('brain register [path]     capture a project + backfill git history');
          bullet('brain daemon start        background capture (commands, file touches, commits)');
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
    .description('Register a project: scan it, backfill git history and start capturing')
    .action(
      action(async (target: string, options: { name?: string; limit?: number; hook: boolean; json?: boolean }) => {
        // Git URLs skip the local-path checks entirely — they are cloned by
        // onboardProject into the brain home as recall-only sources.
        const isRemote = looksLikeGitUrl(target.trim());
        const projectPath = isRemote ? target.trim() : normalizePath(target);
        if (!isRemote && !fs.existsSync(projectPath)) throw new Error(`path does not exist: ${projectPath}`);
        const { db, config, close } = createContext();
        try {
          const embedder = await getEmbedder(config);
          const index = makeIndexer(db, embedder);
          const result = await onboardProject(db, index, projectPath, {
            name: options.name,
            limit: options.limit,
            installHook: options.hook,
            config,
          });
          const { project, profile } = result;
          const events = countEvents(db, project.id);
          const health = await captureHealth();
          const payload = {
            id: project.id,
            name: project.name,
            path: project.path,
            created: result.created,
            summary: profile.summary,
            stack: profile.stack,
            languages: profile.languages,
            gitRemote: profile.gitRemote,
            branch: profile.branch,
            layout: profile.topLevel,
            entryPoints: profile.entryPoints,
            testCommand: profile.testCommand,
            readme: profile.readmeFile,
            commitsScanned: result.commitsScanned,
            commitsInserted: result.commitsInserted,
            commitsIndexed: result.commitsIndexed,
            hookInstalled: result.hook?.installed ?? false,
            watched: result.watched,
            events,
            capturedShells: health.hooked,
            warnings: result.warnings,
          };
          if (options.json) {
            printJson(payload);
            return;
          }
          ok(`${result.created ? 'registered' : 'refreshed'} ${c.bold(project.name)} ${c.grey(`(id ${project.id})`)}`);
          keyValue('path', shortPath(project.path, 72));
          keyValue('summary', truncate(profile.summary, 150));
          if (profile.stack.length > 0) keyValue('stack', profile.stack.join(', '));
          if (profile.languages.length > 0) {
            keyValue(
              'languages',
              profile.languages.slice(0, 5).map((entry) => `${entry.language} (${entry.files})`).join(', '),
            );
          }
          if (profile.isGitRepo) {
            keyValue(
              'git',
              `${profile.gitRemote ?? 'no remote'} ${c.grey(`· ${profile.branch ?? '?'} · ${plural(profile.commits, 'commit')}`)}`,
            );
          }
          if (profile.topLevel.length > 0) {
            keyValue('layout', truncate(profile.topLevel.map((entry) => entry.name).join(' '), 140));
          }
          if (profile.entryPoints.length > 0) keyValue('entry points', profile.entryPoints.join(', '));
          if (profile.readmeFile) keyValue('readme', `${profile.readmeFile} ${c.grey('(indexed for recall)')}`);
          if (profile.testCommand) keyValue('tests', profile.testCommand);
          keyValue(
            'commits',
            `${result.commitsInserted} new, ${result.commitsScanned} scanned, ${result.commitsIndexed} indexed for recall`,
          );
          keyValue(
            'post-commit',
            result.hook ? (result.hook.installed ? `${result.hook.path}${result.hook.chained ? ' (chained)' : ''}` : 'not installed') : 'skipped',
          );
          keyValue('watching', result.watched ? c.green('yes — files are being tracked') : c.yellow('no — daemon not reachable'));
          keyValue('captured', `${plural(events, 'event')} so far ${c.grey(`(${embedder.model})`)}`);

          for (const message of result.warnings) warn(message);
          if (events === 0) {
            out('');
            heading('Why is the timeline empty?');
            out(
              `  Commands are captured by shell hooks. Installed: ${
                health.hooked.length > 0 ? c.green(health.hooked.join(', ')) : c.yellow('none')
              }`,
            );
            out(
              `  Your current shell is ${health.invoking ?? c.yellow('unknown')}. ${
                health.invoking && !health.hooked.includes(health.invoking)
                  ? c.yellow('It has no hook, so its commands are not captured.')
                  : 'Run `brain shell status` to confirm, then open a new terminal.'
              }`,
            );
          }
        } finally {
          close();
        }
      }),
    );

  program
    .command('connect')
    .argument('<project>', 'existing recall-only project (name, id or path)')
    .argument('<folder>', 'local working folder of the same repository')
    .description('Connect a local folder to a git-URL project: same record, now with capture')
    .option('--json', 'machine-readable output')
    .action(
      action(async (target: string, folder: string, options: { json?: boolean }) => {
        const { db, config, close } = createContext();
        try {
          const project =
            findProjectByPath(db, target) ??
            (listProjects(db).find((p) => p.name === target || String(p.id) === target) ?? null);
          if (!project) throw new Error(`no project matching "${target}"`);
          const embedder = await getEmbedder(config);
          const index = makeIndexer(db, embedder);
          const result = await connectProjectFolder(db, index, project.id, folder, { config });
          if (options.json) {
            printJson({
              id: result.project.id,
              name: result.project.name,
              path: result.project.path,
              commitsInserted: result.commitsInserted,
              commitsIndexed: result.commitsIndexed,
              watched: result.watched,
              warnings: result.warnings,
            });
            return;
          }
          ok(`connected ${c.bold(result.project.name)} to ${shortPath(result.project.path, 70)}`);
          keyValue('commits', `${result.commitsInserted} new from the folder, ${result.commitsIndexed} indexed`);
          keyValue('capture', result.watched ? 'watching — commands and errors now recorded' : c.yellow('daemon not watching — run brain daemon start'));
          for (const warning of result.warnings) out(`  ${c.yellow('warn')} ${warning}`);
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
          const record = readDaemonRecord();
          if (record && (await pingDaemon(record))) {
            await request('syncWatch', undefined, { record }).catch(() => null);
          }
          ok(`unregistered ${project.name} and removed its captured data`);
        } finally {
          close();
        }
      }),
    );

  program
    .command('projects')
    .description('List registered projects with what is stored about each one')
    .option('--ignored', 'include projects marked ignored')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (options: {
          ignored?: boolean;
          json?: boolean;
        }) => {
          const { db, close } = createContext();
          try {
            const projects = listProjects(db, options.ignored);
            const record = readDaemonRecord();
            let watched: number[] = [];
            if (record && (await pingDaemon(record))) {
              const status = await request<unknown>('status', undefined, { record }).catch(() => null);
              watched = watchedProjectIds(status?.result);
            }
            const rows = projects.map((project) => ({
              id: project.id,
              name: project.name,
              path: project.path,
              summary: project.summary,
              stack: project.stack,
              gitRemote: project.git_remote,
              lastSeenAt: project.last_seen_at,
              lastSeen: project.last_seen_at ? relativeTime(project.last_seen_at) : 'never',
              events: countEvents(db, project.id),
              commits: countCommits(db, project.id),
              decisions: countDecisions(db, project.id),
              chatTurns: 0,
              briefs: countBriefs(db, project.id),
              hook: fs.existsSync(path.join(project.path, '.git')) ? hasPostCommitHook(project.path) : false,
              watched: watched.includes(project.id),
            }));
            if (options.json) {
              printJson(rows);
              return;
            }
            if (rows.length === 0) {
              out('No projects registered. Run `brain ui` or `brain register <folder>`.');
              return;
            }
            heading(`${plural(rows.length, 'project')}`);
            for (const row of rows) {
              out('');
              out(`  ${c.bold(row.name)} ${c.grey(`#${row.id}`)} ${c.grey(`· last activity ${row.lastSeen}`)}`);
              out(`    ${c.grey('path     ')} ${shortPath(row.path, 70)}`);
              if (row.summary) out(`    ${c.grey('summary  ')} ${truncate(row.summary, 150)}`);
              if (row.stack) out(`    ${c.grey('stack    ')} ${row.stack}`);
              if (row.gitRemote) out(`    ${c.grey('remote   ')} ${row.gitRemote}`);
              out(
                `    ${c.grey('captured ')} ${row.events} events · ${row.commits} commits · ${row.decisions} decisions · ${row.briefs} briefs`,
              );
              out(
                `    ${c.grey('status   ')} ${row.watched ? c.green('watched') : c.grey('not watched')} · ${
                  row.hook ? c.green('commit hook') : c.grey('no commit hook')
                }`,
              );
            }
            out('');
          } finally {
            close();
          }
        },
      ),
    );
}
