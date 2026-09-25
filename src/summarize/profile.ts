import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
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
    return { file: path.basename(file), text: cleaned.slice(0, maxChars) };
  } catch {
    return null;
  }
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
  if (readmeLine) return readmeLine.clean.slice(0, 220);
  const dirs = input.topLevel.filter((entry) => entry.kind === 'dir').map((entry) => entry.name.replace(/\/$/, ''));
  const stack = input.stack.length > 0 ? input.stack.join(', ') : input.languages[0]?.language ?? 'unknown stack';
  const shape = dirs.length > 0 ? ` with ${dirs.slice(0, 5).join(', ')}` : '';
  return `${input.name} — a ${stack} project${shape}.`;
}

export interface BuildProfileOptions {
  /** Commit subjects to include in the recall document. */
  recentCommits?: number;
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

  const summary = describeProject({ name: project.name, stack, languages, topLevel, readme: readme?.text ?? null });

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
    lines.push(input.readme.slice(0, 1800));
  }
  return lines.join('\n');
}
