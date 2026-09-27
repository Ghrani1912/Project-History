import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { recordCommand, makeIndexer } from '../capture/ingest.js';
import { listFailures, type FailureRecord } from '../core/errors.js';
import { relativeTime, truncate } from '../util/format.js';
import { action, createContext, getEmbedder, resolveSelectedProject } from './context.js';
import { c, heading, keyValue, out, printJson } from './output.js';

/** Run a shell command, tee its output to the terminal, and keep a tail of it. */
function runAndCapture(cmd: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const cap = 20000;
    let output = '';
    const child = spawn(cmd, { shell: true, cwd, windowsHide: true, env: process.env });
    const collect = (chunk: Buffer, sink: NodeJS.WriteStream): void => {
      sink.write(chunk);
      if (output.length < cap) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, process.stdout));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, process.stderr));
    child.on('error', (err: Error) => {
      output += `\n${String(err)}`;
      resolve({ code: 127, output });
    });
    child.on('close', (code: number | null) => resolve({ code: code ?? 0, output }));
  });
}

function printFailure(failure: FailureRecord): void {
  const status = failure.fixedAt === null ? c.yellow('still open') : c.green(`fixed ${relativeTime(failure.fixedAt)}`);
  out(
    `  ${c.grey(relativeTime(failure.ts).padEnd(14))} ${c.red(`exit ${failure.exitCode}`)}  ${status}${
      failure.projectName ? `  ${c.grey(failure.projectName)}` : ''
    }`,
  );
  out(`    $ ${truncate(failure.cmd, 160)}`);
  const lines = failure.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  for (const line of lines) out(`    ${c.grey(truncate(line, 150))}`);
  if (failure.fixedAt !== null) {
    out(`    ${c.grey(`→ re-run of the same command succeeded ${relativeTime(failure.fixedAt)}`)}`);
  }
}

export function registerErrorCommands(program: Command): void {
  program
    .command('errors')
    .description('Failed commands and their error output, with how each was fixed before')
    .option('-p, --project <project>', 'limit to a project')
    .option('-l, --limit <n>', 'how many to show', (v) => Number(v), 10)
    .option('--open', 'only failures that were never re-run successfully')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (options: { project?: string; limit: number; open?: boolean; json?: boolean }) => {
          const { db, close } = createContext();
          try {
            const project = options.project ? resolveSelectedProject(db, options) : null;
            const failures = listFailures(db, {
              projectId: project?.id ?? null,
              limit: options.limit,
              openOnly: options.open,
            });
            if (options.json) {
              printJson({ project: project?.name ?? null, failures });
              return;
            }
            heading(`Failed commands${project ? ` — ${project.name}` : ''}${options.open ? ' (still open)' : ''}`);
            if (failures.length === 0) {
              out('  none on record — run a failing command through `brain run "<cmd>"` to capture its output');
              return;
            }
            for (const failure of failures) printFailure(failure);
            out('');
            out(c.grey('  tip: `brain ask "how did I fix <the error text>"` searches the same record'));
          } finally {
            close();
          }
        },
      ),
    );

  program
    .command('run')
    .description('Run a command, capture its output, and record failures for later lookup')
    .argument('<command...>', 'the shell command to run')
    .option('--json', 'machine-readable result')
    .action(
      action(async (words: string[], options: { json?: boolean }) => {
        const command = words.join(' ').trim();
        if (command.length === 0) throw new Error('nothing to run');
        const { db, config, close } = createContext();
        try {
          const result = await runAndCapture(command, process.cwd());
          const index = makeIndexer(db, await getEmbedder(config));
          const outcome = await recordCommand(db, index, {
            cwd: process.cwd(),
            cmd: command,
            exitCode: result.code,
            output: result.output,
            source: 'brain-run',
          });
          if (options.json) {
            printJson({ command, exitCode: result.code, eventId: outcome.eventId, project: outcome.projectName });
          } else if (result.code !== 0) {
            out('');
            keyValue('captured', `exit ${result.code} · event #${outcome.eventId}`);
            out(c.grey('  recall it later: brain ask "how did I fix this error?" or brain errors --open'));
          }
          process.exitCode = result.code;
        } finally {
          close();
        }
      }),
    );
}
