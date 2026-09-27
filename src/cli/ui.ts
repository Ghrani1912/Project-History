import type { Command } from 'commander';
import { loadConfig } from '../config.js';
import { BrainUiServer, openBrowser } from '../ui/server.js';
import { brainHome, dbPath } from '../util/paths.js';
import { action } from './context.js';
import { bullet, c, heading, keyValue, ok, out } from './output.js';

export function registerUiCommands(program: Command): void {
  program
    .command('ui')
    .description('Local web UI: pick a folder to register, then read briefs, timelines and recall')
    .option('--port <n>', 'port to listen on', (v) => Number(v))
    .option('--no-open', 'do not open a browser automatically')
    .action(
      action(async (options: { port?: number; open: boolean }) => {
        const config = loadConfig();
        const server = new BrainUiServer({ config, port: options.port ?? config.ui.port });
        const { url, port } = await server.start();

        ok(`Second Brain UI running at ${c.bold(url)}`);
        keyValue('home', brainHome());
        keyValue('database', dbPath());
        keyValue('port', port);
        out('');
        heading('What you can do here');
        bullet('paste a folder path or a git link into "Track a folder" — a folder captures live, a link is cloned for recall');
        bullet('see every project with the stack, summary and capture counts it stored');
        bullet('generate a brief, read the timeline, and ask questions across your memory');
        bullet('start/stop the daemon and install shell hooks when capture goes quiet');
        out('');
        out(c.grey('  press ctrl-c to stop the UI (the capture daemon keeps running)'));

        if (options.open) {
          const opened = openBrowser(url);
          if (!opened) out(c.grey('  could not open a browser automatically — visit the URL above'));
        }

        const shutdown = async (): Promise<void> => {
          out('');
          await server.close();
          process.exit(0);
        };
        // The class exposes close() directly; no manual cleanup needed.
        process.on('SIGINT', () => void shutdown());
        process.on('SIGTERM', () => void shutdown());
        // The listening server keeps the process alive; this also keeps the
        // action pending so commander does not exit immediately.
        await new Promise<void>(() => undefined);
      }),
    );
}
