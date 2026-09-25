import type { BrainConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { latestBrief, saveBrief } from '../core/briefs.js';
import { listCommits } from '../core/commits.js';
import { extractDecisionCandidates, listDecisions } from '../core/decisions.js';
import { buildTimeline } from '../core/timeline.js';
import { countChatTurns } from '../core/chat.js';
import { lastEventId, recentEvents } from '../core/events.js';
import type { CommitRow, DecisionRow, EventRow, ProjectRow, TimelineEntry } from '../core/types.js';
import { gitStatusShort } from '../git/git.js';
import { createOllamaLlm } from '../llm/ollama.js';
import { log } from '../util/logger.js';
import { formatDay, plural, relativeTime, truncate } from '../util/format.js';
import { detectStack, detectTestCommand } from './stack.js';

export interface BriefData {
  project: ProjectRow;
  generatedAt: number;
  timeline: TimelineEntry[];
  commits: CommitRow[];
  decisions: DecisionRow[];
  recentCommands: EventRow[];
  touchedFiles: string[];
  dirtyFiles: string[];
  failingCommands: string[];
  stack: string[];
  testCommand: string | null;
  stats: {
    events: number;
    commits: number;
    chatTurns: number;
    firstTs: number | null;
  };
  watermark: number;
}

export interface BriefOptions {
  maxEvents?: number;
  since?: number;
  /** Skip the LLM even when one is configured. */
  heuristicOnly?: boolean;
}

async function gatherBriefData(db: Db, project: ProjectRow, options: BriefOptions): Promise<BriefData> {
  const maxEvents = options.maxEvents ?? 200;
  const since = options.since ?? 0;
  const generatedAt = Date.now();

  const timeline = buildTimeline(db, { projectId: project.id, limit: maxEvents, since });
  const commits = listCommits(db, project.id, 12);
  const decisions = listDecisions(db, project.id, 10);
  const recentCommands = recentEvents(db, project.id, 40, ['cmd']);
  const touched = buildTimeline(db, { projectId: project.id, limit: maxEvents, since, kinds: ['file'] });

  const touchedFiles: string[] = [];
  const seen = new Set<string>();
  for (const entry of touched) {
    const file = entry.text.replace(/^\w+\s+/, '').trim();
    if (file && !seen.has(file)) {
      seen.add(file);
      touchedFiles.push(file);
    }
    if (touchedFiles.length >= 15) break;
  }

  const failingCommands: string[] = [];
  const retried = new Set<string>();
  for (const row of recentCommands) {
    let cmd = '';
    try {
      cmd = String((JSON.parse(row.payload) as { cmd?: string }).cmd ?? '');
    } catch {
      cmd = '';
    }
    if (!cmd) continue;
    if ((row.exit_code ?? 0) === 0) {
      retried.add(cmd);
    } else if (!retried.has(cmd) && failingCommands.length < 5 && !failingCommands.includes(cmd)) {
      failingCommands.push(cmd);
    }
  }

  const dirtyFiles = await gitStatusShort(project.path).catch(() => []);

  const firstRow = db
    .prepare('SELECT MIN(ts) AS ts FROM events WHERE project_id = ?')
    .get(project.id) as { ts: number | null } | undefined;

  const stats = {
    events: (db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').get(project.id) as { n: number }).n,
    commits: (db.prepare('SELECT COUNT(*) AS n FROM commits WHERE project_id = ?').get(project.id) as { n: number }).n,
    chatTurns: countChatTurns(db, project.id),
    firstTs: firstRow?.ts ?? null,
  };

  return {
    project,
    generatedAt,
    timeline,
    commits,
    decisions,
    recentCommands,
    touchedFiles,
    dirtyFiles,
    failingCommands,
    stack: detectStack(project.path),
    testCommand: detectTestCommand(project.path),
    stats,
    watermark: lastEventId(db, project.id),
  };
}

/** Deterministic, offline brief. Always available; the fallback of record. */
export function heuristicBrief(data: BriefData): string {
  const lines: string[] = [];
  const { project } = data;
  const limit = 10;
  const since = data.timeline.length > 0 ? data.timeline[data.timeline.length - 1]?.ts : undefined;
  lines.push(`# ${project.name} — where you left off`);
  lines.push('');
  lines.push(
    `_${relativeTime(data.generatedAt)} generated · ${plural(data.stats.events, 'event')} · ${
      data.stats.commits
    } commits · ${data.stats.chatTurns} chat turns${since ? ` · covering since ${formatDay(since)}` : ''}_`,
  );
  if (data.stack.length > 0) lines.push(`\n**Stack:** ${data.stack.join(', ')}`);
  lines.push('');

  lines.push('## Recent activity');
  if (data.timeline.length === 0) {
    lines.push('- No captured activity yet. Run `brain watch` or install the shell hook (`brain shell install`).');
  } else {
    for (const entry of data.timeline.slice(0, limit)) {
      lines.push(`- ${formatDay(entry.ts)} \`${entry.kind}\` ${truncate(entry.text, 120)}`);
    }
    if (data.timeline.length > limit) {
      lines.push(`- … ${data.timeline.length - limit} more (run \`brain timeline\`)`);
    }
  }

  lines.push('\n## Recent commits');
  if (data.commits.length === 0) lines.push('- No commits ingested yet (`brain register` backfills history).');
  else {
    for (const commit of data.commits.slice(0, 6)) {
      lines.push(
        `- \`${commit.hash.slice(0, 7)}\` ${truncate((commit.message ?? '').split('\n')[0] ?? '', 90)} — ${
          commit.author ?? 'unknown'
        }, ${relativeTime(commit.ts, data.generatedAt)}`,
      );
    }
  }

  lines.push('\n## Decisions');
  if (data.decisions.length === 0) {
    lines.push('- None logged. `brain log "decided X because Y"` to start the decision log.');
  } else {
    for (const decision of data.decisions.slice(0, 6)) {
      lines.push(`- ${truncate(decision.text, 160)}${decision.tags ? ` (${decision.tags})` : ''}`);
    }
  }

  const threads: string[] = [];
  for (const cmd of data.failingCommands) threads.push(`Failing command not yet fixed: \`${truncate(cmd, 90)}\``);
  if (data.dirtyFiles.length > 0) {
    threads.push(
      `Uncommitted work in ${plural(data.dirtyFiles.length, 'file')}: ${data.dirtyFiles
        .slice(0, 4)
        .map((line) => truncate(line, 50))
        .join(', ')}`,
    );
  }
  if (data.touchedFiles.length > 0) {
    threads.push(`Recently touched: ${data.touchedFiles.slice(0, 5).map((f) => truncate(f, 60)).join(', ')}`);
  }
  if (data.testCommand) threads.push(`Test command: \`${data.testCommand}\``);
  lines.push('\n## Open threads');
  if (threads.length === 0) lines.push('- Nothing obviously open — clean working tree, no failing commands.');
  else for (const thread of threads) lines.push(`- ${thread}`);

  return lines.join('\n');
}

/** Compact digest handed to the LLM; keeps the prompt small and factual. */
export function renderDigest(data: BriefData): string {
  const lines: string[] = [];
  lines.push(`Project: ${data.project.name} (${data.project.path})`);
  if (data.stack.length > 0) lines.push(`Stack: ${data.stack.join(', ')}`);
  lines.push(`Generated: ${new Date(data.generatedAt).toISOString()}`);
  lines.push(`Totals: ${data.stats.events} events, ${data.stats.commits} commits, ${data.stats.chatTurns} chat turns`);
  lines.push('');
  lines.push('Recent timeline (newest first):');
  for (const entry of data.timeline.slice(0, 60)) {
    lines.push(`- [${new Date(entry.ts).toISOString()}] (${entry.kind}) ${truncate(entry.text, 200)}`);
  }
  if (data.commits.length > 0) {
    lines.push('');
    lines.push('Recent commits:');
    for (const commit of data.commits.slice(0, 10)) {
      lines.push(
        `- ${commit.hash.slice(0, 7)} ${truncate(commit.message ?? '', 140)} (+${commit.insertions}/-${commit.deletions}, ${commit.files_changed} files)`,
      );
    }
  }
  if (data.decisions.length > 0) {
    lines.push('');
    lines.push('Logged decisions:');
    for (const decision of data.decisions) lines.push(`- ${truncate(decision.text, 200)}`);
  }
  if (data.dirtyFiles.length > 0) {
    lines.push('');
    lines.push('Uncommitted changes:');
    for (const file of data.dirtyFiles.slice(0, 10)) lines.push(`- ${file}`);
  }
  if (data.failingCommands.length > 0) {
    lines.push('');
    lines.push('Commands that failed and were not re-run successfully:');
    for (const cmd of data.failingCommands) lines.push(`- ${cmd}`);
  }
  return lines.join('\n');
}

export function briefPrompt(digest: string, projectName: string): string {
  return [
    `You are maintaining a local "second brain" for a developer. Below is raw captured activity for the project "${projectName}".`,
    'Write a concise handover brief so the developer instantly remembers where they left off.',
    'Rules:',
    '- 150 words max, markdown, no preamble, no code fences.',
    '- Sections: "Where you left off" (2-3 bullets), "Recent decisions" (bullets, only if evidenced), "Open threads" (bullets: failing commands, uncommitted files, likely next step).',
    '- Only state things supported by the data. Never invent file names, commands or decisions.',
    '',
    digest,
  ].join('\n');
}

export interface GeneratedBrief {
  projectId: number;
  text: string;
  generator: string;
  watermark: number;
  createdAt: number;
}

export async function generateBrief(
  db: Db,
  config: BrainConfig,
  project: ProjectRow,
  options: BriefOptions = {},
): Promise<GeneratedBrief> {
  const data = await gatherBriefData(db, project, options);
  let text = '';
  let generator = 'heuristic';

  const wantsLlm = !options.heuristicOnly && config.llm.provider !== 'none';
  if (wantsLlm) {
    const client = createOllamaLlm({
      url: config.llm.ollamaUrl,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
    });
    if (await client.available()) {
      const digest = renderDigest(data);
      text = await client.generate(briefPrompt(digest, project.name), { temperature: 0.2, maxTokens: 400 });
      if (text.trim().length > 0) {
        text = text.trim();
        generator = client.name;
      }
    } else {
      log.debug('llm unavailable; falling back to heuristic brief');
    }
  }
  if (text.trim().length === 0) {
    text = heuristicBrief(data);
    generator = 'heuristic';
  }

  const id = saveBrief(db, {
    projectId: project.id,
    summaryText: text,
    generatedAt: data.generatedAt,
    eventWatermark: data.watermark,
    generator,
  });
  log.debug(`saved brief ${id} for ${project.name} (${generator})`);
  return { projectId: project.id, text, generator, watermark: data.watermark, createdAt: data.generatedAt };
}

/** True when it is time to auto-brief this project again (cd-trigger throttle). */
export function shouldAutoBrief(db: Db, projectId: number, minIntervalMinutes: number): boolean {
  const brief = latestBrief(db, projectId);
  if (!brief) return true;
  const ageMs = Date.now() - brief.generated_at;
  return ageMs >= Math.max(0, minIntervalMinutes) * 60_000;
}

/** Turn commit subjects into suggested decision entries. */
export function suggestDecisionsFromCommits(db: Db, projectId: number, limit = 10): string[] {
  const commits = listCommits(db, projectId, 100);
  const suggestions: string[] = [];
  for (const commit of commits) {
    const subject = (commit.message ?? '').split('\n')[0] ?? '';
    for (const candidate of extractDecisionCandidates(subject)) {
      if (!suggestions.includes(candidate)) suggestions.push(candidate);
    }
    if (suggestions.length >= limit) break;
  }
  return suggestions.slice(0, limit);
}
