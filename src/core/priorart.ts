import type { Db } from '../db/index.js';
import { listCommits, parseCommitFiles } from './commits.js';
import { listProjects } from './projects.js';
import type { CommitRow, ProjectRow } from './types.js';
import { tokenize } from '../embeddings/embedder.js';

/**
 * "You solved this exact problem in another project."
 *
 * Every other tool searches inside one repository. This does the opposite: it
 * looks at the work you finished *elsewhere* and matches it structurally, not
 * textually — capability tags (auth, migrations, websockets…), the role of the
 * files a commit touched (login/session/middleware; not their names in one
 * repo), and shared vocabulary weighted by how rare it is across projects.
 *
 * Everything here is local, deterministic and explainable: each match carries
 * the reasons it matched, so a bad suggestion can be argued with.
 */

export interface SolvedWork {
  projectId: number;
  projectName: string;
  projectPath: string;
  stack: string[];
  hash: string;
  subject: string;
  ts: number;
  /** Most-changed files first. */
  files: string[];
  insertions: number;
  deletions: number;
  capabilities: string[];
  roles: string[];
  /** Everything below is used for lexical overlap. */
  tokens: string[];
  languages: string[];
}

export interface PriorArtSignal {
  kind: 'capability' | 'role' | 'word';
  value: string;
  /** How much this signal contributed, after rarity and specificity. */
  weight: number;
}

export interface PriorArtMatch {
  projectId: number;
  projectName: string;
  projectPath: string;
  hash: string;
  subject: string;
  ts: number;
  files: string[];
  insertions: number;
  deletions: number;
  stack: string[];
  score: number;
  /** Strongest signals first — this is what makes a match credible. */
  signals: PriorArtSignal[];
  sharedCapabilities: string[];
  sharedRoles: string[];
  sharedTokens: string[];
  sameStack: boolean;
}

export interface PriorArtQuery {
  text: string;
  projectId: number | null;
  capabilities: string[];
  roles: string[];
}

export interface PriorArtResult {
  query: PriorArtQuery;
  matches: PriorArtMatch[];
  /** Units that could have matched (i.e. how much history exists to draw on). */
  candidates: number;
  projectsSearched: number;
  /** Best score that was rejected, so "no match" can be argued with. */
  bestCandidateWeight: number;
}

export interface PriorArtOptions {
  /** Restrict candidates to this project (rarely what you want). */
  projectId?: number | null;
  /** Never match these projects (usually the one you are working in). */
  excludeProjectIds?: number[];
  limit?: number;
  /** Below this score a match is noise, so it is dropped. */
  minScore?: number;
  /** How many commits per project to consider. */
  commitsPerProject?: number;
  /** Explicit structure, when the caller already knows it (focus mode). */
  capabilities?: string[];
  roles?: string[];
}

/** Weights are small numbers, so this is the floor for "worth showing". */
export const DEFAULT_MIN_SCORE = 1.2;

/**
 * Capability tags: the structural vocabulary that survives a change of
 * language, framework and project. A tag is a *problem shape*, not a word.
 *
 * The weight is how specific the shape is. "api/endpoints" and "testing" are
 * true of nearly every commit in every project, so they can never be the
 * reason a match is shown; "auth/session" or "realtime/streaming" can.
 */
const CAPABILITIES: Array<{ tag: string; re: RegExp }> = [
  { tag: 'auth/session', re: /\b(auth|login|signin|session|jwt|oauth|token|password|credential|sso|rbac|permission|acl|logout)\b/ },
  { tag: 'api/endpoints', re: /\b(api|endpoint|route|router|controller|rest|graphql|handler|webhook|request|response)\b/ },
  { tag: 'database/schema', re: /\b(migration|migrate|schema|orm|sql|database|postgres|mysql|sqlite|mongo|seed|columns?|tables?)\b/ },
  { tag: 'testing', re: /\b(test|tests|pytest|jest|vitest|spec|coverage|fixture|mock)\b/ },
  { tag: 'ci/build', re: /\b(ci|pipeline|build|workflow|makefile|gradle|webpack|vite|tsconfig|lint)\b/ },
  { tag: 'containers/deploy', re: /\b(docker|compose|kubernetes|k8s|helm|deploy|nginx|systemd|terraform|ansible|release)\b/ },
  { tag: 'data/ingestion', re: /\b(ingest|ingestion|csv|etl|crawler|scrape|scraper|import|parser|parse|dataset|corpus|spark|hadoop)\b/ },
  { tag: 'ml/model', re: /\b(model|train|training|inference|embedding|classifier|feature|sklearn|torch|tensorflow|hyperparameter)\b/ },
  { tag: 'realtime/streaming', re: /\b(stream|streaming|websocket|socket|sse|realtime|queue|worker|celery|kafka|pubsub)\b/ },
  { tag: 'caching/perf', re: /\b(cache|redis|memo|optimi[sz]|performance|latency|batch|bloom)\b/ },
  { tag: 'retry/errors', re: /\b(retry|backoff|timeout|resilien|rate.?limit|throttle|circuit|fallback)\b/ },
  { tag: 'ui/frontend', re: /\b(ui|frontend|component|dashboard|chart|graph|css|styling|layout|react|vue|svelte)\b/ },
  { tag: 'notifications', re: /\b(email|smtp|notify|notification|alert|slack|push)\b/ },
  { tag: 'storage/files', re: /\b(upload|download|s3|blob|storage|export|report|file)\b/ },
  { tag: 'config/env', re: /\b(config|configuration|env|environment|settings|dotenv|secret|flags?)\b/ },
  { tag: 'logging/metrics', re: /\b(log|logging|logger|metric|prometheus|grafana|monitor|telemetry|trace)\b/ },
  { tag: 'cli/scripts', re: /\b(cli|command|script|entrypoint|argparse|shell|powershell|bash)\b/ },
  { tag: 'graph/topology', re: /\b(graph|network|topolog|centrality|community|entity|node|edge)\b/ },
];

/** Path segments that say nothing about what a file does. */
const PATH_NOISE = new Set([
  'src',
  'app',
  'apps',
  'lib',
  'libs',
  'main',
  'index',
  'test',
  'tests',
  'spec',
  'specs',
  'docs',
  'doc',
  'documentation',
  'util',
  'utils',
  'common',
  'shared',
  'core',
  'internal',
  'pkg',
  'cmd',
  'dist',
  'build',
  'out',
  'node_modules',
  'backend',
  'frontend',
  'server',
  'client',
  'web',
  'public',
  'static',
  'assets',
  'data',
  'tmp',
  'scripts',
  'script',
  'tests_',
]);

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'add',
  'added',
  'adding',
  'update',
  'updated',
  'fix',
  'fixed',
  'fixes',
  'change',
  'changes',
  'changed',
  'some',
  'more',
  'less',
  'new',
  'old',
  'now',
  'not',
  'all',
  'any',
  'use',
  'used',
  'using',
  'make',
  'made',
  'get',
  'got',
  'run',
  'ran',
  'set',
  'git',
  'commit',
  'api',
  'apis',
  'app',
  'json',
  'csv',
  'sql',
  'html',
  'css',
  'db',
  'log',
  'logs',
  'model',
  'models',
  'index',
  'routes',
  'route',
  'handler',
  'handlers',
  'utils',
  'wip',
  'minor',
  'misc',
  'stuff',
  'thing',
  'things',
  'idk',
  'file',
  'files',
  'code',
  'work',
  'workflow',
  'project',
  'phase',
  'final',
  'first',
  'last',
  'part',
  'version',
  'done',
  'complete',
  'completed',
  'initial',
  'readme',
  'md',
  'py',
  'js',
  'ts',
]);

const CAPABILITY_WEIGHT: Record<string, number> = {
  'auth/session': 1,
  'realtime/streaming': 0.9,
  'ml/model': 0.85,
  'graph/topology': 0.85,
  notifications: 0.8,
  'retry/errors': 0.8,
  'caching/perf': 0.75,
  'data/ingestion': 0.7,
  'storage/files': 0.6,
  'database/schema': 0.6,
  'ci/build': 0.5,
  'containers/deploy': 0.5,
  'cli/scripts': 0.45,
  'ui/frontend': 0.4,
  'logging/metrics': 0.35,
  'config/env': 0.3,
  'api/endpoints': 0.25,
  testing: 0.2,
};

const TOKEN_MIN_LENGTH = 3;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: 'Python',
  js: 'JavaScript',
  jsx: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  rb: 'Ruby',
  php: 'PHP',
  cs: 'C#',
  c: 'C',
  cc: 'C++',
  cpp: 'C++',
  h: 'C',
  sh: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  vue: 'Vue',
  svelte: 'Svelte',
  html: 'HTML',
  css: 'CSS',
};

function meaningfulTokens(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < TOKEN_MIN_LENGTH || STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** What a file *does*: `backend/api/auth/login_handler.py` → login, handler. */
export function pathRoles(file: string): string[] {
  const segments = file.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    const words = segment
      .replace(/\.[^.]+$/, '')
      .split(/[^a-zA-Z0-9]+/)
      .filter((word) => word.length >= 3);
    for (const word of words) {
      const lower = word.toLowerCase();
      if (PATH_NOISE.has(lower) || STOPWORDS.has(lower)) continue;
      if (!out.includes(lower)) out.push(lower);
    }
  }
  return out.slice(0, 14);
}

/** Which problem shapes a chunk of text and a file list belong to. */
export function capabilitiesOf(text: string, files: string[] = []): string[] {
  const haystack = `${text} ${files.map((file) => pathRoles(file).join(' ')).join(' ')}`.toLowerCase();
  const tags: string[] = [];
  for (const entry of CAPABILITIES) {
    if (entry.re.test(haystack)) tags.push(entry.tag);
  }
  return tags;
}

function parseStack(project: ProjectRow): string[] {
  return (project.stack ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function languagesOf(files: string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    const language = LANGUAGE_BY_EXTENSION[ext];
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([language]) => language);
}

function commitFiles(commit: CommitRow, limit = 6): string[] {
  return [...parseCommitFiles(commit.files)]
    .sort((a, b) => b.add + b.del - (a.add + a.del))
    .slice(0, limit)
    .map((file) => file.path);
}

/**
 * Every finished piece of work we know about, from every registered project.
 * Deliberately coarse: one unit per commit, enriched with structure.
 */
export function collectSolvedWork(db: Db, commitsPerProject = 40): SolvedWork[] {
  const out: SolvedWork[] = [];
  for (const project of listProjects(db)) {
    const stack = parseStack(project);
    for (const commit of listCommits(db, project.id, commitsPerProject)) {
      const subject = (commit.message ?? '').split('\n')[0]?.trim() ?? '';
      const files = commitFiles(commit);
      if (files.length === 0 && subject.length === 0) continue;
      const roles = files.flatMap((file) => pathRoles(file));
      const capabilities = capabilitiesOf(`${subject} ${files.join(' ')}`, files);
      out.push({
        projectId: project.id,
        projectName: project.name,
        projectPath: project.path,
        stack,
        hash: commit.hash,
        subject,
        ts: commit.ts,
        files,
        insertions: commit.insertions,
        deletions: commit.deletions,
        capabilities,
        roles: [...new Set(roles)],
        tokens: meaningfulTokens(`${subject} ${roles.join(' ')} ${files.join(' ')}`),
        languages: languagesOf(files),
      });
    }
  }
  return out;
}

/** Rare items are the informative ones; one present everywhere says nothing. */
function inverseDocumentFrequency(sets: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const set of sets) {
    for (const item of new Set(set)) df.set(item, (df.get(item) ?? 0) + 1);
  }
  const total = Math.max(1, sets.length);
  const idf = new Map<string, number>();
  for (const [item, count] of df) idf.set(item, Math.log(1 + total / count));
  return idf;
}

function sharedItems(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return [...new Set(a)].filter((item) => set.has(item));
}

/**
 * The problem you are facing right now, described structurally: taken from the
 * last few commits of a project — what they were about and which files moved.
 */
export function projectFocus(
  db: Db,
  projectId: number,
  commits = 8,
): { text: string; capabilities: string[]; roles: string[] } {
  const rows = listCommits(db, projectId, commits);
  const text = rows
    .map((row) => `${(row.message ?? '').split('\n')[0] ?? ''} ${commitFiles(row, 4).join(' ')}`)
    .join(' ');
  const files = rows.flatMap((row) => commitFiles(row, 4));
  return {
    text,
    capabilities: capabilitiesOf(text, files),
    roles: [...new Set(files.flatMap((file) => pathRoles(file)))],
  };
}

export function findPriorArt(db: Db, query: string, options: PriorArtOptions = {}): PriorArtResult {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const excluded = new Set(options.excludeProjectIds ?? []);
  const units = collectSolvedWork(db, options.commitsPerProject ?? 40).filter((unit) => {
    if (excluded.has(unit.projectId)) return false;
    if (options.projectId !== undefined && options.projectId !== null) {
      return unit.projectId === options.projectId;
    }
    return true;
  });

  const tokenIdf = inverseDocumentFrequency(units.map((unit) => unit.tokens));
  const capabilityIdf = inverseDocumentFrequency(units.map((unit) => unit.capabilities));
  const roleIdf = inverseDocumentFrequency(units.map((unit) => unit.roles));
  const queryTokens = meaningfulTokens(query);
  const queryCapabilities = options.capabilities ?? capabilitiesOf(query);
  const queryRoles = options.roles ?? pathRoles(query.replace(/\s+/g, '/').toLowerCase());
  let bestCandidateWeight = 0;

  const matches: PriorArtMatch[] = [];
  for (const unit of units) {
    const sharedCapabilities = sharedItems(queryCapabilities, unit.capabilities);
    const sharedRoles = sharedItems(queryRoles, unit.roles);
    const sharedTokens = sharedItems(queryTokens, unit.tokens);
    const signals: PriorArtSignal[] = [];
    for (const capability of sharedCapabilities) {
      const weight = (CAPABILITY_WEIGHT[capability] ?? 0.5) * (capabilityIdf.get(capability) ?? 1);
      signals.push({ kind: 'capability', value: capability, weight });
    }
    for (const role of sharedRoles.slice(0, 3)) {
      signals.push({ kind: 'role', value: role, weight: Math.min(roleIdf.get(role) ?? 0.5, 0.8) });
    }
    for (const token of sharedTokens.slice(0, 4)) {
      signals.push({ kind: 'word', value: token, weight: Math.min(tokenIdf.get(token) ?? 0, 2) });
    }
    signals.sort((a, b) => b.weight - a.weight);
    let score = signals.reduce((sum, signal) => sum + signal.weight, 0);
    if (sharedCapabilities.length >= 2) score += 0.4; // a whole problem shape
    const sameStack = unit.languages.some((language) => query.toLowerCase().includes(language.toLowerCase()));
    if (sameStack) score += 0.3;
    if (score > bestCandidateWeight) bestCandidateWeight = score;
    // Roles and words can only rank a candidate; they cannot make one, and a
    // capability only counts when it is both specific and rare. Two files
    // called api.py are a coincidence, not shared knowledge.
    const informative = signals.some(
      (signal) => signal.kind === 'capability' && signal.weight >= 0.5,
    );
    if (score < minScore || !informative) continue;
    matches.push({
      projectId: unit.projectId,
      projectName: unit.projectName,
      projectPath: unit.projectPath,
      hash: unit.hash,
      subject: unit.subject,
      ts: unit.ts,
      files: unit.files,
      insertions: unit.insertions,
      deletions: unit.deletions,
      stack: unit.stack,
      score: Math.round(score * 100) / 100,
      signals: signals.slice(0, 4),
      sharedCapabilities,
      sharedRoles: sharedRoles.slice(0, 4),
      sharedTokens: sharedTokens.slice(0, 5),
      sameStack,
    });
  }

  matches.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return {
    query: {
      text: query,
      projectId: options.projectId ?? null,
      capabilities: queryCapabilities,
      roles: queryRoles,
    },
    matches: matches.slice(0, limit),
    candidates: units.length,
    projectsSearched: new Set(units.map((unit) => unit.projectId)).size,
    bestCandidateWeight: Math.round(bestCandidateWeight * 100) / 100,
  };
}

export interface CrossProjectLink {
  fromProjectId: number;
  fromProjectName: string;
  toProjectId: number;
  toProjectName: string;
  matches: PriorArtMatch[];
}

/**
 * The cross-project view: for every registered project, what it could learn
 * from the others. This is the shape of a periodic job — one pass over the DB,
 * no model, no network.
 */
export function crossProjectLinks(
  db: Db,
  options: { minScore?: number; perPair?: number } = {},
): CrossProjectLink[] {
  const projects = listProjects(db);
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const perPair = options.perPair ?? 3;
  const links: CrossProjectLink[] = [];

  for (const project of projects) {
    const focus = projectFocus(db, project.id);
    if (focus.capabilities.length === 0 && focus.roles.length === 0) continue;
    const result = findPriorArt(db, focus.text, {
      excludeProjectIds: [project.id],
      capabilities: focus.capabilities,
      roles: focus.roles,
      minScore,
      limit: 40,
    });
    const byProject = new Map<number, PriorArtMatch[]>();
    for (const match of result.matches) {
      const list = byProject.get(match.projectId) ?? [];
      if (list.length < perPair) list.push(match);
      byProject.set(match.projectId, list);
    }
    for (const [toProjectId, matches] of byProject) {
      const target = matches[0];
      if (!target) continue;
      links.push({
        fromProjectId: project.id,
        fromProjectName: project.name,
        toProjectId,
        toProjectName: target.projectName,
        matches,
      });
    }
  }

  return links.sort(
    (a, b) =>
      (b.matches[0]?.score ?? 0) - (a.matches[0]?.score ?? 0) ||
      a.fromProjectName.localeCompare(b.fromProjectName),
  );
}

/**
 * One-line human summary of why a match matched. Capabilities lead, because a
 * shared problem shape is the claim being made; shared words only ever rank.
 */
export function explainMatch(match: PriorArtMatch): string {
  const order: Array<PriorArtSignal['kind']> = ['capability', 'role', 'word'];
  const reasons: string[] = [];
  for (const kind of order) {
    for (const signal of match.signals) {
      if (signal.kind !== kind) continue;
      if (signal.weight < 0.5) continue; // filler evidence, not a reason
      if (kind === 'word' && match.sharedCapabilities.length > 0) continue;
      if (kind === 'capability') reasons.push(`same kind of problem: ${signal.value}`);
      else if (kind === 'role') reasons.push(`same role in the code: ${signal.value}`);
      else reasons.push(`shared word: ${signal.value}`);
      if (reasons.length >= 3) break;
    }
    if (reasons.length >= 3) break;
  }
  if (match.sameStack && reasons.length < 3) reasons.push('same language');
  return reasons.join(' · ');
}
