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
import { claimDaemonRecord } from './daemonGuard.js';
import { isProcessAlive, pingPort } from './client.js';
import { brainHome, daemonFile, logPath, pidPath, shellEnvFile } from '../util/paths.js';
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
  /** Project ids the watcher is currently following. */
  watched: number[];
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
  private driftTimer: NodeJS.Timeout | null = null;
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
    const record: DaemonRecord = {
      pid: process.pid,
      port: this.port,
      host: '127.0.0.1',
      token: this.token,
      startedAt: this.startedAt,
      version: `${PROTOCOL_VERSION}`,
    };
    // One daemon per home. Publishing the record exclusively is what makes that
    // true: without it a second daemon would bind the next free port, overwrite
    // this record and leave the first one running and unreachable.
    if (!claimDaemonRecord(record)) {
      const holder = readDaemonRecord();
      // Refuse only when the record can be *positively identified* as live: the
      // port answers, and the pid answering is the pid the record names.
      //
      // Both weaker checks are wrong. A plain ping answers the record holder's
      // own port, so after a crash — when that port is free and this process has
      // just re-bound it — the ping comes back from ourselves and a dead record
      // looks alive (the restart then dies reporting the dead pid as "started").
      // Liveness alone is wrong too: a crashed daemon's pid can be reused by an
      // unrelated process, which would make a stale record refuse forever.
      const reply = holder ? await pingPort(holder.port) : null;
      if (holder && reply && reply.pid === holder.pid && isProcessAlive(holder.pid)) {
        await this.abandonStart();
        throw new Error(
          `another daemon is already serving this brain home (pid ${holder.pid}, port ${holder.port})`,
        );
      }
      // The claim is stale — nothing identified itself as its holder — so take it over.
      fs.rmSync(daemonFile(), { force: true });
      if (!claimDaemonRecord(record)) {
        await this.abandonStart();
        throw new Error('could not claim the daemon record');
      }
    }
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
    this.scheduleContradictionScan();

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

  /**
   * The contradiction detector runs in the background: decisions drift apart
   * slowly, so a periodic scan is what catches "I said SQLite here but Postgres
   * there" months later without anyone remembering to look.
   */
  private scheduleContradictionScan(): void {
    if (!this.options.config.contradictions.enabled) return;
    const intervalMs = Math.max(1, this.options.config.contradictions.intervalMinutes) * 60_000;
    const run = async (): Promise<void> => {
      try {
        const { detectContradictions, persistContradictions } = await import('../core/contradictions.js');
        const found = detectContradictions(this.db, {});
        const inserted = persistContradictions(this.db, found);
        if (inserted > 0) log.info(`contradiction scan: ${inserted} new conflict(s)`);
      } catch (err) {
        log.debug(`contradiction scan failed: ${String(err)}`);
      }
    };
    void run();
    this.driftTimer = setInterval(() => void run(), intervalMs);
    this.driftTimer.unref();
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

  /**
   * Release the socket and the database after a refused start. The record is
   * deliberately left alone: it belongs to the daemon that is already serving
   * this home.
   */
  private async abandonStart(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.chatTimer) clearInterval(this.chatTimer);
    if (this.driftTimer) clearInterval(this.driftTimer);
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
      watched: this.watcher.list(),
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
          output: payload.output ?? null,
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
        // The home is reported so a daemon found by the port sweep can be
        // attributed to it: pinging needs no token, so this is the only
        // information a caller can rely on before touching the process.
        return { version: PROTOCOL_VERSION, pid: process.pid, home: brainHome() };
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
