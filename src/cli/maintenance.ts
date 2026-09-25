import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { allAdapters, runAdapters } from '../adapters/index.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../config.js';
import { buildTimeline } from '../core/timeline.js';
import { indexProjectCommits, makeIndexer } from '../capture/ingest.js';
import { countEvents } from '../core/events.js';
import { buildProjectProfile } from '../summarize/profile.js';
import { setProjectMeta, getProject, listProjects } from '../core/projects.js';
import { rebuildIndex } from '../core/recall.js';
import { hasOllamaModel, listOllamaModels } from '../embeddings/embedder.js';
import { defaultShells, detectInvokingShell, shellHookFiles } from '../capture/shellHook.js';
import { openDatabase, wipeData } from '../db/index.js';
import { dbPath, configPath, brainHome } from '../util/paths.js';
import { action, createContext, getEmbedder } from './context.js';
import { bullet, c, heading, keyValue, ok, out, printJson, warn } from './output.js';
import { plural, truncate } from '../util/format.js';

export function registerMaintenanceCommands(program: Command): void {
  program
    .command('ingest-chat')
    .description('Import AI chat history from supported IDEs into the timeline')
    .option('--adapter <id>', 'only run this adapter')
    .option('--days <n>', 'only messages newer than N days', (v) => Number(v))
    .option('--limit <n>', 'max messages per adapter', (v) => Number(v), 5000)
    .option('--list', 'list available adapters')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { adapter?: string; days?: number; limit: number; list?: boolean; json?: boolean }) => {
        const { db, config, close } = createContext();
        try {
          if (options.list) {
            const adapters = allAdapters(db).map((adapter) => ({
              id: adapter.id,
              description: adapter.description,
              enabled: adapter.enabled(config),
              experimental: adapter.experimental ?? false,
            }));
            if (options.json) {
              printJson(adapters);
              return;
            }
            heading('Chat adapters');
            for (const adapter of adapters) {
              out(
                `  ${c.bold(adapter.id.padEnd(14))} ${adapter.enabled ? c.green('enabled ') : c.grey('disabled')} ${
                  adapter.experimental ? c.yellow('experimental ') : ''
                }${adapter.description}`,
              );
            }
            return;
          }
          const embedder = await getEmbedder(config);
          const index = makeIndexer(db, embedder);
          const reports = await runAdapters(db, index, config, {
            only: options.adapter,
            limit: options.limit,
            since: options.days ? Date.now() - options.days * 86_400_000 : undefined,
          });
          if (options.json) {
            printJson(reports);
            return;
          }
          for (const report of reports) {
            if (report.skipped) {
              out(`  ${c.grey(report.adapter.padEnd(14))} skipped ${c.grey(report.reason ?? '')}`);
            } else {
              out(
                `  ${c.bold(report.adapter.padEnd(14))} ${report.inserted} new of ${report.scanned} scanned`,
              );
            }
          }
        } finally {
          close();
        }
      }),
    );

  program
    .command('reindex')
    .description('Rebuild embeddings for everything already indexed (after a model change)')
    .option('--provider <provider>', 'auto|ollama|hash')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { provider?: 'auto' | 'ollama' | 'hash'; json?: boolean }) => {
        const { db, config, close } = createContext();
        try {
          const embedder = await getEmbedder(config, options.provider);
          const result = await rebuildIndex(db, embedder);
          if (options.json) {
            printJson({ ...result, embedder: embedder.model });
            return;
          }
          ok(`reindexed ${result.embedded}/${result.total} documents with ${embedder.model}`);
        } finally {
          close();
        }
      }),
    );

  program
    .command('config')
    .description('Show or update configuration (dot paths, e.g. brief.minIntervalMinutes)')
    .option('--set <kv...>', 'key=value pairs to set')
    .option('--path', 'print the config file path only')
    .option('--reset', 'restore defaults')
    .option('--json', 'machine-readable output')
    .action(
      action((options: { set?: string[]; path?: boolean; reset?: boolean; json?: boolean }) => {
        if (options.path) {
          out(configPath());
          return;
        }
        if (options.reset) {
          saveConfig(DEFAULT_CONFIG);
          ok(`config reset at ${configPath()}`);
          return;
        }
        const current = loadConfig();
        if (options.set && options.set.length > 0) {
          for (const pair of options.set) {
            const eq = pair.indexOf('=');
            if (eq < 0) throw new Error(`expected key=value, got "${pair}"`);
            const keyPath = pair.slice(0, eq).split('.').filter(Boolean);
            const rawValue = pair.slice(eq + 1);
            setPath(current as unknown as Record<string, unknown>, keyPath, coerce(rawValue));
          }
          saveConfig(current);
          ok(`updated ${configPath()}`);
        }
        if (options.json) printJson(current);
        else out(JSON.stringify(current, null, 2));
      }),
    );

  program
    .command('export')
    .description('Back up the database, or export the timeline as JSON')
    .option('-o, --out <file>', 'output file')
    .option('--format <format>', 'sqlite | json', 'sqlite')
    .action(
      action((options: { out?: string; format: string }) => {
        const { db, close } = createContext();
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          if (options.format === 'json') {
            const target = options.out ?? path.join(brainHome(), `export-${stamp}.json`);
            const payload = {
              exportedAt: Date.now(),
              projects: listProjects(db, true),
              timeline: buildTimeline(db, { limit: 100_000 }),
            };
            fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
            ok(`exported timeline to ${target}`);
            return;
          }
          if (options.format !== 'sqlite') throw new Error('format must be sqlite or json');
          const target = options.out ?? path.join(brainHome(), `backup-${stamp}.sqlite`);
          // Fold WAL into the main file before copying so the backup is complete.
          db.pragma('wal_checkpoint(TRUNCATE)');
          db.close();
          fs.copyFileSync(dbPath(), target);
          ok(`backed up database to ${target}`);
          return;
        } finally {
          try {
            close();
          } catch {
            // Already closed above for the sqlite path.
          }
        }
      }),
    );

  program
    .command('reset')
    .description('Delete captured data (keeps projects list unless --all)')
    .option('--all', 'also delete projects and config bookkeeping')
    .option('--yes', 'skip the confirmation prompt')
    .action(
      action(async (options: { all?: boolean; yes?: boolean }) => {
        if (!options.yes) {
          throw new Error('refusing to wipe data without --yes');
        }
        const { db, close } = createContext();
        try {
          wipeData(db);
          if (options.all) {
            db.prepare('DELETE FROM projects').run();
          }
          ok('captured data deleted');
        } finally {
          close();
        }
      }),
    );

  program
    .command('doctor')
    .description('Check the environment and report anything that would break capture')
    .option('--json', 'machine-readable output')
    .action(
      action(async (options: { json?: boolean }) => {
        const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
        const config = loadConfig();
        checks.push({
          name: 'node',
          ok: Number(process.versions.node.split('.')[0]) >= 20,
          detail: `v${process.versions.node}`,
        });
        const home = brainHome();
        checks.push({
          name: 'home',
          ok: fs.existsSync(home),
          detail: home,
        });
        const dbFile = dbPath();
        let dbOk = false;
        let dbDetail = dbFile;
        try {
          const db = openDatabase();
          // Count real projects only: the synthetic global:// bucket is not one.
          const n = listProjects(db).length;
          dbOk = true;
          dbDetail = `${dbFile} (${plural(n, 'project')})`;
          db.close();
        } catch (err) {
          dbDetail = String(err);
        }
        checks.push({ name: 'database', ok: dbOk, detail: dbDetail });
        const embedder = await getEmbedder(config);
        checks.push({
          name: 'embeddings',
          ok: true,
          detail:
            embedder.model.startsWith('ollama')
              ? `${embedder.model} (Ollama reachable)`
              : `${embedder.model} — Ollama unavailable, offline fallback in use`,
        });
        // The model has to actually be pulled, otherwise every brief silently
        // degrades to the deterministic summary.
        if (config.llm.provider === 'none') {
          checks.push({ name: 'llm', ok: true, detail: 'disabled (heuristic briefs only)' });
        } else {
          const models = await listOllamaModels(config.llm.ollamaUrl);
          const ready = Boolean(models && hasOllamaModel(models, config.llm.model));
          checks.push({
            name: 'llm',
            ok: ready,
            detail:
              models === null
                ? `${config.llm.model} — Ollama not reachable at ${config.llm.ollamaUrl}`
                : ready
                  ? `${config.llm.model} ready`
                  : `${config.llm.model} not installed — run: ollama pull ${config.llm.model}`,
          });
        }
        // Capture is worthless without a hook in the shell you actually type in.
        const invoking = await detectInvokingShell();
        const shells = await defaultShells();
        const hooked = shells.filter((shell) => shellHookFiles(shell).length > 0);
        checks.push({
          name: 'shell hook',
          ok: hooked.length > 0 && (!invoking || hooked.includes(invoking)),
          detail:
            hooked.length === 0
              ? `none installed — run: brain shell install (shells checked: ${shells.join(', ')})`
              : `${hooked.join(', ')}${invoking ? ` (this shell: ${invoking})` : ''}`,
        });
        const { readDaemonRecord } = await import('../capture/client.js');
        const record = readDaemonRecord();
        checks.push({
          name: 'daemon',
          ok: Boolean(record),
          detail: record ? `pid ${record.pid} on port ${record.port}` : 'not running',
        });
        const adapterContext = createContext();
        let adapters: ReturnType<typeof allAdapters> = [];
        try {
          adapters = allAdapters(adapterContext.db);
        } finally {
          adapterContext.close();
        }
        checks.push({
          name: 'adapters',
          ok: adapters.length > 0,
          detail: adapters.map((a) => a.id).join(', '),
        });
        checks.push({
          name: 'git',
          ok: await gitAvailable(),
          detail: 'git executable on PATH',
        });
        if (options.json) {
          printJson(checks);
          return;
        }
        heading('Second Brain doctor');
        for (const check of checks) {
          out(`  ${check.ok ? c.green('ok  ') : c.yellow('warn')} ${check.name.padEnd(11)} ${c.grey(check.detail)}`);
        }
        const failing = checks.filter((check) => !check.ok);
        if (failing.length > 0) {
          out('');
          warn(`${failing.length} check(s) need attention: ${failing.map((f) => f.name).join(', ')}`);
        }
      }),
    );

  program
    .command('info')
    .description('One-screen orientation: what this tool captures and where data lives')
    .action(() => {
      heading('Second Brain OS');
      out('  Local-first capture of commands, file touches, git history, decisions and IDE chat.');
      out('');
      keyValue('home', brainHome());
      keyValue('database', dbPath());
      keyValue('config', configPath());
      out('');
      heading('Common commands');
      bullet('brain ui                       local UI: pick a folder, register by clicking');
      bullet('brain register [path]          track a project + backfill git history');
      bullet('brain daemon start             background capture');
      bullet('brain timeline --days 7        what happened recently');
      bullet('brain ask "why sqlite?"        semantic recall');
      bullet('brain brief                    where you left off');
      bullet('brain related                  the same problem solved in another project');
      bullet('brain log "decided X because Y"  record a decision');
      bullet('brain refresh                  re-scan every project\'s overview');
      bullet('brain shell status             which shells actually capture commands');
      bullet('brain export                   back up the database');
    });

  program
    .command('refresh')
    .description('Re-scan registered projects and rebuild their stored overview documents')
    .argument('[project]', 'only this project (name, id or path)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (target: string | undefined, options: { json?: boolean }) => {
        const { db, config, close } = createContext();
        try {
          const embedder = await getEmbedder(config);
          const index = makeIndexer(db, embedder);
          const projects = target
            ? [getProject(db, target)].filter((project): project is NonNullable<typeof project> => project !== null)
            : listProjects(db);
          if (projects.length === 0) throw new Error(target ? `no project matching "${target}"` : 'no projects registered');

          const reports: Array<{ id: number; name: string; summary: string; stack: string[]; commitsIndexed: number }> =
            [];
          for (const project of projects) {
            const profile = await buildProjectProfile(db, project);
            setProjectMeta(db, project.id, {
              stack: profile.stack.length > 0 ? profile.stack.join(', ') : null,
              summary: profile.summary,
              git_remote: profile.isGitRepo ? profile.gitRemote : null,
            });
            await index([
              {
                ownerType: 'project',
                ownerId: project.id,
                projectId: project.id,
                ts: Date.now(),
                text: profile.doc,
              },
            ]);
            const commitsIndexed = await indexProjectCommits(db, index, project.id);
            reports.push({
              id: project.id,
              name: project.name,
              summary: profile.summary,
              stack: profile.stack,
              commitsIndexed,
            });
          }
          if (options.json) {
            printJson(reports);
            return;
          }
          for (const report of reports) {
            out(`  ${c.bold(report.name.padEnd(18))} ${plural(report.commitsIndexed, 'commit')} re-indexed`);
            out(`  ${' '.repeat(18)} ${truncate(report.summary, 140)}`);
            if (report.stack.length > 0) out(`  ${' '.repeat(18)} ${c.grey(report.stack.join(', '))}`);
          }
          ok(`refreshed ${plural(reports.length, 'project')}`);
          out(c.grey(`  events captured per project: ${projects.map((p) => countEvents(db, p.id)).join(', ')}`));
        } finally {
          close();
        }
      }),
    );
}

async function gitAvailable(): Promise<boolean> {
  try {
    const { git } = await import('../git/git.js');
    const res = await git(['--version'], process.cwd());
    return res.code === 0;
  } catch {
    return false;
  }
}

function coerce(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function setPath(target: Record<string, unknown>, parts: string[], value: unknown): void {
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    const next = cursor[key];
    if (typeof next !== 'object' || next === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}
