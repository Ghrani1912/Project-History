import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { readDaemonRecord } from '../dist/capture/client.js';
import {
  censusDaemons,
  claimDaemonRecord,
  daemonSituation,
  findDaemons,
  strayWarning,
  stopDaemonsForHome,
  stopLeftoverDaemons,
  type LiveDaemon,
} from '../dist/capture/daemonGuard.js';
import { CaptureServer } from '../dist/capture/server.js';
import { DEFAULT_CONFIG, type BrainConfig } from '../dist/config.js';
import { tmpDir } from './helpers.ts';

/**
 * One daemon per brain home.
 *
 * These tests are the guard's contract: a second daemon cannot publish itself, a
 * sweep can still find one that is running without a record, and stopping a home
 * asks the daemon it knows and only kills what it cannot ask.
 */

/** Point the brain home at a temp directory for the duration of a test. */
function setHome(home: string): () => void {
  const previous = process.env.SECOND_BRAIN_HOME;
  process.env.SECOND_BRAIN_HOME = home;
  return () => {
    if (previous === undefined) delete process.env.SECOND_BRAIN_HOME;
    else process.env.SECOND_BRAIN_HOME = previous;
  };
}

/** A config that cannot reach outside the temp home: no Ollama, no watcher, no adapters. */
function quietConfig(port: number): BrainConfig {
  return {
    ...DEFAULT_CONFIG,
    port,
    llm: { ...DEFAULT_CONFIG.llm, provider: 'none' },
    embedding: { ...DEFAULT_CONFIG.embedding, provider: 'hash' },
    watch: { ...DEFAULT_CONFIG.watch, enabled: false },
    contradictions: { ...DEFAULT_CONFIG.contradictions, enabled: false },
    adapters: { ...DEFAULT_CONFIG.adapters, claudeCode: false, vscodeChat: false },
  };
}

/** Listen on the first free port at or after `from` (0 = let the OS choose). */
async function listenOn(server: net.Server, from: number): Promise<number> {
  for (let port = from; port < from + 25; port++) {
    try {
      const bound = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
      server.on('error', () => undefined);
      return bound;
    } catch {
      // Busy: try the next one.
    }
  }
  throw new Error(`no free port at or after ${from}`);
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  const port = await listenOn(probe, 0);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface FakeDaemon {
  port: number;
  pid: number;
  close: () => Promise<void>;
}

/**
 * A stand-in for a daemon of another version: it answers the unauthenticated
 * ping exactly as the real one does, so discovery can be tested without
 * spawning a second real capture process.
 */
async function startFakeDaemon(options: {
  from: number;
  pid: number;
  home: string | null;
  /** What a shutdown request does: `true` = a daemon stopping cleanly, `false` = a wedged one. */
  onShutdown: 'stop' | 'ignore';
}): Promise<FakeDaemon> {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline)) as { id: string; op: string };
      buffer = buffer.slice(newline + 1);
      if (message.op === 'ping') {
        const result = { version: '1', pid: options.pid, ...(options.home ? { home: options.home } : {}) };
        socket.write(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
        return;
      }
      if (options.onShutdown === 'stop') {
        socket.write(`${JSON.stringify({ id: message.id, ok: true, result: { stopping: true } })}\n`);
        socket.end();
        server.close();
        return;
      }
      socket.destroy();
    });
    socket.on('error', () => undefined);
  });
  const port = await listenOn(server, options.from);
  return { port, pid: options.pid, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A real process to represent a daemon in the stop tests, without a capture server. */
function spawnIdleDaemonProcess(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

async function waitForExit(child: ChildProcess, ms = 5000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function daemon(pid: number, port: number, home: string | null): LiveDaemon {
  return { pid, port, home, version: '1' };
}

test('the daemon record can only be claimed once', () => {
  const restore = setHome(tmpDir('secondbrain-claim-'));
  try {
    const first = claimDaemonRecord({ pid: 11, port: 1111, host: '127.0.0.1', token: 'a', startedAt: 0, version: '1' });
    const second = claimDaemonRecord({ pid: 22, port: 2222, host: '127.0.0.1', token: 'b', startedAt: 0, version: '1' });
    assert.equal(first, true);
    assert.equal(second, false, 'a second daemon cannot publish itself over a live one');
    const written = readDaemonRecord();
    assert.equal(written?.pid, 11, 'the record still belongs to the daemon that claimed it');
    assert.equal(written?.token, 'a', 'the token a caller needs to reach it is untouched');
  } finally {
    restore();
  }
});

test('a second daemon refuses to start and leaves the record to the first', async () => {
  const restore = setHome(tmpDir('secondbrain-single-'));
  const config = quietConfig(await freePort());
  const first = new CaptureServer({ config });
  const firstPort = await first.start();
  const second = new CaptureServer({ config });
  try {
    await assert.rejects(() => second.start(), /already serving this brain home/);
    const record = readDaemonRecord();
    assert.equal(record?.port, firstPort, 'the record still points at the daemon that is serving');
    assert.equal(record?.token, first.token, 'and keeps its token — nothing overwrote it');
  } finally {
    await first.stop();
    restore();
  }
});

/**
 * A record whose daemon died — a crash, a killed terminal, a power loss.
 *
 * This is the shape that used to brick a restart: the stale record names the
 * port the new daemon has just re-bound, so a plain ping answered from the
 * restarter itself and the dead record looked alive. The restart then exited
 * reporting the dead pid as "started", leaving no daemon at all.
 */
test('a stale record does not block a restart — the restarting daemon takes it over', async () => {
  const restore = setHome(tmpDir('secondbrain-stale-'));
  const base = await freePort();
  const config = quietConfig(base);
  const dead = spawnIdleDaemonProcess();
  const deadPid = dead.pid as number;
  dead.kill();
  await waitForExit(dead);
  claimDaemonRecord({
    pid: deadPid,
    port: base,
    host: '127.0.0.1',
    token: 'dead-token',
    startedAt: 0,
    version: '1',
  });
  const server = new CaptureServer({ config });
  try {
    const port = await server.start();
    assert.equal(port, base, 'the freed port is reused rather than skipped');
    const record = readDaemonRecord();
    assert.equal(record?.pid, process.pid, 'the restart owns the record now');
    assert.notEqual(record?.token, 'dead-token', 'and with its own token, not the dead one');
  } finally {
    await server.stop();
    restore();
  }
});

/**
 * The record names one pid; a *different* process answers on its port, and the
 * recorded pid is genuinely alive (a crashed daemon's pid reused by whatever
 * started next). Liveness alone and a bare ping both misread this as "a live
 * daemon owns this home", so a restart would refuse forever over a record that
 * provably does not describe whoever is answering.
 */
test('a record is only trusted when the port answers as the pid it names', async () => {
  const home = tmpDir('secondbrain-identify-');
  const restore = setHome(home);
  const base = await freePort();
  const config = quietConfig(base);
  const reusedPid = spawnIdleDaemonProcess();
  // An older daemon: it answers, but cannot say which home it serves.
  const earlier = await startFakeDaemon({ from: base, pid: 424242, home: null, onShutdown: 'stop' });
  claimDaemonRecord({
    pid: reusedPid.pid as number,
    port: earlier.port,
    host: '127.0.0.1',
    token: 'reused-token',
    startedAt: 0,
    version: '1',
  });
  const server = new CaptureServer({ config });
  try {
    const port = await server.start();
    assert.notEqual(port, earlier.port, 'the answering port was busy, so a different one is used');
    const record = readDaemonRecord();
    assert.equal(record?.pid, process.pid, 'the record is taken over rather than left naming a stranger');
  } finally {
    await server.stop();
    await earlier.close();
    reusedPid.kill();
    restore();
  }
});

test('the sweep finds a running daemon and attributes it to this home', async () => {
  const home = tmpDir('secondbrain-sweep-');
  const restore = setHome(home);
  const config = quietConfig(await freePort());
  const server = new CaptureServer({ config });
  const port = await server.start();
  try {
    const live = await findDaemons(config);
    const found = live.find((entry) => entry.port === port);
    assert.ok(found, 'the sweep finds the daemon by its port');
    assert.equal(found.pid, process.pid);
    assert.ok(found.home, 'the daemon reports which home it serves');
    const census = censusDaemons(live, home);
    assert.deepEqual(census.mine.map((entry) => entry.port), [port]);
    assert.deepEqual(census.unknown, [], 'nothing in this range belongs to another home');
  } finally {
    await server.stop();
    restore();
  }
});

test('a daemon that reports no home is named but never adopted', () => {
  // Every daemon built before the guard answers the ping without saying which
  // home it serves. Treating one as this home's would risk stopping a capture
  // process that belongs to a different brain.
  const home = tmpDir('secondbrain-census-');
  const census = censusDaemons(
    [
      daemon(1, 100, home),
      daemon(2, 101, `${home}/`),
      daemon(3, 102, null),
      daemon(4, 103, `${home}-other`),
    ],
    home,
  );
  assert.deepEqual(census.mine.map((entry) => entry.pid), [1, 2], 'the same directory spelled two ways is one home');
  assert.deepEqual(census.unknown.map((entry) => entry.pid), [3, 4]);
});

/**
 * The daemon `status` has just talked to must not be listed as a stranger in the
 * same breath. A daemon built before the guard reports no home, so when the
 * record names it, the record is the proof that it is ours — and `stop` has to
 * reach it, or a home whose daemon predates the guard could never be stopped.
 */
test('the recorded daemon counts as this home even when it reports no home', async () => {
  const home = tmpDir('secondbrain-recorded-');
  const restore = setHome(home);
  const config = quietConfig(await freePort());
  const pid = spawnIdleDaemonProcess();
  const daemonPid = pid.pid as number;
  const earlier = await startFakeDaemon({ from: config.port, pid: daemonPid, home: null, onShutdown: 'stop' });
  claimDaemonRecord({
    pid: daemonPid,
    port: earlier.port,
    host: '127.0.0.1',
    token: 'tok',
    startedAt: 0,
    version: '1',
  });
  try {
    const situation = await daemonSituation(config);
    assert.equal(situation.recorded?.pid, daemonPid, 'the record identifies it');
    assert.deepEqual(situation.mine.map((entry) => entry.pid), [daemonPid], 'so it counts as this home');
    assert.deepEqual(situation.unattributed, [], 'and is not reported as a stranger alongside it');
    assert.deepEqual(situation.unreachable, [], 'nothing has to be replaced');

    const report = await stopDaemonsForHome(config);
    assert.deepEqual(report.stopped, [daemonPid], 'stop reaches the daemon the record describes');
    assert.deepEqual(report.untouched, [], 'without calling it untouchable');
  } finally {
    await earlier.close();
    pid.kill();
    restore();
  }
});

test('stopping a home asks the daemon it knows and only kills what it cannot ask', async () => {
  const home = tmpDir('secondbrain-stop-');
  const restore = setHome(home);
  const base = await freePort();
  const config = quietConfig(base);
  const recorded = spawnIdleDaemonProcess();
  const legacy = spawnIdleDaemonProcess();
  const known = await startFakeDaemon({ from: base, pid: recorded.pid as number, home, onShutdown: 'stop' });
  const stray = await startFakeDaemon({
    from: known.port + 1,
    pid: legacy.pid as number,
    home: null,
    onShutdown: 'stop',
  });
  claimDaemonRecord({
    pid: recorded.pid as number,
    port: known.port,
    host: '127.0.0.1',
    token: 'tok',
    startedAt: 0,
    version: '1',
  });
  try {
    const asked = await stopDaemonsForHome(config);
    assert.deepEqual(asked.stopped, [recorded.pid], 'the recorded daemon is asked to shut down');
    assert.equal(await waitForExit(recorded, 300), false, 'asking is not killing');
    assert.deepEqual(asked.untouched.map((entry) => entry.pid), [legacy.pid], 'a daemon with no home is left alone');

    const forced = await stopDaemonsForHome(config, { force: true });
    assert.deepEqual(forced.stopped, [legacy.pid], '--force stops the one that could not be attributed');
    assert.equal(await waitForExit(legacy), true, 'and the process really ends');
  } finally {
    await known.close();
    await stray.close();
    recorded.kill();
    legacy.kill();
    restore();
  }
});

test('a leftover daemon for this home is stopped once a new one takes over', async () => {
  const home = tmpDir('secondbrain-leftover-');
  const restore = setHome(home);
  const base = await freePort();
  const config = quietConfig(base);
  const leftover = spawnIdleDaemonProcess();
  const stale = await startFakeDaemon({ from: base, pid: leftover.pid as number, home, onShutdown: 'stop' });
  const server = new CaptureServer({ config });
  const port = await server.start();
  try {
    assert.notEqual(port, stale.port, 'the live daemon is forced onto another port until it is replaced');
    const stopped = await stopLeftoverDaemons(config, process.pid);
    assert.deepEqual(stopped, [leftover.pid], 'the leftover is not the daemon that owns the record, so it is killed');
    assert.equal(await waitForExit(leftover), true);
  } finally {
    await server.stop();
    await stale.close();
    leftover.kill();
    restore();
  }
});

/**
 * The record is what makes a daemon usable: its token is what the shell hook
 * authenticates with. A daemon serving this home with no record behind it has to
 * be told apart from an adoptable one, or `start` would report success while
 * capture stayed broken.
 */
test('a daemon whose record is gone is serving but cannot be reached', async () => {
  const home = tmpDir('secondbrain-situation-');
  const restore = setHome(home);
  const config = quietConfig(await freePort());
  const server = new CaptureServer({ config });
  const port = await server.start();
  try {
    const before = await daemonSituation(config);
    assert.equal(before.recorded?.port, port, 'with its record, the daemon is reachable');
    assert.deepEqual(before.unreachable, [], 'and nothing has to be replaced');
    fs.rmSync(path.join(home, 'daemon.json'), { force: true });
    const after = await daemonSituation(config);
    assert.equal(after.recorded, null, 'without a record, no client holds a token for it');
    assert.deepEqual(
      after.mine.map((entry) => entry.port),
      [port],
      'but it is still serving this home, so a second daemon must not join it',
    );
    assert.deepEqual(
      after.unreachable.map((entry) => entry.port),
      [port],
      'and it is reported as replaceable rather than adoptable',
    );
  } finally {
    await server.stop();
    restore();
  }
});

test('the stray warning agrees with how many daemons it names', () => {
  assert.equal(
    strayWarning([daemon(1, 100, null)], 'stop'),
    'pid 1 :100 also serves this home — stop it with: brain daemon stop',
  );
  assert.equal(
    strayWarning([daemon(1, 100, null), daemon(2, 101, null)], 'stop'),
    'pid 1 :100, pid 2 :101 also serve this home — stop them with: brain daemon stop',
  );
});

test('the daemon record file lives where the guard expects it', () => {
  const home = tmpDir('secondbrain-paths-');
  const restore = setHome(home);
  try {
    claimDaemonRecord({ pid: 7, port: 4242, host: '127.0.0.1', token: 't', startedAt: 0, version: '1' });
    assert.ok(fs.existsSync(path.join(home, 'daemon.json')), 'the claim is the record every caller already reads');
  } finally {
    restore();
  }
});
