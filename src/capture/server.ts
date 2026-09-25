import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { BrainConfig } from '../config.js';
import { countBriefs } from '../core/briefs.js';
import { countChatTurns } from '../core/chat.js';
import { countDecisions } from '../core/decisions.js';
import { countEvents, lastEventId } from '../core/events.js';
import { listProjects } from '../core/projects.js';
import { openDatabase, type Db } from '../db/index.js';
import { createEmbedder, type Embedder } from '../embeddings/embedder.js';
import { countEmbeddings } from '../embeddings/store.js';
import { writeCliShim } from './shellHook.js';
import { daemonFile, logPath, pidPath, shellEnvFile } from '../util/paths.js';
import { log } from '../util/logger.js';
import {
  indexProjectCommits,
  makeIndexer,
  recordCommand,
  recordDecision,
  recordFileTouch,
  recordRepoCommits,
  type CommandInput,
  type Indexer,
} from './ingest.js';
import type {
  CapturePayload,
  DaemonRecord,
  DecisionPayload,
  LineMessage,
  RequestMessage,
  ResponseMessage,
} from './protocol.js';
import { parseLine, PROTOCOL_VERSION } from './protocol.js';
import { ProjectWatcher } from './watcher.js';

export interface ServerOptions {
  config: BrainConfig;
  /** Override for tests; defaults to the standard database path. */
  dbPath?: string;
}

export interface StatusSnapshot {
  pid: number;
  uptimeSeconds: number;
  projects: number;
  watched: number;
  events: number;
  commits: number;
  decisions: number;
  chatTurns: number;
  briefs: number;
  embeddings: number;
  lastEventId: number;
  embedder: string;
  dbPath: string;
}

export class CaptureServer {
  readonly token = crypto.randomBytes(24).toString('hex');
  private readonly startedAt = Date.now();
  private readonly db: Db;
  private embedder: Embedder | null = null;
  private index: Indexer;
  private watcher: ProjectWatcher;
  private server: net.Server | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private chatTimer: NodeJS.Timeout | null = null;
  private port = 0;

  constructor(private readonly options: ServerOptions) {
    this.db = openDatabase({ path: options.dbPath });
    this.index = makeIndexer(this.db, null);
    this.watcher = new ProjectWatcher(
      {
        ignore: options.config.watch.ignore,
        debounceMs: options.config.watch.debounceMs,
        maxEventsPerMinute: options.config.watch.maxEventsPerMinute,
      },
      (touch) => {
        recordFileTouch(this.db, {
          cwd: listProjects(this.db).find((p) => p.id === touch.projectId)?.path ?? process.cwd(),
          path: touch.path,
          action: touch.action,
          ts: touch.ts,
          source: 'watcher',
        });
      },
    );
  }

  private async ensureEmbedder(): Promise<Embedder | null> {
    if (this.embedder) return this.embedder;
    try {
      this.embedder = await createEmbedder(this.options.config);
      this.index = makeIndexer(this.db, this.embedder);
    } catch (err) {
      log.warn(`embedder unavailable: ${String(err)}`);
      this.embedder = null;
    }
    return this.embedder;
  }

  async start(): Promise<number> {
    writeCliShim();
    await this.ensureEmbedder();
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;

    const basePort = this.options.config.port;
    this.port = await this.listen(server, basePort);
    fs.writeFileSync(
      daemonFile(),
      JSON.stringify(
        {
          pid: process.pid,
          port: this.port,
          host: '127.0.0.1',
          token: this.token,
          startedAt: this.startedAt,
          version: `${PROTOCOL_VERSION}`,
        } satisfies DaemonRecord,
        null,
        2,
      ),
      'utf8',
    );
    fs.writeFileSync(pidPath(), String(process.pid), 'utf8');
    // Shell-sourceable credentials for the fast path (no JSON parsing in shell).
    fs.writeFileSync(
      shellEnvFile(),
      [
        `SECOND_BRAIN_PORT=${this.port}`,
        `SECOND_BRAIN_TOKEN=${this.token}`,
        `SECOND_BRAIN_PID=${process.pid}`,
        '',
      ].join('\n'),
      'utf8',
    );

    if (this.options.config.watch.enabled) {
      const { watching } = this.watcher.sync(listProjects(this.db));
      log.info(`watching ${watching.length} project(s)`);
      this.syncTimer = setInterval(() => {
        const { watching: now } = this.watcher.sync(listProjects(this.db));
        log.debug(`watch sync: ${now.length} project(s)`);
      }, 30_000);
      this.syncTimer.unref();
    }

    this.scheduleChatIngestion();

    log.info(`daemon listening on 127.0.0.1:${this.port}`);
    return this.port;
  }

  /**
   * IDE chat history is pulled, not pushed: scan the adapters periodically.
   * Insertions are deduplicated by source reference, so re-scanning is cheap
   * and only the first pass does real work.
   */
  private scheduleChatIngestion(): void {
    const enabled = this.options.config.adapters.claudeCode || this.options.config.adapters.vscodeChat;
    if (!enabled) return;
    const run = async (): Promise<void> => {
      try {
        const { runAdapters } = await import('../adapters/index.js');
        const reports = await runAdapters(this.db, this.index, this.options.config, { limit: 2000 });
        const inserted = reports.reduce((total, report) => total + report.inserted, 0);
        if (inserted > 0) log.info(`chat ingestion: ${inserted} new message(s)`);
      } catch (err) {
        log.debug(`chat ingestion failed: ${String(err)}`);
      }
    };
    void run();
    this.chatTimer = setInterval(() => void run(), 5 * 60_000);
    this.chatTimer.unref();
  }

  private listen(server: net.Server, preferredPort: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const tryPort = (port: number, attemptsLeft: number): void => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
            log.warn(`port ${port} busy, trying ${port + 1}`);
            setTimeout(() => tryPort(port + 1, attemptsLeft - 1), 5);
            return;
          }
          reject(err);
        });
        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      };
      tryPort(preferredPort, 20);
    });
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.chatTimer) clearInterval(this.chatTimer);
    await this.watcher.close();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    try {
      const record = JSON.parse(fs.readFileSync(daemonFile(), 'utf8')) as DaemonRecord;
      if (record.pid === process.pid) fs.rmSync(daemonFile(), { force: true });
      const pid = fs.existsSync(pidPath()) ? Number(fs.readFileSync(pidPath(), 'utf8')) : 0;
      if (pid === process.pid) {
        fs.rmSync(pidPath(), { force: true });
        fs.rmSync(shellEnvFile(), { force: true });
      }
    } catch {
      // Nothing to clean up.
    }
    this.db.close();
    log.info('daemon stopped');
  }

  private status(): StatusSnapshot {
    return {
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      projects: listProjects(this.db).length,
      watched: this.watcher.list().length,
      events: countEvents(this.db),
      commits: countProjectsCommits(this.db),
      decisions: countDecisions(this.db),
      chatTurns: countChatTurns(this.db),
      briefs: countBriefs(this.db),
      embeddings: countEmbeddings(this.db),
      lastEventId: lastEventId(this.db),
      embedder: this.embedder?.model ?? 'none',
      dbPath: this.options.dbPath ?? '',
    };
  }

  /** Handle the tab-delimited shell fast path. Never throws for bad input. */
  private async handleLine(message: LineMessage): Promise<string> {
    if (message.token !== this.token) return 'ERR unauthorized';
    switch (message.op) {
      case 'ping':
        return `OK ${PROTOCOL_VERSION}`;
      case 'cmd': {
        const [sessionId, exitCode, ts, cwd, cmd] = message.fields;
        if (!cwd || !cmd) return 'ERR missing cwd or cmd';
        await recordCommand(this.db, this.index, {
          cwd,
          cmd,
          exitCode: Number(exitCode ?? 0),
          ts: Number(ts) || Date.now(),
          source: process.env.SECOND_BRAIN_SHELL ?? 'shell',
          sessionId: sessionId ?? null,
        });
        return 'OK';
      }
      case 'file': {
        const [action, cwd, filePath] = message.fields;
        if (!cwd || !filePath) return 'ERR missing cwd or path';
        recordFileTouch(this.db, {
          cwd,
          path: filePath,
          action: action === 'create' || action === 'delete' ? action : 'change',
        });
        return 'OK';
      }
      case 'brief':
        return 'ERR use `brain brief`';
      default:
        return 'ERR unknown op';
    }
  }

  private async handleCapture(payload: CapturePayload): Promise<unknown> {
    switch (payload.type) {
      case 'cmd': {
        const input: CommandInput = {
          cwd: payload.cwd,
          cmd: payload.cmd ?? payload.text ?? '',
          exitCode: payload.exitCode ?? 0,
          ts: payload.ts,
          source: payload.source,
          sessionId: payload.sessionId ?? null,
        };
        return recordCommand(this.db, this.index, input);
      }
      case 'file':
        return recordFileTouch(this.db, {
          cwd: payload.cwd,
          path: payload.path ?? payload.text ?? '',
          action: payload.action ?? 'change',
          ts: payload.ts,
          source: payload.source,
        });
      case 'chat':
        return { skipped: true };
      default:
        return { skipped: true, reason: `unsupported capture type ${payload.type}` };
    }
  }

  private async handle(message: RequestMessage): Promise<unknown> {
    if (message.op !== 'ping' && message.token !== this.token) {
      throw new Error('unauthorized');
    }
    switch (message.op) {
      case 'ping':
        return { version: PROTOCOL_VERSION, pid: process.pid };
      case 'status':
        return this.status();
      case 'capture':
        return this.handleCapture(message.payload as CapturePayload);
      case 'captureBatch': {
        const batch = (message.payload as { items?: CapturePayload[] })?.items ?? [];
        const results = [];
        for (const item of batch) results.push(await this.handleCapture(item));
        return { count: results.length, results };
      }
      case 'decision':
        return recordDecision(this.db, this.index, message.payload as DecisionPayload);
      case 'syncWatch': {
        const result = this.watcher.sync(listProjects(this.db));
        return { watching: result.watching, stopped: result.stopped };
      }
      case 'brief':
        return { unsupported: true, hint: 'run `brain brief` locally' };
      case 'shutdown':
        setImmediate(() => void this.stop().then(() => process.exit(0)));
        return { stopping: true };
      default:
        throw new Error(`unknown op ${String(message.op)}`);
    }
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        const shellMessage = parseLine(line);
        if (shellMessage) {
          void this.handleLine(shellMessage)
            .then((result) => socket.write(`${result}\n`))
            .catch((err: unknown) => socket.write(`ERR ${String(err)}\n`));
          continue;
        }
        let message: RequestMessage;
        try {
          message = JSON.parse(line) as RequestMessage;
        } catch (err) {
          socket.write(`${JSON.stringify({ id: '?', ok: false, error: `bad json: ${String(err)}` })}\n`);
          continue;
        }
        void this.handle(message)
          .then((result) => {
            const response: ResponseMessage = { id: message.id, ok: true, result };
            socket.write(`${JSON.stringify(response)}\n`);
          })
          .catch((err: unknown) => {
            const response: ResponseMessage = { id: message.id, ok: false, error: String(err) };
            socket.write(`${JSON.stringify(response)}\n`);
          });
      }
    });
    socket.on('error', (err) => log.debug(`client socket error: ${String(err)}`));
  }

  /** Record repo commits and refresh watchers after a post-commit hook fires. */
  async ingestRepoCommits(repoPath: string): Promise<void> {
    const result = await recordRepoCommits(this.db, repoPath);
    if (result.project) {
      await indexProjectCommits(this.db, this.index, result.project.id, 50);
      this.watcher.sync(listProjects(this.db));
    }
  }

  get database(): Db {
    return this.db;
  }
}

function countProjectsCommits(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM commits').get() as { n: number };
  return row.n;
}

export function readDaemonRecord(): DaemonRecord | null {
  try {
    if (!fs.existsSync(daemonFile())) return null;
    return JSON.parse(fs.readFileSync(daemonFile(), 'utf8')) as DaemonRecord;
  } catch {
    return null;
  }
}

export function appendDaemonLog(line: string): void {
  try {
    fs.appendFileSync(logPath(), `${line}\n`);
  } catch {
    // Best effort only.
  }
}

export type { Db };
