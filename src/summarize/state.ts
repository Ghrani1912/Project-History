import fs from 'node:fs';
import path from 'node:path';
import { parseCommitFiles } from '../core/commits.js';
import type { CommitRow, ProjectRow } from '../core/types.js';
import { git } from '../git/git.js';
import { plural, relativeTime, truncate } from '../util/format.js';
import { walkProjectFiles } from './profile.js';

/**
 * Where the project *stands*, as opposed to what happened.
 *
 * A commit list is available from GitHub. What a person actually needs after a
 * break is: did I stop mid-edit or at a stopping point, what did the repo
 * itself say was finished, and what is still visibly unfinished. Those answers
 * exist in the repository — in the shape of the last commit, the project's own
 * status documents, unchecked checklist items, unfinished markers in code and
 * new modules that landed without a test — so this module digs them out and
 * keeps the raw evidence attached.
 */

export interface UnfinishedMarker {
  file: string;
  line: number;
  kind: string;
  text: string;
}

/** A checklist is either a backlog of work or a pre-flight list. */
export type ChecklistKind = 'remaining' | 'prerequisite' | 'other';

export interface ChecklistState {
  file: string;
  kind: ChecklistKind;
  /** Nearest heading, so a count can be attributed to a section. */
  heading: string | null;
  done: number;
  open: number;
  /** The first few unchecked items, verbatim. */
  remaining: string[];
}

export interface StatusDocState {
  file: string;
  /** Lines where the document talks about its own progress or remaining work. */
  claims: string[];
  lastTouchedHash: string | null;
  lastTouchedTs: number | null;
}

export interface SessionShape {
  hash: string;
  subject: string;
  ts: number;
  added: string[];
  modified: string[];
  deleted: string[];
  /** Dominant top-level directory the session worked in. */
  area: string | null;
  /** True when a new source file landed together with a matching test file. */
  addedWithTests: boolean;
}

export interface ProjectState {
  session: SessionShape | null;
  markers: UnfinishedMarker[];
  checklists: ChecklistState[];
  statusDocs: StatusDocState[];
  /** Recently added modules with no test file anywhere in the repo. */
  untested: string[];
  scannedFiles: number;
}

export interface StateOptions {
  /** How many recent commits to treat as "the session". */
  commits?: number;
  maxMarkers?: number;
  maxFilesScanned?: number;
}

const MAX_FILE_BYTES = 256 * 1024;

const SOURCE_EXTENSIONS = new Set([
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.sh',
  '.ps1',
  '.psm1',
  '.sql',
  '.vue',
  '.svelte',
  '.yml',
  '.yaml',
]);

/** Only real modules are worth suggesting tests for. */
const TESTABLE_EXTENSIONS = new Set([
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.c',
  '.cc',
  '.cpp',
]);

/** Scripts whose job is to be run once, not imported. */
const SCRIPT_NAME = /(setup|install|configure|build|run_|start_|launch|deploy|populate|seed|migrate|diagnose|verify|check_|debug_|tmp|scratch|__main__)/i;

const TEST_BASENAME = /^(test|spec|tests|__tests__)/i;
const TEST_SUFFIX = /(_test|_spec|\.test|\.spec)$/i;

/** Paths whose contents are generated or huge — never worth scanning for prose. */
const SKIP_PATH = /(^|\/)(data|datasets|dataset|outputs|output|logs|artifacts|fixtures|migrations|static|media|models)\//i;

const MARKERS: Array<{ kind: string; re: RegExp; commentOnly: boolean }> = [
  { kind: 'TODO', re: /\bTODO\b/, commentOnly: false },
  { kind: 'FIXME', re: /\bFIXME\b/, commentOnly: false },
  { kind: 'XXX', re: /\bXXX\b/, commentOnly: false },
  { kind: 'HACK', re: /\bHACK\b/, commentOnly: false },
  { kind: 'NotImplemented', re: /NotImplementedError|raise NotImplemented/, commentOnly: false },
  { kind: 'placeholder', re: /\b(placeholder|not implemented|coming soon|for now)\b/i, commentOnly: true },
];

const COMMENT_PREFIX = /^\s*(#|\/\/|\*|\/\*|<!--|--|%)/;

const STATUS_DOC_NAME =
  /(status|roadmap|progress|plan|todo|checklist|changelog|prd|completion|remaining|summary|readme)/i;

/** Only lines that talk about progress count as a claim. */
const STATUS_CLAIM =
  /(complete|completed|completion|remaining|pending|in progress|not yet|unfinished|blocked|roadmap|progress|to do|todo|next step)/i;

const COMPLETE_CLAIM = /(100%|all .* complete|complete —|complete -|\bcomplete\b|production|release[- ]ready|ready for deployment)/i;

/** A backlog heading beats a pre-flight heading when both could match. */
const REMAINING_CONTEXT =
  /(future|roadmap|backlog|remaining|next|planned|not yet|todo|to do|enhancement|improvement|later|phase \d|\bv\d)/i;
const PREREQUISITE_CONTEXT =
  /(prerequisite|before you|pre-?commit|pre-?push|setup|install|requirement|environment|download|clone|after (successful )?push|files to|debug|verify)/i;

const CHECKLIST_OPEN = /^\s*[-*+]\s+\[( |\]|_)\]\s*(.+)$/;
const CHECKLIST_DONE = /^\s*[-*+]\s+\[[xX]\]\s*(.+)$/;

function safeRead(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Tracked files when git can tell us, else a bounded walk. */
async function listRepoFiles(projectPath: string): Promise<string[]> {
  const res = await git(['ls-files'], projectPath, 32 * 1024 * 1024);
  if (res.code === 0) {
    const files = res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (files.length > 0) return files;
  }
  return walkProjectFiles(projectPath, 4, 3000);
}

function stripMarkdown(line: string): string {
  return line
    .replace(/[`*_#>|[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Names that look like a test for `base` anywhere in the repo. */
function testBasenames(files: string[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    const base = path.basename(file).replace(/\.[^.]+$/, '');
    if (!TEST_BASENAME.test(base) && !TEST_SUFFIX.test(base)) continue;
    out.add(base.toLowerCase());
    out.add(base.replace(/^(test|spec)[_-]?/i, '').replace(/[_-]?(test|spec)$/i, '').toLowerCase());
  }
  return out;
}

function classifyChecklist(headingChain: string[], file: string): ChecklistKind {
  const context = headingChain.join(' ');
  if (REMAINING_CONTEXT.test(context)) return 'remaining';
  if (PREREQUISITE_CONTEXT.test(context)) return 'prerequisite';
  const name = path.basename(file);
  if (/(pre[_-]?commit|pre[_-]?push|setup|requirements)/i.test(name)) return 'prerequisite';
  if (/(status|roadmap|todo|next|plan|progress|remaining|backlog)/i.test(name)) return 'remaining';
  return 'other';
}

/**
 * Every checklist is read with its heading chain, because "Future Enhancements"
 * is a backlog while "Files to INCLUDE" is a pre-flight list — treating both as
 * remaining work is how a brief starts lying.
 */
export function scanChecklists(text: string, file: string): ChecklistState[] {
  const stack: string[] = [];
  const blocks: Array<{ heading: string[]; done: number; open: number; remaining: string[] }> = [];
  let current: { heading: string[]; done: number; open: number; remaining: string[] } | null = null;

  for (const line of text.split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = stripMarkdown(heading[2] ?? '');
      current = null;
      continue;
    }
    const open = line.match(CHECKLIST_OPEN);
    const done = CHECKLIST_DONE.test(line);
    if (!open && !done) continue;
    if (!current) {
      current = { heading: stack.filter((entry) => entry.length > 0), done: 0, open: 0, remaining: [] };
      blocks.push(current);
    }
    if (open) {
      current.open += 1;
      const item = stripMarkdown(open[2] ?? '');
      if (item.length > 2 && current.remaining.length < 4) current.remaining.push(truncate(item, 110));
    } else {
      current.done += 1;
    }
  }

  return blocks
    .filter((block) => block.open + block.done >= 2)
    .map((block) => ({
      file,
      kind: classifyChecklist(block.heading, file),
      heading: block.heading[block.heading.length - 1] ?? null,
      done: block.done,
      open: block.open,
      remaining: block.remaining,
    }));
}

export function findClaims(text: string): string[] {
  const claims: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const clean = stripMarkdown(line);
    if (clean.length < 12 || clean.length > 150) continue;
    if (/^[-=]{3,}$/.test(clean)) continue;
    // Commands, links and numbered instructions are not statements of progress.
    if (/(^\s*[$>]|\s-m\s|--|https?:|\/)/.test(clean)) continue;
    if (/^\d+\.\s/.test(clean)) continue;
    // Table headers and title headings are not statements about progress.
    const words = clean.split(/\s+/).filter((word) => /[A-Za-z]/.test(word));
    const capitalized = words.filter((word) => /^[A-Z0-9]/.test(word)).length;
    if (words.length >= 4 && !/[:.,;!?]/.test(clean) && capitalized / words.length >= 0.8) continue;
    if (!STATUS_CLAIM.test(clean)) continue;
    if (claims.includes(clean)) continue;
    claims.push(clean);
    if (claims.length >= 3) break;
  }
  return claims;
}

/** Parse `git show --name-status` into added/modified/deleted lists. */
function parseNameStatus(stdout: string): { added: string[]; modified: string[]; deleted: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    const status = parts[0]?.trim() ?? '';
    if (status.length === 0) continue;
    const target = (status.startsWith('R') ? parts[2] : parts[1])?.trim();
    if (!target) continue;
    const letter = status.charAt(0).toUpperCase();
    if (letter === 'A') added.push(target);
    else if (letter === 'D') deleted.push(target);
    else modified.push(target);
  }
  return { added, modified, deleted };
}

function looksLikeTest(file: string): boolean {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  return TEST_BASENAME.test(base) || TEST_SUFFIX.test(base);
}

function dominantArea(files: string[]): string | null {
  const counts = new Map<string, number>();
  for (const file of files) {
    const slash = file.indexOf('/');
    if (slash <= 0) continue;
    const area = file.slice(0, slash);
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [area, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && area < best)) {
      best = area;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Files git recorded as newly added in the last few commits. Scoped tightly on
 * purpose: a module added a month ago is not "recently added without a test".
 */
async function recentlyAddedFiles(root: string, commitLimit: number): Promise<string[]> {
  const res = await git(
    ['log', '--diff-filter=A', '--name-status', '--format=%x00%H', '-n', String(commitLimit)],
    root,
  );
  if (res.code !== 0) return [];
  // The repository's first commit imports everything; it is not "new code".
  const rootRes = await git(['rev-list', '--max-parents=0', 'HEAD'], root);
  const roots = new Set(
    rootRes.code === 0
      ? rootRes.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [],
  );
  const out: string[] = [];
  for (const chunk of res.stdout.split('\u0000')) {
    const lines = chunk.split('\n');
    // The first line of each chunk is the commit hash header.
    if (roots.has((lines[0] ?? '').trim())) continue;
    for (const line of lines.slice(1)) {
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      if (parts[0]?.trim().charAt(0).toUpperCase() !== 'A') continue;
      const value = parts[1]?.trim();
      if (!value || out.includes(value)) continue;
      out.push(value);
    }
  }
  return out;
}

function docScore(file: string): number {
  const base = path.basename(file).toLowerCase();
  if (/^(readme|index)\.md$/.test(base)) return 1;
  if (/(status|roadmap|progress|remaining)/.test(base)) return 4;
  if (/(plan|todo|checklist|completion)/.test(base)) return 3;
  if (/(summary|prd|guide|setup)/.test(base)) return 2;
  return 0;
}

/**
 * Read the repository for evidence of where the work actually stands.
 * Everything returned is a fact read off disk or out of git.
 */
export async function analyzeProjectState(
  project: ProjectRow,
  commits: CommitRow[],
  options: StateOptions = {},
): Promise<ProjectState> {
  const root = project.path;
  const maxMarkers = options.maxMarkers ?? 8;
  const maxFilesScanned = options.maxFilesScanned ?? 160;
  const window = options.commits ?? 20;
  const recent = commits.slice(0, window);

  const exists = fs.existsSync(root);
  const repoFiles = exists ? await listRepoFiles(root) : [];
  const tests = testBasenames(repoFiles);

  /* ---------------- what the last session actually did ---------------- */

  let session: SessionShape | null = null;
  const last = recent[0];
  if (last) {
    let shape = { added: [] as string[], modified: [] as string[], deleted: [] as string[] };
    const res = await git(['show', '--name-status', '--format=', '--find-renames', last.hash], root);
    if (res.code === 0 && res.stdout.trim().length > 0) {
      shape = parseNameStatus(res.stdout);
    } else {
      // No git available: fall back to the per-file diff we already stored.
      const earlier = new Set<string>();
      for (const commit of recent.slice(1)) {
        for (const file of parseCommitFiles(commit.files)) earlier.add(file.path);
      }
      for (const file of parseCommitFiles(last.files)) {
        if (file.del === 0 && !earlier.has(file.path)) shape.added.push(file.path);
        else shape.modified.push(file.path);
      }
    }
    const touched = [...shape.added, ...shape.modified];
    const addedWithTests =
      shape.added.some((file) => !looksLikeTest(file)) &&
      shape.added.some((file) => looksLikeTest(file));
    session = {
      hash: last.hash,
      subject: (last.message ?? '').split('\n')[0]?.trim() ?? '',
      ts: last.ts,
      added: shape.added.filter((file) => !SKIP_PATH.test(file)),
      modified: shape.modified.filter((file) => !SKIP_PATH.test(file)),
      deleted: shape.deleted.filter((file) => !SKIP_PATH.test(file)),
      area: dominantArea(touched),
      addedWithTests,
    };
  }

  /* ---------------- unfinished markers in what was just touched ---------------- */

  const markers: UnfinishedMarker[] = [];
  const seen = new Set<string>();
  let scannedFiles = 0;
  const candidateFiles: string[] = [];
  for (const commit of recent.slice(0, 5)) {
    for (const file of parseCommitFiles(commit.files)) {
      if (candidateFiles.includes(file.path)) continue;
      candidateFiles.push(file.path);
    }
  }
  for (const rel of candidateFiles) {
    if (markers.length >= maxMarkers || scannedFiles >= maxFilesScanned) break;
    if (SKIP_PATH.test(rel) || !SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    scannedFiles += 1;
    const text = safeRead(path.join(root, rel));
    if (text === null) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] ?? '';
      for (const marker of MARKERS) {
        if (!marker.re.test(raw)) continue;
        if (marker.commentOnly && !COMMENT_PREFIX.test(raw)) continue;
        const key = `${rel}:${index + 1}`;
        if (seen.has(key)) break;
        seen.add(key);
        markers.push({
          file: rel,
          line: index + 1,
          kind: marker.kind,
          text: truncate(stripMarkdown(raw.replace(COMMENT_PREFIX, '')), 100),
        });
        break;
      }
      if (markers.length >= maxMarkers) break;
    }
  }

  /* ---------------- the project's own status documents ---------------- */

  const checklists: ChecklistState[] = [];
  const statusDocs: StatusDocState[] = [];
  if (exists) {
    const docs = repoFiles
      .filter((file) => file.toLowerCase().endsWith('.md'))
      .filter((file) => STATUS_DOC_NAME.test(path.basename(file)))
      .sort(
        (a, b) =>
          docScore(b) - docScore(a) ||
          a.split('/').length - b.split('/').length ||
          a.localeCompare(b),
      )
      .slice(0, 10);
    for (const rel of docs) {
      const text = safeRead(path.join(root, rel));
      if (text === null) continue;
      // A backlog must not be crowded out by a pre-flight list from another
      // file (or from earlier in the same one), so keep open backlogs first.
      const all = scanChecklists(text, rel);
      const blocks = [
        ...all.filter((block) => block.kind === 'remaining' && block.open > 0),
        ...all.filter((block) => !(block.kind === 'remaining' && block.open > 0)),
      ].slice(0, 6);
      for (const block of blocks) checklists.push(block);
      if (checklists.length > 30) break;
      const claims = findClaims(text);
      const used = statusDocs.reduce((sum, doc) => sum + doc.claims.length, 0);
      if (claims.length > 0 && statusDocs.length < 2 && used < 5) {
        // The nearest commit that touched this document dates the claim.
        let touchedHash: string | null = null;
        let touchedTs: number | null = null;
        for (const commit of commits) {
          if (parseCommitFiles(commit.files).some((file) => file.path === rel)) {
            touchedHash = commit.hash;
            touchedTs = commit.ts;
            break;
          }
        }
        statusDocs.push({ file: rel, claims, lastTouchedHash: touchedHash, lastTouchedTs: touchedTs });
      }
    }
  }

  /* ---------------- newly added code with no test anywhere ---------------- */

  const untested: string[] = [];
  for (const rel of await recentlyAddedFiles(root, 3)) {
    if (untested.length >= 4) break;
    if (SKIP_PATH.test(rel)) continue;
    if (!TESTABLE_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
    if (looksLikeTest(rel)) continue;
    // Glue scripts and one-off utilities are not modules that need tests.
    if (SCRIPT_NAME.test(path.basename(rel))) continue;
    const base = path.basename(rel).replace(/\.[^.]+$/, '');
    if (tests.has(base.toLowerCase())) continue;
    untested.push(rel);
  }

  // Backlogs first, then the pre-flight lists, each ranked by what is left.
  const rankedChecklists = [...checklists].sort((a, b) => {
    const rank = (entry: ChecklistState): number =>
      entry.kind === 'remaining' ? 0 : entry.kind === 'prerequisite' ? 1 : 2;
    return rank(a) - rank(b) || b.open - a.open || a.file.localeCompare(b.file);
  });

  return {
    session,
    markers,
    checklists: rankedChecklists,
    statusDocs,
    untested,
    scannedFiles,
  };
}

export interface StateNarrativeContext {
  generatedAt: number;
  projectName: string;
  dirtyFiles: string[];
  totalCommits: number;
  events: number;
}

function listOf(items: string[]): string {
  return items.map((item) => `\`${truncate(item, 52)}\``).join(', ');
}

/**
 * Prose answer to "where does this project actually stand?".
 *
 * In order: what the last session did and whether it looks finished, what the
 * repository itself claims about progress, what is still visibly unfinished,
 * and the single most likely next task. Every sentence traces back to state.*
 * or ctx — nothing here is invented.
 */
export function projectStateNarrative(state: ProjectState, ctx: StateNarrativeContext): string[] {
  const out: string[] = [];
  const session = state.session;
  const backlog = state.checklists.filter((entry) => entry.kind === 'remaining' && entry.open > 0);
  const preflight = state.checklists.filter((entry) => entry.kind === 'prerequisite' && entry.open > 0);

  /* -------- 1. was this a stopping point or an interruption? -------- */
  if (session) {
    const when = relativeTime(session.ts, ctx.generatedAt);
    const subject = session.subject ? `"${truncate(session.subject, 48)}"` : '(no message)';
    const where = session.area ? ` in \`${session.area}/\`` : '';
    if (session.added.length > 0) {
      const newFiles = listOf(session.added.slice(0, 2));
      const rest = session.added.length > 2 ? ` and ${session.added.length - 2} more` : '';
      out.push(
        `The last session (${when}, \`${session.hash.slice(0, 7)}\` ${subject}) created ${plural(
          session.added.length,
          'new file',
        )}${where} — ${newFiles}${rest} — and touched ${plural(session.modified.length, 'existing file')}.${
          session.addedWithTests
            ? ' New code and its test landed together, so this reads as a finished increment.'
            : ' No test file was added with it, so the newest code is unverified.'
        }`,
      );
    } else {
      out.push(
        `The last session (${when}, \`${session.hash.slice(0, 7)}\` ${subject}) only changed ${plural(
          session.modified.length,
          'existing file',
        )}${where} — no new files. That shape is usually a fix or a polish pass rather than a new feature.`,
      );
    }
    if (session.deleted.length > 0) {
      out.push(
        `It also removed ${plural(session.deleted.length, 'file')} (${listOf(
          session.deleted.slice(0, 3),
        )}), so part of the work was cleanup.`,
      );
    }
  }

  /* -------- 2. what the repository itself claims -------- */
  for (const doc of state.statusDocs) {
    const dated =
      doc.lastTouchedTs !== null
        ? ` Last updated in \`${doc.lastTouchedHash?.slice(0, 7) ?? '?'}\`, ${relativeTime(
            doc.lastTouchedTs,
            ctx.generatedAt,
          )}.`
        : '';
    out.push(`\`${doc.file}\` states: ${doc.claims.map((claim) => `"${claim}"`).join('; ')}.${dated}`);
  }
  const claimsDone = state.statusDocs.some((doc) => doc.claims.some((claim) => COMPLETE_CLAIM.test(claim)));
  const openCount = backlog.reduce((sum, entry) => sum + entry.open, 0) + state.markers.length;
  if (claimsDone && openCount > 0) {
    out.push(
      'So the documentation says the planned work is finished, while the lists below are what was never started — the difference between "the phases are done" and "the project has nothing left to do".',
    );
  } else if (claimsDone && session) {
    out.push(
      'Nothing in the tree contradicts that: the documents claim completion and no unfinished markers or open backlog items were found.',
    );
  }

  /* -------- 3. what is still visibly unfinished -------- */
  const open: string[] = [];
  if (backlog.length > 0) {
    const total = backlog.reduce((sum, entry) => sum + entry.open, 0);
    const doneTotal = backlog.reduce((sum, entry) => sum + entry.done, 0);
    const first = backlog[0];
    open.push(
      `**${total} unchecked backlog item${total === 1 ? '' : 's'}** across ${plural(
        backlog.length,
        'section',
      )} marked as upcoming work${doneTotal > 0 ? ` (${doneTotal} already done)` : ''}${
        first?.remaining[0]
          ? ` — in \`${first.file}\`${first.heading ? ` under "${first.heading}"` : ''}, the first is "${first.remaining[0]}"`
          : ''
      }`,
    );
  }
  if (state.markers.length > 0) {
    const hard = state.markers.filter((marker) => marker.kind !== 'placeholder');
    const listed = (hard.length > 0 ? hard : state.markers).slice(0, 2);
    open.push(
      `${plural(state.markers.length, 'unfinished marker')} in the recently changed code (${listed
        .map((marker) => `\`${marker.file}:${marker.line}\` ${marker.kind}`)
        .join(', ')})`,
    );
  }
  if (state.untested.length > 0) {
    open.push(`${plural(state.untested.length, 'new module')} with no test file: ${listOf(state.untested.slice(0, 3))}`);
  }
  if (open.length > 0) {
    out.push(`What is still open, according to the repository itself: ${open.join('; ')}.`);
  }
  const preflightEntry = preflight[0];
  if (preflightEntry) {
    out.push(
      `\`${preflightEntry.file}\` is a pre-flight list, not a backlog (${preflightEntry.open} of ${
        preflightEntry.open + preflightEntry.done
      } items unticked${preflightEntry.heading ? ` under "${preflightEntry.heading}"` : ''}) — those are things to run before pushing or deploying, not unfinished features.`,
    );
  }

  /* -------- 4. the honest read, and the next move -------- */
  const next: string[] = [];
  const firstBacklog = backlog[0];
  if (firstBacklog?.remaining[0]) {
    next.push(`the first unchecked item in \`${firstBacklog.file}\` — "${firstBacklog.remaining[0]}"`);
  }
  const marker = state.markers.find((entry) => entry.kind !== 'placeholder');
  if (next.length === 0 && marker) next.push(`the ${marker.kind} in \`${marker.file}:${marker.line}\``);
  if (next.length === 0 && state.untested.length > 0) next.push(`writing a test for \`${state.untested[0]}\``);
  const placeholder = state.markers[0];
  if (next.length === 0 && placeholder) {
    next.push(`the gap noted in \`${placeholder.file}:${placeholder.line}\` — "${truncate(placeholder.text, 60)}"`);
  }

  const bits: string[] = [];
  if (ctx.dirtyFiles.length > 0) {
    bits.push(
      `you stopped with ${plural(ctx.dirtyFiles.length, 'file')} uncommitted, so there is work in progress on disk that git has not seen`,
    );
  } else if (session) {
    bits.push('everything from that session is committed, so nothing is lost');
  }
  if (ctx.events === 0) {
    bits.push(
      'no shell or editor activity has been captured yet, so this reading comes from the repository itself — with capture on it would also name the command you stopped on',
    );
  }
  if (bits.length > 0) {
    const sentence = bits.join('; ');
    out.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }
  if (next.length > 0) out.push(`**The likely next step:** ${next[0]}.`);

  return out;
}
