import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { BrainConfig } from '../config.js';
import { countBriefs } from '../core/briefs.js';
import { countChatTurns } from '../core/chat.js';
import { countCommits } from '../core/commits.js';
import { countDecisions } from '../core/decisions.js';
import { countEvents } from '../core/events.js';
import { indexProjectCommits, makeIndexer, onboardProject } from '../capture/ingest.js';
import { listProjects, getProject, removeProject, resolveProjectForPath } from '../core/projects.js';
import { ask } from '../core/recall.js';
import { buildTimeline } from '../core/timeline.js';
import type { ProjectRow } from '../core/types.js';
import {
  connect,
  pingDaemon,
  readDaemonRecord,
  request,
  startDaemonDetached,
  watchedProjectIds,
} from '../capture/client.js';
import { countEmbeddings } from '../embeddings/store.js';
import { createEmbedder, hasOllamaModel, listOllamaModels, type Embedder } from '../embeddings/embedder.js';
import { hasPostCommitHook, gitRemote, isGitRepo, uninstallPostCommitHook } from '../git/git.js';
import { buildProjectProfile } from '../summarize/profile.js';
import { generateBrief } from '../summarize/brief.js';
import {
  defaultShells,
  detectInvokingShell,
  installShellHooks,
  shellHookFiles,
  type SupportedShell,
} from '../capture/shellHook.js';
import { log } from '../util/logger.js';
import { openDatabase, type Db } from '../db/index.js';
import { brainHome, configPath, dbPath, normalizePath } from '../util/paths.js';
import { renderPage } from './page.js';

const BROWSE_HIDDEN = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'target',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.tox',
]);

export interface UiServerOptions {
  config: BrainConfig;
  port?: number;
  host?: string;
}

export interface UiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * A tiny loopback-only web app: pick a folder, register it, then read the
 * timeline, brief and recall results without touching the CLI. All mutations
 * require a per-run token so a random web page cannot POST to localhost.
 */
export class BrainUiServer {
  private readonly db: Db;
  private readonly token = crypto.randomBytes(18).toString('hex');
  private embedder: Embedder | null = null;
  private server: http.Server | null = null;
  private port = 0;

  constructor(private readonly options: UiServerOptions) {
    this.db = openDatabase();
  }

  async start(): Promise<UiServer> {
    const server = http.createServer((req, res) => {
      void this.route(req, res).catch((err: unknown) => {
        this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });
    this.server = server;
    const preferred = this.options.port ?? 47700;
    const host = this.options.host ?? '127.0.0.1';
    this.port = await this.listen(server, preferred, host);
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${this.port}/`;
    log.info(`ui listening on ${url}`);
    return {
      url,
      port: this.port,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        this.db.close();
      },
    };
  }

  /** Stop listening and release the database handle. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.db.close();
  }

  private listen(server: http.Server, preferred: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryPort = (port: number, attemptsLeft: number): void => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
            setTimeout(() => tryPort(port + 1, attemptsLeft - 1), 5);
            return;
          }
          reject(err);
        });
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      };
      tryPort(preferred, 20);
    });
  }

  private async embedderOrDefault(): Promise<Embedder> {
    if (!this.embedder) this.embedder = await createEmbedder(this.options.config);
    return this.embedder;
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(payload);
  }

  private async readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.trim().length === 0) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new Error('invalid JSON body');
    }
  }

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers['x-brain-token'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    return fromHeader === this.token || url.searchParams.get('token') === this.token;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const route = `${req.method ?? 'GET'} ${url.pathname}`;

    if (route === 'GET /') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderPage(this.token));
      return;
    }
    if (route === 'GET /favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      this.sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!this.authorized(req, url)) {
      this.sendJson(res, 403, { error: 'missing or invalid token — reopen the UI from the printed URL' });
      return;
    }

    switch (route) {
      case 'GET /api/state':
        this.sendJson(res, 200, await this.state());
        return;
      case 'GET /api/browse':
        this.sendJson(res, 200, this.browse(url.searchParams.get('path') ?? ''));
        return;
      case 'GET /api/timeline':
        this.sendJson(res, 200, await this.timeline(url));
        return;
      case 'GET /api/brief':
        this.sendJson(res, 200, await this.brief(url));
        return;
      case 'GET /api/ask':
        this.sendJson(res, 200, await this.ask(url));
        return;
      case 'POST /api/register':
        this.sendJson(res, 200, await this.register(await this.readBody(req)));
        return;
      case 'POST /api/refresh':
        this.sendJson(res, 200, await this.refresh(await this.readBody(req)));
        return;
      case 'POST /api/unregister':
        this.sendJson(res, 200, await this.unregister(await this.readBody(req)));
        return;
      case 'POST /api/daemon':
        this.sendJson(res, 200, await this.daemon(await this.readBody(req)));
        return;
      case 'POST /api/shell/install':
        this.sendJson(res, 200, await this.installHooks());
        return;
      default:
        this.sendJson(res, 404, { error: `no such endpoint: ${route}` });
    }
  }

  /** Everything the dashboard needs in one call. */
  private async state(): Promise<Record<string, unknown>> {
    const record = readDaemonRecord();
    const daemonRunning = record ? await pingDaemon(record) : false;
    let watched: number[] = [];
    if (record && daemonRunning) {
      const status = await request<unknown>('status', undefined, { record }).catch(() => null);
      watched = watchedProjectIds(status?.result);
    }
    const projects = listProjects(this.db);
    const shells = await defaultShells();
    const invoking = await detectInvokingShell();
    const hooks = (['bash', 'zsh', 'powershell'] as SupportedShell[]).map((shell) => ({
      shell,
      installed: shellHookFiles(shell).length > 0,
      files: shellHookFiles(shell),
    }));
    const models = await listOllamaModels(this.options.config.llm.ollamaUrl);
    const llmReady = Boolean(models && hasOllamaModel(models, this.options.config.llm.model));
    const embedder = await this.embedderOrDefault();

    const warnings: string[] = [];
    if (!daemonRunning) warnings.push('The capture daemon is not running — nothing is recorded in the background. Click "Start daemon".');
    if (hooks.every((entry) => !entry.installed)) {
      warnings.push('No shell hook is installed, so commands you type are not captured. Click "Install shell hooks".');
    } else if (invoking && !hooks.some((entry) => entry.shell === invoking && entry.installed)) {
      warnings.push(`Your ${invoking} shell has no hook — commands typed there are not captured.`);
    }
    if (!llmReady && this.options.config.llm.provider !== 'none') {
      warnings.push(
        `The LLM summary needs ${this.options.config.llm.model} in Ollama (run: ollama pull ${this.options.config.llm.model}). Briefs stay deterministic until then.`,
      );
    }

    return {
      home: brainHome(),
      database: dbPath(),
      configFile: configPath(),
      daemon: {
        running: daemonRunning,
        pid: record?.pid ?? null,
        port: record?.port ?? null,
        startedAt: record?.startedAt ?? null,
        watched,
      },
      shells: { invoking, hooks, expected: shells },
      llm: { provider: this.options.config.llm.provider, model: this.options.config.llm.model, ready: llmReady },
      embedder: embedder.model,
      totals: {
        projects: projects.length,
        events: countEvents(this.db),
        commits: projects.reduce((sum, project) => sum + countCommits(this.db, project.id), 0),
        decisions: countDecisions(this.db),
        chatTurns: countChatTurns(this.db),
        briefs: countBriefs(this.db),
        embeddings: countEmbeddings(this.db),
      },
      warnings,
      projects: projects.map((project) => this.projectSummary(project, watched)),
    };
  }

  private projectSummary(project: ProjectRow, watched: number[]): Record<string, unknown> {
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      summary: project.summary,
      stack: project.stack,
      gitRemote: project.git_remote,
      lastSeenAt: project.last_seen_at,
      createdAt: project.created_at,
      events: countEvents(this.db, project.id),
      commits: countCommits(this.db, project.id),
      decisions: countDecisions(this.db, project.id),
      briefs: countBriefs(this.db, project.id),
      watched: watched.includes(project.id),
      hook: fs.existsSync(path.join(project.path, '.git')) ? hasPostCommitHook(project.path) : false,
      exists: fs.existsSync(project.path),
    };
  }

  /** Directory browser so the folder picker works without OS dialogs. */
  private browse(rawPath: string): Record<string, unknown> {
    const target = rawPath.trim().length > 0 ? normalizePath(rawPath) : os.homedir().replace(/\\/g, '/');
    if (target === '' || !fs.existsSync(target)) {
      // Windows drive roots, or the home directory as a starting point.
      const roots: Array<{ name: string; path: string }> = [];
      if (process.platform === 'win32') {
        for (let code = 65; code <= 90; code++) {
          const drive = `${String.fromCharCode(code)}:/`;
          if (fs.existsSync(drive)) roots.push({ name: drive, path: drive });
        }
      }
      if (roots.length === 0) roots.push({ name: os.homedir(), path: os.homedir().replace(/\\/g, '/') });
      return {
        path: null,
        parent: null,
        roots,
        entries: [],
      };
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (err) {
      return { path: target, parent: path.dirname(target).replace(/\\/g, '/'), roots: [], entries: [], error: String(err) };
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      // VCS and dependency folders are never what you want to register, and they
      // bury the real candidates in a fresh clone. A path can still be typed.
      .filter((entry) => !BROWSE_HIDDEN.has(entry.name))
      .map((entry) => {
        const full = path.join(target, entry.name).replace(/\\/g, '/');
        return {
          name: entry.name,
          path: full,
          isGit: fs.existsSync(path.join(full, '.git')),
          registered: resolveProjectForPath(this.db, full) !== null,
        };
      })
      .sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name));
    const parent = path.dirname(target).replace(/\\/g, '/');
    return {
      path: target,
      parent: parent === target ? null : parent,
      roots: [],
      entries: dirs,
      hasPackageJson: fs.existsSync(path.join(target, 'package.json')),
      isGit: fs.existsSync(path.join(target, '.git')),
    };
  }

  private async register(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = String(body.path ?? '').trim();
    if (raw.length === 0) throw new Error('a folder path is required');
    const target = normalizePath(raw);
    if (!fs.existsSync(target)) throw new Error(`path does not exist: ${target}`);
    if (!fs.statSync(target).isDirectory()) throw new Error(`not a folder: ${target}`);

    const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : undefined;
    const limit = typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined;
    const embedder = await this.embedderOrDefault();
    const result = await onboardProject(this.db, makeIndexer(this.db, embedder), target, {
      name,
      limit,
      installHook: true,
      config: this.options.config,
    });
    return {
      project: {
        id: result.project.id,
        name: result.project.name,
        path: result.project.path,
        summary: result.profile.summary,
        stack: result.profile.stack.join(', '),
      },
      created: result.created,
      profile: {
        summary: result.profile.summary,
        stack: result.profile.stack,
        languages: result.profile.languages,
        remote: result.profile.gitRemote,
        branch: result.profile.branch,
        isGitRepo: result.profile.isGitRepo,
        topLevel: result.profile.topLevel.map((entry) => entry.name),
        entryPoints: result.profile.entryPoints,
        readme: result.profile.readmeFile,
        testCommand: result.profile.testCommand,
        commits: result.profile.commits,
      },
      commitsScanned: result.commitsScanned,
      commitsInserted: result.commitsInserted,
      commitsIndexed: result.commitsIndexed,
      hook: result.hook ? { installed: result.hook.installed, path: result.hook.path } : null,
      watched: result.watched,
      warnings: result.warnings,
    };
  }

  /** Re-scan a project (or all of them) so stored metadata matches the disk. */
  private async refresh(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = Number(body.project);
    const projects = Number.isFinite(id) && id > 0 ? [getProject(this.db, id)].filter(Boolean) : listProjects(this.db);
    const embedder = await this.embedderOrDefault();
    const index = makeIndexer(this.db, embedder);
    const reports: Array<{ id: number; name: string; summary: string }> = [];
    for (const project of projects as ProjectRow[]) {
      const { setProjectMeta } = await import('../core/projects.js');
      const profile = await buildProjectProfile(this.db, project);
      setProjectMeta(this.db, project.id, {
        stack: profile.stack.length > 0 ? profile.stack.join(', ') : null,
        summary: profile.summary,
        git_remote: profile.isGitRepo ? profile.gitRemote : null,
      });
      await index([
        { ownerType: 'project', ownerId: project.id, projectId: project.id, ts: Date.now(), text: profile.doc },
      ]);
      await indexProjectCommits(this.db, index, project.id);
      reports.push({ id: project.id, name: project.name, summary: profile.summary });
    }
    return { refreshed: reports };
  }

  private async unregister(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = String(body.project ?? '');
    const project = getProject(this.db, target) ?? listProjects(this.db).find((p) => String(p.id) === target) ?? null;
    if (!project) throw new Error(`no project matching "${target}"`);
    if (body.keepHook !== true && fs.existsSync(path.join(project.path, '.git'))) {
      uninstallPostCommitHook(project.path);
    }
    removeProject(this.db, project.id);
    const record = readDaemonRecord();
    if (record && (await pingDaemon(record))) {
      await request('syncWatch', undefined, { record }).catch(() => null);
    }
    return { removed: project.name };
  }

  private async daemon(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = String(body.action ?? '');
    if (action === 'start') {
      const record = await connect(this.options.config).catch(() => null);
      if (!record) {
        startDaemonDetached();
        return { started: false, message: 'starting…' };
      }
      await request('syncWatch', undefined, { record }).catch(() => null);
      return { started: true, port: record.port, pid: record.pid };
    }
    if (action === 'stop') {
      const record = readDaemonRecord();
      if (!record) return { stopped: false };
      await request('shutdown', undefined, { record, timeoutMs: 3000 }).catch(() => {
        try {
          process.kill(record.pid);
        } catch {
          // already gone
        }
      });
      return { stopped: true, pid: record.pid };
    }
    throw new Error('action must be start or stop');
  }

  private async installHooks(): Promise<Record<string, unknown>> {
    const shells = await defaultShells();
    const results = await installShellHooks(shells);
    return { shells: results.map((r) => ({ shell: r.shell, rcFile: r.rcFile, installed: r.installed })) };
  }

  private async timeline(url: URL): Promise<Record<string, unknown>> {
    const projectParam = url.searchParams.get('project');
    const project = projectParam ? getProject(this.db, projectParam) : null;
    const days = Number(url.searchParams.get('days') ?? 7) || 7;
    const limit = Number(url.searchParams.get('limit') ?? 60) || 60;
    const entries = buildTimeline(this.db, {
      projectId: project?.id ?? null,
      limit,
      since: Date.now() - days * 86_400_000,
    });
    const names = new Map(listProjects(this.db, true).map((p) => [p.id, p.name]));
    return {
      project: project?.name ?? null,
      entries: entries.map((entry) => ({
        kind: entry.kind,
        ts: entry.ts,
        text: entry.text,
        detail: entry.detail,
        project: entry.projectId ? names.get(entry.projectId) ?? '?' : 'global',
      })),
    };
  }

  private async brief(url: URL): Promise<Record<string, unknown>> {
    const project = getProject(this.db, url.searchParams.get('project') ?? '');
    if (!project) throw new Error('unknown project');
    const useAi = url.searchParams.get('ai') === '1';
    const generated = await generateBrief(this.db, this.options.config, project, { heuristicOnly: !useAi });
    return {
      project: project.name,
      text: generated.text,
      generator: generated.generator,
      llm: generated.llm,
      createdAt: generated.createdAt,
    };
  }

  private async ask(url: URL): Promise<Record<string, unknown>> {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (query.length === 0) throw new Error('empty query');
    const projectParam = url.searchParams.get('project');
    const project = projectParam ? getProject(this.db, projectParam) : null;
    const embedder = await this.embedderOrDefault();
    const result = await ask(this.db, embedder, query, {
      projectId: project?.id ?? null,
      limit: Number(url.searchParams.get('limit') ?? 8) || 8,
    });
    return {
      query,
      project: project?.name ?? null,
      embedder: result.embedderModel,
      lexicalCount: result.lexicalCount,
      vectorCount: result.vectorCount,
      bestVectorScore: result.bestVectorScore,
      weak: result.weak,
      hits: result.hits.map((hit) => ({
        ownerType: hit.ownerType,
        projectName: hit.projectName,
        ts: hit.ts,
        text: hit.text,
        via: hit.via,
      })),
    };
  }
}

/** Open the UI in the user's browser, best effort, without blocking. */
export function openBrowser(url: string): boolean {
  const commands: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [['cmd', ['/c', 'start', '', url]]]
      : process.platform === 'darwin'
        ? [['open', [url]]]
        : [['xdg-open', [url]]];
  for (const [command, args] of commands) {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return true;
    } catch (err) {
      log.debug(`could not open a browser: ${String(err)}`);
    }
  }
  return false;
}

/** Repo/stack helpers re-used by the CLI so `brain ui` can report git status. */
export async function describeFolder(folder: string): Promise<{ isGitRepo: boolean; remote: string | null }> {
  const repo = await isGitRepo(folder);
  return { isGitRepo: repo, remote: repo ? await gitRemote(folder) : null };
}
