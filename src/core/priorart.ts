import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { countCommits, listCommits, parseCommitFiles } from './commits.js';
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

export interface RelatedProject {
  projectId: number;
  projectName: string;
  projectPath: string;
  summary: string;
  stack: string[];
  commits: number;
  lastActivity: number | null;
  score: number;
  /** Specific problem shapes both project documents are about. */
  sharedCapabilities: string[];
  sharedWords: string[];
  sameStack: boolean;
  /** The concrete ideas in common, each pointed at where it lives over there. */
  sharedConcepts: SharedConcept[];
  /** The root-level "why these two are the same": a headline plus its evidence. */
  relation: RelationNarrative;
}

/**
 * What is actually inside a file over there: the reusable pieces, not just its
 * name. Read from the working tree, so it reflects the code right now.
 */
export interface ConceptFile {
  path: string;
  exists: boolean;
  language: string | null;
  lines: number;
  /** Top-level definitions — the things you would actually lift. */
  symbols: string[];
  /** First docstring or comment line, when the file explains itself. */
  doc: string | null;
}

/**
 * One concrete thing two projects have in common — not "same kind of project"
 * but "you describe a Bloom filter, and that repo already has
 * `backend/realtime/bloom_filter.py`, which defines BloomFilter and add".
 */
export interface SharedConcept {
  /** The overlapping idea, e.g. "classification", "graph", "bloom filter". */
  term: string;
  /** The best file in the *other* project to look at first. */
  file: string | null;
  /** Every file over there that carries the idea, best first, with contents. */
  files: ConceptFile[];
  /** How *your* document phrased this idea, quoted from the README. */
  yours: string | null;
  /** `code` when found in that project's commits, `doc` when only in its README. */
  source: 'code' | 'doc';
}

/** One line of proof for the relation headline. */
export interface RelationEvidence {
  idea: string;
  /** The sentence your own document used for this idea. */
  yours: string | null;
  /** Where it already exists over there, and what is inside each file. */
  files: ConceptFile[];
  source: 'code' | 'doc';
}

/**
 * The theory of why two projects are related, phrased the way the brief phrases
 * a project's state: a claim first, then the facts that back it.
 */
export interface RelationNarrative {
  /** What the two projects have in common at root level, in one sentence. */
  headline: string;
  evidence: RelationEvidence[];
}

export interface RelatedProjectsOptions {
  limit?: number;
  minScore?: number;
  excludeProjectIds?: number[];
}

export interface RelatedProjectsResult {
  matches: RelatedProject[];
  /** How many other projects had a document worth comparing. */
  considered: number;
  /** Best score that fell below the floor, so "no match" can be argued with. */
  bestCandidateScore: number;
}

/**
 * The descriptive half of a project's overview document: its summary line plus
 * the README body. The stored document also carries a generated header (path,
 * layout, languages, recent commits) that is near-identical for every project,
 * so keeping it would make any two projects look alike.
 */
function overviewBody(text: string): string {
  const summary = /\nsummary:\s*([^\n]+)/.exec(text)?.[1] ?? '';
  const readme = /\nREADME:\s*\n?([\s\S]*)$/.exec(text);
  const body = readme ? (readme[1] ?? '') : text;
  return `${summary}\n${body}`.trim();
}

/** The project overview document (README, stack, layout) as indexed at register time. */
function projectOverviewText(db: Db, project: ProjectRow): string {
  const row = db
    .prepare("SELECT text FROM search_docs WHERE owner_type = 'project' AND owner_id = ?")
    .get(project.id) as { text: string } | undefined;
  if (row && row.text.trim().length > 0) return overviewBody(row.text);
  return `${project.summary ?? ''} ${project.stack ?? ''} ${project.name}`.trim();
}

/**
 * Words that appear in the overview of almost every project, so "we both say
 * platform and system" is not a similarity worth printing.
 */
const CONCEPT_NOISE = new Set([
  'platform',
  'system',
  'systems',
  'project',
  'document',
  'documents',
  'purpose',
  'status',
  'prd',
  'version',
  'draft',
  'overview',
  'section',
  'table',
  'requirements',
  'feature',
  'features',
  'data',
  'big',
  'time',
  'real',
  'new',
  'current',
  'existing',
  'include',
  'includes',
  'including',
  'provide',
  'provides',
  'support',
  'supports',
  'allow',
  'allows',
  'ensure',
  'need',
  'needs',
  'must',
  'should',
  'make',
  'makes',
  'across',
  'within',
  'through',
  'between',
  'other',
  'each',
  'also',
  'such',
]);

/**
 * Does `term` from one document name `token` from another project's code?
 * Exact match always counts; a shared prefix catches morphology the way a human
 * would read it (`classification` ↔ `classifier`, `detection` ↔ `detector`)
 * without letting short words like `ml` match by accident.
 */
function conceptMatches(term: string, token: string): boolean {
  if (token === term) return true;
  if (term.length < 4) return false;
  return token.startsWith(term.slice(0, 5));
}

/** The README-style file listed in a project's stored layout, for attribution. */
function projectDocFile(db: Db, projectId: number): string {
  const row = db
    .prepare("SELECT text FROM search_docs WHERE owner_type = 'project' AND owner_id = ?")
    .get(projectId) as { text: string } | undefined;
  const layout = row ? /\nlayout:\s*([^\n]+)/.exec(row.text)?.[1] : '';
  if (layout) {
    const entries = layout.split(',').map((entry) => entry.trim());
    const readme = entries.find((entry) => /readme/i.test(entry));
    if (readme) return readme;
  }
  return 'README.md';
}

interface FileEvidence {
  file: string;
  /** Words in the file's own name — the only thing that can attribute a concept. */
  pathTokens: string[];
  /** Words from the commit subject, which only ever strengthen a path match. */
  subjectTokens: string[];
}

/**
 * What a project's code actually mentions: the words in the paths and subjects
 * of its commits. This is what turns "we both use the word graph" into "see
 * backend/graph/graph_analytics.py".
 */
function codeFootprint(db: Db, projectId: number, commits = 80): FileEvidence[] {
  const seen = new Set<string>();
  const out: FileEvidence[] = [];
  for (const commit of listCommits(db, projectId, commits)) {
    const subject = (commit.message ?? '').split('\n')[0] ?? '';
    const subjectTokens = meaningfulTokens(subject);
    for (const file of parseCommitFiles(commit.files)) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      const basename = file.path.split('/').pop() ?? file.path;
      out.push({
        file: file.path,
        // The file's own name is what we point at.
        pathTokens: [...new Set([...pathRoles(basename), ...pathRoles(file.path)])],
        subjectTokens: subjectTokens.filter((token) => !pathRoles(basename).includes(token)),
      });
    }
  }
  return out;
}

/**
 * Where a term shows up in another project, best file first. Only a file's own
 * name can claim a concept; a commit subject that merely mentions the word is
 * not evidence that *that* file implements it, so it never invents a claim.
 */
function locateConceptFiles(term: string, evidence: FileEvidence[], limit = 3): string[] {
  const scored: Array<{ file: string; score: number; order: number }> = [];
  evidence.forEach((entry, order) => {
    const pathHit = entry.pathTokens.some((token) => conceptMatches(term, token));
    if (!pathHit) return;
    const basenameHit = pathRoles(entry.file.split('/').pop() ?? entry.file).some((token) =>
      conceptMatches(term, token),
    );
    const score =
      (basenameHit ? 2 : 1) + (entry.subjectTokens.some((token) => conceptMatches(term, token)) ? 1 : 0);
    scored.push({ file: entry.file, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((entry) => entry.file);
}

/** Definitions a reader could actually lift out of a file. */
function symbolsOf(text: string, extension: string): string[] {
  const python = extension === 'py';
  const pattern = python
    ? /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/
    : /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|def)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const match = pattern.exec(line);
    const name = match?.[1];
    // Dunder methods are boilerplate, not something you would lift out.
    if (name && !/^__.*__$/.test(name) && !out.includes(name)) out.push(name);
    if (out.length >= 6) break;
  }
  return out;
}

/** The file's own explanation of itself, if it has one near the top. */
function leadingDoc(text: string): string | null {
  // Allow a shebang or licence header above the module docstring.
  const docstring = /^[ \t]*(?:"""|''')\s*([^\n]+)/m.exec(text)?.[1];
  if (docstring) {
    const cleaned = docstring.replace(/("""|''')$/, '').trim();
    if (cleaned.length > 0) return cleaned;
  }
  for (const line of text.split('\n').slice(0, 12)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#!')) continue; // shebang, not a description
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      const cleaned = trimmed.replace(/^[#/]+\s*/, '').trim();
      if (cleaned.length > 1 && !/^[=*-]+$/.test(cleaned) && !/^\//.test(cleaned)) return cleaned;
    }
  }
  return null;
}

/** Refuse anything that tries to climb out of the project directory. */
function safeJoin(root: string, relative: string): string | null {
  const cleaned = relative.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.length === 0 || cleaned.includes('..')) return null;
  return path.join(root, ...cleaned.split('/'));
}

/**
 * Read one file from another project and report the reusable parts: what it
 * defines, how big it is, and what it says it does. Read-only, and never more
 * than a bounded slice, so a huge generated file cannot stall a UI request.
 */
export function inspectFile(projectPath: string, relative: string): ConceptFile {
  const extension = relative.split('.').pop()?.toLowerCase() ?? '';
  const language = LANGUAGE_BY_EXTENSION[extension] ?? null;
  const base: ConceptFile = { path: relative, exists: false, language, lines: 0, symbols: [], doc: null };
  const absolute = safeJoin(projectPath, relative);
  if (!absolute) return base;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 512 * 1024) return { ...base, exists: true };
    const text = fs.readFileSync(absolute, 'utf8');
    const lines = text.split('\n').length;
    return { ...base, exists: true, lines, symbols: symbolsOf(text, extension), doc: leadingDoc(text) };
  } catch {
    return base;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The sentence the document itself used around an idea — quoted back so the
 * user sees *their* words as the thing that matched, not our keyword. The quote
 * is trimmed to one sentence so it never runs into a heading or a table.
 */
function quoteFor(text: string, term: string, maxLength = 190): string | null {
  const words = term.split(' ').filter((word) => word.length > 0).map(escapeRegExp);
  if (words.length === 0) return null;
  const match = new RegExp(words.join('[^a-z0-9]+'), 'i').exec(text);
  if (!match) return null;
  const boundaries = ['\n', '. ', '! ', '? ', '; '];
  const from = match.index;
  const to = from + match[0].length;
  let start = 0;
  let end = text.length;
  for (const boundary of boundaries) {
    const before = text.lastIndexOf(boundary, from);
    if (before >= 0) start = Math.max(start, before + boundary.length);
    const after = text.indexOf(boundary, to);
    if (after >= 0) end = Math.min(end, after + (boundary === '\n' ? 0 : 1));
  }
  const sentence = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (sentence.length === 0) return null;
  if (sentence.length <= maxLength) return sentence;
  // Some READMEs are one wall of text with no sentence breaks. Rather than
  // repeat the whole paragraph for every idea, quote the neighbourhood of the
  // match, snapped to whole words on both sides.
  const windowStart = Math.max(start, from - 55);
  const windowEnd = Math.min(end, to + 85);
  let window = text.slice(windowStart, windowEnd).replace(/\s+/g, ' ').trim();
  if (windowStart > start) window = window.replace(/^\S+\s+/, '');
  if (windowEnd < end) window = window.replace(/\s+\S+$/, '');
  if (window.length > maxLength) window = `${window.slice(0, maxLength).trim()}…`;
  return `${windowStart > start ? '…' : ''}${window}${windowEnd < end ? '…' : ''}`;
}

/** Human phrasing for a shared capability, so the headline reads like a claim. */
const CAPABILITY_PHRASE: Record<string, string> = {
  'graph/topology': 'model relationships as a graph',
  'ml/model': 'train or run models over the data',
  'caching/perf': 'optimise hot paths with caching',
  'realtime/streaming': 'process a live stream of events',
  'data/ingestion': 'ingest and process data at volume',
  'ui/frontend': 'visualise results on a dashboard',
  'auth/session': 'handle authentication and sessions',
  'database/schema': 'own a schema and migrations',
  'containers/deploy': 'ship as containers',
  'retry/errors': 'guard against failures with retries and limits',
  notifications: 'notify people about findings',
  'storage/files': 'store and export files',
  'cli/scripts': 'run from scripts and the command line',
  'logging/metrics': 'emit logs and metrics',
  'config/env': 'read configuration from the environment',
  'api/endpoints': 'expose an API',
  testing: 'carry a test suite',
};

function listPhrase(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/**
 * The root-level relation between two projects, in the brief's voice: one claim
 * about what they both are, then the concrete evidence for it.
 */
export function relationNarrative(
  sourceName: string,
  otherName: string,
  capabilities: string[],
  concepts: SharedConcept[],
): RelationNarrative {
  const phrases = capabilities
    .filter((tag) => CAPABILITY_PHRASE[tag] !== undefined)
    .sort((a, b) => (CAPABILITY_WEIGHT[b] ?? 0.5) - (CAPABILITY_WEIGHT[a] ?? 0.5))
    .slice(0, 4)
    .map((tag) => CAPABILITY_PHRASE[tag] as string);
  const headline =
    phrases.length === 0
      ? `${sourceName} and ${otherName} read like the same kind of system.`
      : `${sourceName} and ${otherName} are the same shape of system: both ${listPhrase(phrases)}.`;
  return {
    headline,
    evidence: concepts.map((concept) => ({
      idea: concept.term,
      yours: concept.yours,
      files: concept.files,
      source: concept.source,
    })),
  };
}

/**
 * The document's content words in reading order, duplicates kept — adjacency is
 * what lets "Bloom Filter" stay one idea instead of two loose words.
 */
function orderedTerms(text: string): string[] {
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < 3 || STOPWORDS.has(token) || CONCEPT_NOISE.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * The concepts a project's own document shares with another project — matched
 * against that project's code when it has any, and against its README when it
 * does not. Ranked so the most specific, least generic idea comes first.
 */
function conceptsBetween(
  sourceDoc: string,
  otherDoc: string,
  otherPath: string,
  otherEvidence: FileEvidence[],
  otherDocFile: string,
  wordIdf: Map<string, number>,
): SharedConcept[] {
  const sourceTerms = meaningfulTokens(sourceDoc).filter(
    (term) => term.length >= 3 && !CONCEPT_NOISE.has(term),
  );
  const otherTerms = new Set(meaningfulTokens(otherDoc));
  const pathTokens = new Set(otherEvidence.flatMap((entry) => entry.pathTokens));
  const out: Array<{ concept: SharedConcept; weight: number }> = [];
  for (const term of sourceTerms) {
    const located = otherEvidence.length > 0 ? locateConceptFiles(term, otherEvidence) : [];
    const yours = quoteFor(sourceDoc, term);
    let concept: SharedConcept | null = null;
    if (located.length > 0) {
      const files = located.map((file) => inspectFile(otherPath, file));
      concept = { term, file: located[0] ?? null, files, yours, source: 'code' };
    } else if (otherEvidence.length === 0 && otherTerms.has(term)) {
      concept = {
        term,
        file: otherDocFile,
        files: [inspectFile(otherPath, otherDocFile)],
        yours,
        source: 'doc',
      };
    }
    if (!concept) continue;
    const rarity = wordIdf.get(term) ?? 1;
    // A file that names the word outright (graph → graph_analytics.py) is much
    // stronger evidence than one that merely shares a stem (detection →
    // detector), and a longer word names something more specific than a short
    // one, so both shape the ranking without either dominating.
    const exact = pathTokens.has(term) || (otherEvidence.length === 0 && otherTerms.has(term));
    const weight =
      rarity * (1 + Math.min(term.length, 12) / 24) * (exact ? 2.5 : 1) +
      (concept.source === 'code' ? 0.3 : 0);
    out.push({ concept, weight });
  }
  out.sort((a, b) => b.weight - a.weight || a.concept.term.localeCompare(b.concept.term));
  const byTerm = new Map(out.map((entry) => [entry.concept.term, entry]));

  // "bloom" and "filter" that both live in bloom_filter.py are one idea, and the
  // document already wrote them as one, so say it back as "bloom filter".
  const sequence = orderedTerms(sourceDoc);
  const phrases: Array<{ concept: SharedConcept; weight: number }> = [];
  const consumed = new Set<string>();
  for (let i = 0; i + 1 < sequence.length; i++) {
    const left = sequence[i] as string;
    const right = sequence[i + 1] as string;
    const a = byTerm.get(left);
    const b = byTerm.get(right);
    if (!a || !b || a.concept.file === null || a.concept.file !== b.concept.file) continue;
    if (consumed.has(left) || consumed.has(right)) continue;
    consumed.add(left);
    consumed.add(right);
    phrases.push({
      concept: {
        term: `${left} ${right}`,
        file: a.concept.file,
        files: [
          ...new Map(
            [...a.concept.files, ...b.concept.files].map((file) => [file.path, file]),
          ).values(),
        ],
        yours: quoteFor(sourceDoc, `${left} ${right}`) ?? a.concept.yours,
        source: a.concept.source,
      },
      weight: Math.max(a.weight, b.weight) + 0.4,
    });
    i++;
  }

  const ranked = [...phrases, ...out.filter((entry) => !consumed.has(entry.concept.term))].sort(
    (a, b) => b.weight - a.weight || a.concept.term.localeCompare(b.concept.term),
  );
  const seenStems = new Set<string>();
  const seenFiles = new Set<string>();
  const concepts: SharedConcept[] = [];
  for (const entry of ranked) {
    // `process`/`processing` and `analysis`/`analytics` are one idea, and two
    // words from the same file describe the same code, so keep the best of each.
    const stem = entry.concept.term.length <= 5 ? entry.concept.term : entry.concept.term.slice(0, 5);
    if (seenStems.has(stem)) continue;
    // Two words from one real file describe that file once; the README fallback
    // is a single file for every concept, so it must not collapse them all.
    if (entry.concept.source === 'code' && entry.concept.file !== null) {
      if (seenFiles.has(entry.concept.file)) continue;
      seenFiles.add(entry.concept.file);
    }
    seenStems.add(stem);
    concepts.push(entry.concept);
    if (concepts.length >= 6) break;
  }
  return concepts;
}

/**
 * "These two projects are about the same thing."
 *
 * Related work matches *commits*; this matches *project documents*. A project
 * you only just registered has a README but no commits, so the commit matcher
 * has nothing to say about it — yet two fraud/threat analytics repos that read
 * alike are exactly the pair worth connecting. Reads the overview document
 * stored at register time, weights rare words and specific capabilities, names
 * the concrete ideas in common, and points each one at the file it lives in.
 */
export function findRelatedProjects(
  db: Db,
  projectId: number,
  options: RelatedProjectsOptions = {},
): RelatedProjectsResult {
  const limit = options.limit ?? 6;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const projects = listProjects(db);
  const target = projects.find((project) => project.id === projectId) ?? null;
  if (!target) return { matches: [], considered: 0, bestCandidateScore: 0 };

  const excluded = new Set([projectId, ...(options.excludeProjectIds ?? [])]);
  const docs = projects.map((project) => {
    const text = projectOverviewText(db, project);
    return { project, text, capabilities: capabilitiesOf(text), tokens: meaningfulTokens(text) };
  });
  const targetDoc = docs.find((doc) => doc.project.id === projectId) ?? null;
  if (!targetDoc) return { matches: [], considered: 0, bestCandidateScore: 0 };

  const capabilityIdf = inverseDocumentFrequency(docs.map((doc) => doc.capabilities));
  const wordIdf = inverseDocumentFrequency(docs.map((doc) => doc.tokens));
  const targetStack = parseStack(target);
  const footprintCache = new Map<number, FileEvidence[]>();
  const docFileCache = new Map<number, string>();
  const footprintOf = (id: number): FileEvidence[] => {
    const cached = footprintCache.get(id);
    if (cached) return cached;
    const built = codeFootprint(db, id);
    footprintCache.set(id, built);
    return built;
  };
  const docFileOf = (id: number): string => {
    const cached = docFileCache.get(id);
    if (cached) return cached;
    const built = projectDocFile(db, id);
    docFileCache.set(id, built);
    return built;
  };
  let bestCandidateScore = 0;
  const matches: RelatedProject[] = [];

  for (const doc of docs) {
    if (excluded.has(doc.project.id)) continue;
    const sharedCapabilities = sharedItems(targetDoc.capabilities, doc.capabilities);
    const sharedWords = sharedItems(targetDoc.tokens, doc.tokens);
    const capabilitySignals = sharedCapabilities.map(
      (tag) => (CAPABILITY_WEIGHT[tag] ?? 0.5) * (capabilityIdf.get(tag) ?? 1),
    );
    const wordSignals = sharedWords.map((word) => Math.min(wordIdf.get(word) ?? 0, 2));
    let score = capabilitySignals.reduce((sum, weight) => sum + weight, 0);
    // Words rank a pair; they never let boilerplate carry one on its own.
    score += Math.min(
      wordSignals.reduce((sum, weight) => sum + weight, 0),
      3,
    );
    if (sharedCapabilities.length >= 2) score += 0.4;
    const sameStack =
      targetStack.length > 0 && parseStack(doc.project).some((entry) => targetStack.includes(entry));
    if (sameStack) score += 0.3;
    if (score > bestCandidateScore) bestCandidateScore = score;
    const rareWords = sharedWords.filter((word) => (wordIdf.get(word) ?? 0) >= 1.2);
    const informative =
      capabilitySignals.some((weight) => weight >= 0.5) || rareWords.length >= 2;
    if (score < minScore || !informative) continue;
    const sharedConcepts = conceptsBetween(
      targetDoc.text,
      doc.text,
      doc.project.path,
      footprintOf(doc.project.id),
      docFileOf(doc.project.id),
      wordIdf,
    );
    matches.push({
      projectId: doc.project.id,
      projectName: doc.project.name,
      projectPath: doc.project.path,
      summary: doc.project.summary ?? '',
      stack: parseStack(doc.project),
      commits: countCommits(db, doc.project.id),
      lastActivity: doc.project.last_seen_at,
      score: Math.round(score * 100) / 100,
      sharedCapabilities,
      sharedWords,
      sameStack,
      sharedConcepts,
      relation: relationNarrative(target.name, doc.project.name, sharedCapabilities, sharedConcepts),
    });
  }

  matches.sort((a, b) => b.score - a.score || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  return {
    matches: matches.slice(0, limit),
    considered: docs.filter((doc) => !excluded.has(doc.project.id)).length,
    bestCandidateScore: Math.round(bestCandidateScore * 100) / 100,
  };
}

/** One-line reason a pair of projects are related, strongest evidence first. */
export function explainProjectMatch(match: RelatedProject): string {
  const reasons: string[] = [];
  if (match.sharedConcepts.length > 0) {
    reasons.push(`same ground: ${match.sharedConcepts.slice(0, 4).map((c) => c.term).join(', ')}`);
  }
  if (match.sharedCapabilities.length > 0) {
    reasons.push(`same kind of project: ${match.sharedCapabilities.slice(0, 3).join(', ')}`);
  }
  if (match.sameStack && reasons.length < 3) reasons.push('same stack');
  return reasons.join(' · ');
}

/**
 * "Where would I look in the other project for this?" — the concept plus the
 * file it was found in, ready to print. Falls back to the concept alone.
 */
export function explainConcept(concept: SharedConcept): string {
  if (concept.files.length === 0) return concept.term;
  const where = concept.files.map((file) => file.path).join(', ');
  return concept.source === 'code' ? `${concept.term} — ${where}` : `${concept.term} — ${where} (README)`;
}

/** "backend/realtime/bloom_filter.py — Python, 96 lines · defines BloomFilter" */
export function explainFile(file: ConceptFile): string {
  if (!file.exists) return `${file.path} — not on disk any more (moved or deleted since that commit)`;
  if (file.language === null) return `${file.path} — ${file.lines} lines`;
  const bits: string[] = [`${file.language}, ${file.lines} lines`];
  if (file.symbols.length > 0) bits.push(`defines ${file.symbols.join(', ')}`);
  if (file.doc) bits.push(`"${file.doc}"`);
  return `${file.path} — ${bits.join(' · ')}`;
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
