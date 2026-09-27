import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import type { BrainConfig } from '../config.js';
import { createOllamaLlm } from '../llm/ollama.js';
import { hasOllamaModel, listOllamaModels, resolveOllamaModel } from '../embeddings/embedder.js';
import { countCommits, listCommits } from '../core/commits.js';
import type { ProjectRow } from '../core/types.js';
import { git } from '../git/git.js';
import { detectStack, detectTestCommand } from './stack.js';

/**
 * A readable profile of a project, built from what is on disk plus what has been
 * captured. It is used three ways:
 *  - stored on the project row (`stack`, `summary`) so listings and briefs can
 *    show it without re-scanning the disk,
 *  - indexed as a recall document, so "what does this project do" returns
 *    something better than the vaguest commit message,
 *  - rendered in `brain brief`, `brain projects` and the local UI.
 */
export interface ProjectProfile {
  name: string;
  path: string;
  summary: string;
  stack: string[];
  languages: Array<{ language: string; files: number }>;
  gitRemote: string | null;
  branch: string | null;
  isGitRepo: boolean;
  topLevel: Array<{ name: string; kind: 'dir' | 'file' }>;
  entryPoints: string[];
  readme: string | null;
  readmeFile: string | null;
  testCommand: string | null;
  commits: number;
  lastCommit: { hash: string; message: string; ts: number } | null;
  /** Indexable text handed to the lexical + vector index. */
  doc: string;
  /**
   * Purpose written by the local model from source evidence, when the heuristics
   * could only produce a generic summary. Null when never attempted or refused.
   */
  purposeSummary: string | null;
  /** Files the derived purpose was grounded in, for display and provenance. */
  purposeBasis: string[];
  /** Why no purpose could be derived, when one was attempted. */
  purposeReason: string | null;
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  pyi: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  rb: 'Ruby',
  php: 'PHP',
  cs: 'C#',
  c: 'C',
  h: 'C',
  cc: 'C++',
  cpp: 'C++',
  hpp: 'C++',
  swift: 'Swift',
  dart: 'Dart',
  sh: 'Shell',
  bash: 'Shell',
  ps1: 'PowerShell',
  psm1: 'PowerShell',
  sql: 'SQL',
  md: 'Markdown',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  ipynb: 'Notebook',
  vue: 'Vue',
  svelte: 'Svelte',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  r: 'R',
  scala: 'Scala',
  ex: 'Elixir',
  exs: 'Elixir',
  lua: 'Lua',
  hs: 'Haskell',
  jl: 'Julia',
  gradle: 'Gradle',
  tf: 'Terraform',
};

const NOISE_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.idea',
  '.vscode',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'coverage',
  '.terraform',
  '.gradle',
  'obj',
  'bin',
  'vendor',
  '.cache',
  '.tox',
  'site-packages',
]);

const ENTRY_POINT_CANDIDATES = [
  'main.py',
  'app.py',
  '__main__.py',
  'manage.py',
  'src/main.py',
  'app/main.py',
  'src/app.py',
  'index.js',
  'index.ts',
  'src/index.ts',
  'src/index.js',
  'src/main.ts',
  'server.js',
  'server.ts',
  'main.go',
  'cmd/main.go',
  'src/main.rs',
  'main.rs',
  'lib.rs',
  'Program.cs',
  'App.js',
  'App.tsx',
  'src/App.tsx',
  'index.php',
  'main.cpp',
];

const README_CANDIDATES = ['README.md', 'readme.md', 'Readme.md', 'README.rst', 'README.txt', 'README'];

/**
 * How much source the purpose-writer is allowed to read, and how much of what
 * it reads may reach the prompt. Bounded on purpose: the whole point is to let
 * a small local model characterize a repo it could never ingest whole.
 */
const PURPOSE_SNIPPET_LIMIT = 26;
const PURPOSE_SNIPPET_CHARS = 240;
const PURPOSE_PROMPT_CHARS = 3500;

/**
 * Purpose-bearing statements live at module scope: docstrings, header comments
 * and the top of the file. Long or deep-nested code is noise for this reader.
 */
const PURPOSE_FILE_CANDIDATES = [
  'app.py', 'main.py', 'manage.py', 'wsgi.py', 'index.js', 'index.ts', 'index.jsx', 'index.tsx',
  'main.js', 'main.ts', 'server.js', 'server.ts', 'app.js', 'app.ts', 'app.tsx', 'App.tsx',
  'cli.js', 'cli.ts', 'main.go', 'main.rs', 'lib.rs', 'Program.cs',
];

/** Extensions worth a header read. */
const PURPOSE_SOURCE_EXTS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.rb', '.php', '.java', '.kt', '.cs',
]);

/** Folders that never say what a project is for, plus generated outputs. */
const PURPOSE_SKIP_DIRS = new Set([
  ...NOISE_DIRS,
  'tests', 'test', '__tests__', 'spec', 'docs', 'doc', 'examples', 'example',
  'benchmarks', 'migrations', 'scripts', 'setup', 'assets', 'public', 'locales',
]);

/**
 * Raw material for deriving what a repo is for when no README says it: the
 * project manifest (name/description/scripts, the strongest signal there is)
 * plus the heads of the most plausibly central source files.
 */
export interface PurposeEvidence {
  manifest: string | null;
  snippets: Array<{ file: string; head: string }>;
  rendered: string | null;
}

/** package.json / pyproject.toml / Cargo.toml, compacted to the useful lines. */
export function readManifestSignal(projectPath: string): string | null {
  const tryJson = (): string | null => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')) as {
        name?: string;
        description?: string;
        bin?: unknown;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const bits: string[] = [];
      if (parsed.name) bits.push(`name: ${parsed.name}`);
      if (parsed.description) bits.push(`description: ${parsed.description}`);
      if (parsed.bin) bits.push(`command-line entry: ${Object.keys(parsed.bin).join(', ')}`);
      if (parsed.scripts?.start) bits.push(`start script: ${parsed.scripts.start}`);
      if (parsed.scripts?.dev) bits.push(`dev script: ${parsed.scripts.dev}`);
      if (parsed.dependencies) {
        const deps = Object.keys(parsed.dependencies).filter((dep) => !dep.startsWith('@types/')).slice(0, 15);
        if (deps.length > 0) bits.push(`key dependencies: ${deps.join(', ')}`);
      }
      return bits.length > 0 ? bits.join('\n') : null;
    } catch {
      return null;
    }
  };
  const json = tryJson();
  if (json) return json;
  const pyproject = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    try {
      const lines = fs
        .readFileSync(pyproject, 'utf8')
        .split('\n')
        .filter((line) => /^(name|description|version)\s*=|^dependencies\s*=|^\s*"[a-z]/i.test(line))
        .slice(0, 12);
      if (lines.length > 0) return ['pyproject.toml:', ...lines].join('\n');
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Signal inside a file that says what it does when the header does not:
 * argparse descriptions, Flask/CLI route registrations, and stored procs.
 * Matched against the first chunk of the file to keep the walk bounded.
 */
const FILE_SIGNAL_RE =
  /(?:argparse\.ArgumentParser\(\s*description=["']([^"']{10,140})["'])|(?:@(?:app|bp)\.route\(["']([^"']{4,80})["'])|(?:CREATE TABLE (?:IF NOT EXISTS )?(\w+))/;

/**
 * The first meaningful prose of a source file — module docstring or header
 * comment — which is where authors explain what the file does. Falls back to
 * inline signals (argparse descriptions, route registrations, SQL schemas)
 * because real code often opens straight into imports. Returns null when the
 * file yields nothing purpose-bearing.
 */
export function sourceHeadProse(full: string): string | null {
  let raw = '';
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  const prose: string[] = [];
  for (const line of lines.slice(0, 60)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (prose.length > 0) break;
      continue;
    }
    // One-line comments and Python module docstrings.
    const comment = /^(?:\/\/|#|\*)\s*(.+)$/.exec(trimmed);
    if (comment && comment[1] && /[a-zA-Z]/.test(comment[1]) && comment[1].length > 12) {
      prose.push(comment[1]);
      continue;
    }
    const block = /^\/\*\*?\s*(.+?)\s*(?:\*\/)?$/.exec(trimmed);
    if (block && block[1] && block[1].length > 12 && !/^[*@]/.test(block[1])) {
      prose.push(block[1]);
      continue;
    }
    const docstring = /^(?:\"\"\"|''')(.*?)(?:\"\"\"|''')?\s*$/.exec(trimmed);
    if (docstring && docstring[1] && docstring[1].length > 12) {
      prose.push(docstring[1]);
      if (prose.length >= 3) break;
      continue;
    }
    break; // real code reached; the header is over
  }
  if (prose.length === 0) {
    // No header prose — try inline signals from the first part of the file.
    const signal = FILE_SIGNAL_RE.exec(raw.slice(0, 20_000));
    if (signal) {
      const text = (signal[1] ?? signal[2] ?? signal[3] ?? '').trim();
      if (text.length > 4) return excerpt(`defines ${text}`, PURPOSE_SNIPPET_CHARS);
    }
    return null;
  }
  return excerpt(prose.join(' '), PURPOSE_SNIPPET_CHARS);
}

/** Pick central source files, bounded, and keep the head prose of each. */
export function collectPurposeEvidence(projectPath: string, maxSnippets = PURPOSE_SNIPPET_LIMIT): PurposeEvidence {
  const manifest = readManifestSignal(projectPath);
  // The README participates even when its first line did not qualify as a
  // summary tagline: headings and bullet lists that describe the project are
  // purpose evidence for the model, just not presentable as one prose line.
  const readme = readReadmeExcerpt(projectPath, 1200);
  const manifestWithReadme =
    readme && manifest ? `${manifest}\nREADME excerpt:\n${readme.text}` : readme ? `README excerpt:\n${readme.text}` : manifest;
  const snippets: Array<{ file: string; head: string }> = [];
  const seen = new Set<string>();
  const push = (full: string, rel: string): void => {
    if (snippets.length >= maxSnippets || seen.has(rel)) return;
    seen.add(rel);
    const head = sourceHeadProse(full);
    if (head) snippets.push({ file: rel, head });
  };
  // 1. Known entry points, wherever they sit.
  for (const candidate of ENTRY_POINT_CANDIDATES) {
    if (snippets.length >= maxSnippets) break;
    const full = path.join(projectPath, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) push(full, candidate);
  }
  // 2. Bounded walk over source files. Exact-name candidates first (they are
  // the conventional centers), then everything else by name — a repo like a
  // research pipeline names its stages descriptively (data_collector.py), and
  // those names never appear on a fixed list.
  const allSource: Array<{ full: string; rel: string; priority: boolean }> = [];
  const visit = (dir: string, level: number): void => {
    if (level > 3 || allSource.length >= 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries
      .filter((entry) => !NOISE_DIRS.has(entry.name) && !PURPOSE_SKIP_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (allSource.length >= 200) return;
      const full = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(full, level + 1);
        continue;
      }
      if (!PURPOSE_SOURCE_EXTS.has(path.extname(name).toLowerCase())) continue;
      allSource.push({
        full,
        rel: path.relative(projectPath, full).replace(/\\/g, '/'),
        priority: PURPOSE_FILE_CANDIDATES.includes(name),
      });
    }
  };
  visit(projectPath, 1);
  allSource
    .sort((a, b) => Number(b.priority) - Number(a.priority) || a.rel.localeCompare(b.rel))
    .slice(0, maxSnippets * 3)
    .forEach((entry) => push(entry.full, entry.rel));
  visit(projectPath, 1);
  return { manifest: manifestWithReadme, snippets, rendered: renderPurposeEvidence({ manifest: manifestWithReadme, snippets }) };
}

/** The bounded text the purpose-writer is allowed to read. */
export function renderPurposeEvidence(
  evidence: Pick<PurposeEvidence, 'manifest' | 'snippets'>,
): string | null {
  const parts: string[] = [];
  if (evidence.manifest) parts.push(evidence.manifest);
  for (const snippet of evidence.snippets) {
    parts.push(`${snippet.file}: ${snippet.head}`);
  }
  if (parts.length === 0) return null;
  return excerpt(parts.join('\n'), PURPOSE_PROMPT_CHARS);
}

function languageFor(file: string): string | null {
  const ext = path.extname(file).replace(/^\./, '').toLowerCase();
  return EXTENSION_LANGUAGES[ext] ?? null;
}

/** Count tracked files by language. Uses git when available, else a shallow walk. */
export async function detectLanguages(projectPath: string): Promise<Array<{ language: string; files: number }>> {
  let files: string[] = [];
  const res = await git(['ls-files'], projectPath, 32 * 1024 * 1024);
  if (res.code === 0) {
    files = res.stdout.split('\n').filter((line) => line.trim().length > 0);
  } else {
    files = shallowWalk(projectPath);
  }
  const counts = new Map<string, number>();
  for (const file of files.slice(0, 20_000)) {
    const language = languageFor(file);
    if (!language) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([language, count]) => ({ language, files: count }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language))
    .slice(0, 8);
}

/** Bounded recursive listing, used when the directory is not a git repo. */
export function walkProjectFiles(root: string, depth = 3, cap = 4000): string[] {
  return shallowWalk(root, depth, cap);
}

function shallowWalk(root: string, depth = 3, cap = 4000): string[] {
  const out: string[] = [];
  const visit = (dir: string, level: number): void => {
    if (level > depth || out.length >= cap) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= cap) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (NOISE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full, level + 1);
      else out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  visit(root, 1);
  return out;
}

/** Top-level layout: directories first, then notable files. */
export function listTopLevel(projectPath: string, limit = 24): Array<{ name: string; kind: 'dir' | 'file' }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: Array<{ name: string; kind: 'dir' | 'file' }> = [];
  const files: Array<{ name: string; kind: 'dir' | 'file' }> = [];
  for (const entry of entries) {
    if (NOISE_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) dirs.push({ name: `${entry.name}/`, kind: 'dir' });
    else if (!entry.name.startsWith('.')) files.push({ name: entry.name, kind: 'file' });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files].slice(0, limit);
}

export function findReadme(projectPath: string): string | null {
  for (const candidate of README_CANDIDATES) {
    const full = path.join(projectPath, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** First meaningful paragraph of the README, cleaned for one-line display. */
export function readReadmeExcerpt(projectPath: string, maxChars = 1200): { file: string; text: string } | null {
  const file = findReadme(projectPath);
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const cleaned = raw
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return true;
        if (/^\[!\[/.test(trimmed) || /^!\[/.test(trimmed)) return false; // badges
        if (/^<p align/.test(trimmed) || /^<\/?div/.test(trimmed)) return false;
        if (/^<\/?a /.test(trimmed)) return false;
        return true;
      })
      .join('\n')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned.length === 0) return null;
    return { file: path.basename(file), text: excerpt(cleaned, maxChars) };
  } catch {
    return null;
  }
}

/**
 * Cut prose down to `maxChars` without chopping a word in half — a truncated
 * "processing for tra" reads as gibberish, and worse, it becomes a junk token
 * for cross-project matching. Prefers the last sentence that fits, then the
 * last whole word, and only then hard-cuts.
 */
export function excerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'));
  if (sentenceEnd >= maxChars * 0.5) return head.slice(0, sentenceEnd + 1).trimEnd();
  const wordEnd = head.lastIndexOf(' ');
  return wordEnd > 0 ? head.slice(0, wordEnd).trimEnd() : head;
}

export function detectEntryPoints(projectPath: string, limit = 6): string[] {
  const found: string[] = [];
  for (const candidate of ENTRY_POINT_CANDIDATES) {
    if (fs.existsSync(path.join(projectPath, candidate))) {
      found.push(candidate);
      if (found.length >= limit) break;
    }
  }
  return found;
}

/** Drop markdown emphasis/code markers so a tagline reads as plain prose. */
export function stripEmphasis(line: string): string {
  return line
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' '
    )
    .trim();
}

/** One-sentence description: README's opening prose when present, else structure. */
export function describeProject(input: {
  name: string;
  stack: string[];
  languages: Array<{ language: string; files: number }>;
  topLevel: Array<{ name: string; kind: 'dir' | 'file' }>;
  readme: string | null;
}): string {
  // READMEs usually open with a heading and then a tagline, most often written
  // as `**bold**`. Filter on the raw line (so bullets, tables, badges and
  // headings stay excluded) but *return* the emphasis-stripped text.
  const readmeLine = (input.readme ?? '')
    .split('\n')
    .map((rawLine) => ({ raw: rawLine.trim(), clean: stripEmphasis(rawLine) }))
    .find(
      ({ raw, clean }) =>
        clean.length > 24 &&
        !/^[#\-|><]/.test(raw) &&
        !raw.includes('](') &&
        !/^[=*_-]{3,}$/.test(raw) &&
        /[a-zA-Z]/.test(clean),
    );
  if (readmeLine) return excerpt(readmeLine.clean, 220);
  const dirs = input.topLevel.filter((entry) => entry.kind === 'dir').map((entry) => entry.name.replace(/\/$/, ''));
  const stack = input.stack.length > 0 ? input.stack.join(', ') : input.languages[0]?.language ?? 'unknown stack';
  const shape = dirs.length > 0 ? ` with ${dirs.slice(0, 5).join(', ')}` : '';
  // "unknown stack" starts with a vowel sound, so it reads "an unknown stack
  // project" — the same rule the state narrative applies.
  return `${input.name} — ${stack === 'unknown stack' ? 'an' : 'a'} ${stack} project${shape}.`;
}

/**
 * describeProject falls back to "Name — a Stack project with a, b, c." when no
 * README line qualifies. That records the folder layout, not the project's
 * purpose — so every surface that would otherwise read purpose into it can
 * detect the case and treat it differently.
 */
export function isGenericOverview(summary: string | null): boolean {
  if (!summary || summary.trim().length === 0) return true;
  return / — (?:a|an) .+ (?:project|service|tool|app)\b/.test(summary.trim());
}

export interface BuildProfileOptions {
  /** Commit subjects to include in the recall document. */
  recentCommits?: number;
  /**
   * The local chat model may be asked to characterize a repo that no README
   * describes. Off by default: it is an LLM call on the registration path.
   */
  useLlmPurpose?: boolean;
  config?: BrainConfig;
  /** Set when an earlier call already failed, so refreshes do not re-pay it. */
  purposeAttempted?: boolean;
}

export async function buildProjectProfile(
  db: Db,
  project: ProjectRow,
  options: BuildProfileOptions = {},
): Promise<ProjectProfile> {
  const projectPath = project.path;
  const exists = fs.existsSync(projectPath);
  const stack = exists ? detectStack(projectPath) : [];
  const languages = exists ? await detectLanguages(projectPath) : [];
  const topLevel = exists ? listTopLevel(projectPath) : [];
  const entryPoints = exists ? detectEntryPoints(projectPath) : [];
  const readme = exists ? readReadmeExcerpt(projectPath) : null;
  const testCommand = exists ? detectTestCommand(projectPath) : null;

  let gitRemote: string | null = null;
  let branch: string | null = null;
  let isGitRepo = false;
  if (exists && fs.existsSync(path.join(projectPath, '.git'))) {
    isGitRepo = true;
    const [remoteRes, branchRes] = await Promise.all([
      git(['remote', 'get-url', 'origin'], projectPath),
      git(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath),
    ]);
    gitRemote = remoteRes.code === 0 && remoteRes.stdout.trim().length > 0 ? remoteRes.stdout.trim() : null;
    branch = branchRes.code === 0 && branchRes.stdout.trim().length > 0 ? branchRes.stdout.trim() : null;
  }

  const commits = countCommits(db, project.id);
  const recent = listCommits(db, project.id, options.recentCommits ?? 10);
  const last = recent[0] ?? null;

  let summary = describeProject({ name: project.name, stack, languages, topLevel, readme: readme?.text ?? null });
  // A generic fallback summary means nothing on disk or in the record says what
  // this project is for. When a chat model is available, derive a purpose from
  // the source itself — manifest, entry-point and file-header prose — rather
  // than leaving the answer layer to guess. Once tried and failed it is not
  // retried until something asks for it explicitly.
  let purposeSummary: string | null = null;
  let purposeBasis: string[] = [];
  let purposeReason: string | null = null;
  if (!options.purposeAttempted && options.useLlmPurpose && options.config && isGenericOverview(summary)) {
    const evidence = collectPurposeEvidence(projectPath);
    if (evidence.rendered) {
      const derived = await deriveProjectPurpose(options.config, evidence, project.name);
      purposeSummary = derived.summary;
      purposeBasis = derived.basis;
      purposeReason = derived.reason;
      if (purposeSummary) summary = purposeSummary;
    } else {
      purposeReason = 'no readable source or manifest to derive a purpose from';
    }
  }

  const doc = renderProfileDoc({
    project,
    summary,
    stack,
    languages,
    gitRemote,
    branch,
    isGitRepo,
    topLevel,
    entryPoints,
    readme: readme?.text ?? null,
    testCommand,
    commits,
    lastCommit: last ? { hash: last.hash, message: last.message ?? '', ts: last.ts } : null,
    recentCommits: recent
      .slice(0, 8)
      .map((row) => `${row.hash.slice(0, 7)} ${(row.message ?? '').split('\n')[0] ?? ''}`.trim()),
  });

  return {
    name: project.name,
    path: projectPath,
    summary,
    stack,
    languages,
    gitRemote,
    branch,
    isGitRepo,
    topLevel,
    entryPoints,
    readme: readme?.text ?? null,
    readmeFile: readme?.file ?? null,
    testCommand,
    commits,
    lastCommit: last ? { hash: last.hash, message: last.message ?? '', ts: last.ts } : null,
    doc,
    purposeSummary,
    purposeBasis,
    purposeReason,
  };
}

interface DocInput {
  project: ProjectRow;
  summary: string;
  stack: string[];
  languages: Array<{ language: string; files: number }>;
  gitRemote: string | null;
  branch: string | null;
  isGitRepo: boolean;
  topLevel: Array<{ name: string; kind: 'dir' | 'file' }>;
  entryPoints: string[];
  readme: string | null;
  testCommand: string | null;
  commits: number;
  lastCommit: { hash: string; message: string; ts: number } | null;
  recentCommits: string[];
}

/**
 * No README and nothing the heuristics can carry: ask the local chat model to
 * characterize the repo from bounded source evidence, exactly the way a coding
 * agent skims a codebase — read the manifest and file headers, say the purpose,
 * cite the files the read is grounded in. The prompt bans name-reading so the
 * model cannot do the one thing the heuristic path is accused of.
 */
export async function deriveProjectPurpose(
  config: BrainConfig,
  evidence: PurposeEvidence,
  projectName: string,
): Promise<{ summary: string | null; basis: string[]; reason: string | null }> {
  const models = await listOllamaModels(config.llm.ollamaUrl);
  if (!models || !hasOllamaModel(models, config.llm.model)) {
    return { summary: null, basis: [], reason: `model "${config.llm.model}" is not installed` };
  }
  const installed = resolveOllamaModel(models, config.llm.model) ?? config.llm.model;
  const client = createOllamaLlm({
    url: config.llm.ollamaUrl,
    model: installed,
    timeoutMs: config.llm.timeoutMs,
  });
  const generated = await client.generate(
    'Source evidence from a repository named "' + projectName + '":\n\n' +
      (evidence.rendered ?? '') +
      '\n\nWrite 1 to 3 sentences: what is this software for and what does it do? ' +
      'Ground every claim in the evidence above, and cite which files or manifest fields support it. ' +
      'If the evidence is too thin or unclear, say exactly that instead of guessing. ' +
      'Do not speculate from the repository name. Plain prose, no lists.',
    {
      system:
        'You characterize a codebase from its manifest and source headers. ' +
        'Report only what the evidence shows. When the evidence does not establish something, say so plainly.',
      temperature: 0.2,
      maxTokens: 300,
    },
  );
  const text = generated.trim();
  if (text.length < 40) return { summary: null, basis: [], reason: 'the model returned too little to use' };
  return {
    summary: excerpt(text, 500),
    basis: evidence.snippets.map((snippet) => snippet.file).slice(0, 6),
    reason: null,
  };
}

/** The indexed text. Deliberately keyword-rich: this is what recall matches. */
export function renderProfileDoc(input: DocInput): string {
  const lines: string[] = [];
  lines.push(`Project "${input.project.name}" (project overview, README, stack, layout)`);
  lines.push(`path: ${input.project.path}`);
  lines.push(`summary: ${input.summary}`);
  if (input.stack.length > 0) lines.push(`stack: ${input.stack.join(', ')}`);
  if (input.languages.length > 0) {
    lines.push(`languages: ${input.languages.map((entry) => `${entry.language} (${entry.files} files)`).join(', ')}`);
  }
  if (input.gitRemote) lines.push(`git remote: ${input.gitRemote}`);
  if (input.isGitRepo) {
    lines.push(
      `git branch: ${input.branch ?? 'unknown'} · ${input.commits} commits${
        input.lastCommit
          ? ` · last commit ${(input.lastCommit.message.split('\n')[0] ?? '').trim() || '(no message)'}`
          : ''
      }`,
    );
  }
  if (input.topLevel.length > 0) {
    lines.push(`layout: ${input.topLevel.map((entry) => entry.name).join(', ')}`);
  }
  if (input.entryPoints.length > 0) lines.push(`entry points: ${input.entryPoints.join(', ')}`);
  if (input.testCommand) lines.push(`test command: ${input.testCommand}`);
  if (input.recentCommits.length > 0) lines.push(`recent commits: ${input.recentCommits.join(' | ')}`);
  if (input.readme) {
    lines.push('README:');
    lines.push(excerpt(input.readme, 1800));
  }
  return lines.join('\n');
}
