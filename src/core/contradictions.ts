import type { Db } from '../db/index.js';
import { tokenize } from '../embeddings/embedder.js';
import { decisionStatus } from './preflight.js';
import { listProjects } from './projects.js';
import type { ContradictionRow, DecisionRow, ProjectRow } from './types.js';

/**
 * Decisions drift. Six weeks after you wrote "we use SQLite for the store" you
 * write "the Postgres connection pool", and both sit in the record looking
 * equally authoritative. This module finds those pairs deterministically: two
 * *accepted* decisions, in the same project, that pick different values from the
 * same choice category and share enough topic vocabulary to be about the same
 * thing. It flags, it never rewrites — the user is the only one who can say
 * which decision superseded the other.
 */

/** Technology families where two decisions picking differently is a real conflict. */
const CHOICE_CATEGORIES: Record<string, string[]> = {
  database: ['sqlite', 'postgres', 'postgresql', 'mysql', 'mariadb', 'mongodb', 'dynamodb', 'cassandra', 'firestore'],
  cache: ['redis', 'memcached', 'varnish'],
  queue: ['kafka', 'rabbitmq', 'sqs', 'nats', 'bullmq', 'celery'],
  language: ['typescript', 'javascript', 'python', 'rust', 'golang', 'java', 'ruby'],
  frontend: ['react', 'vue', 'svelte', 'angular', 'solid', 'htmx'],
  'api-style': ['rest', 'graphql', 'grpc', 'trpc', 'soap'],
  orm: ['prisma', 'drizzle', 'typeorm', 'sequelize', 'sqlalchemy', 'knex'],
  format: ['json', 'yaml', 'toml', 'xml', 'csv'],
  test: ['jest', 'vitest', 'mocha', 'pytest', 'playwright', 'cypress'],
  hosting: ['vercel', 'netlify', 'aws', 'gcp', 'azure', 'fly.io', 'render', 'railway'],
  auth: ['jwt', 'oauth', 'session', 'cookies'],
  package: ['npm', 'pnpm', 'yarn', 'bun'],
};

/** Value -> category, so a decision token can name the family it picked. */
const VALUE_TO_CATEGORY = new Map<string, string>();
for (const [category, values] of Object.entries(CHOICE_CATEGORIES)) {
  for (const value of values) VALUE_TO_CATEGORY.set(value, category);
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'then', 'than',
  'use', 'used', 'using', 'instead', 'because', 'since', 'will', 'would',
  'should', 'could', 'decided', 'decision', 'reject', 'rejected', 'revert',
  'add', 'added', 'remove', 'removed', 'change', 'changed', 'changes',
  'switch', 'switched', 'keep', 'kept', 'not', 'but', 'all', 'any', 'new',
  'old', 'more', 'less', 'local', 'our', 'its', 'over', 'onto', 'about',
]);

export interface ContradictionSide {
  id: number;
  text: string;
  ts: number;
}

export interface Contradiction {
  id: number;
  projectId: number | null;
  projectName: string | null;
  category: string;
  choiceA: string;
  choiceB: string;
  score: number;
  reason: string;
  a: ContradictionSide;
  b: ContradictionSide;
}

export interface ContradictionOptions {
  /** Look only in this project (including its global decisions); omit for all. */
  projectId?: number | null;
  limit?: number;
  /** How many decisions per project to compare. */
  decisionsPerProject?: number;
  /** Minimum shared informative words (beyond the conflicting choice) to flag. */
  minShared?: number;
}

interface AnalyzedDecision {
  id: number;
  projectId: number | null;
  projectName: string | null;
  ts: number;
  text: string;
  status: 'accepted' | 'rejected';
  choices: Map<string, string>;
  topics: Set<string>;
}

function analyze(decision: DecisionRow, projectName: string | null): AnalyzedDecision {
  const tags = (decision.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const choices = new Map<string, string>();
  const topics = new Set<string>();
  for (const token of tokenize(decision.text)) {
    const category = VALUE_TO_CATEGORY.get(token);
    if (category) {
      // Keep the first value seen per family; the newest decision wins ties.
      if (!choices.has(category)) choices.set(category, token);
      continue;
    }
    if (token.length < 3 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
    topics.add(token);
  }
  return {
    id: decision.id,
    projectId: decision.project_id,
    projectName,
    ts: decision.ts,
    text: decision.text,
    status: decisionStatus(decision.text, tags),
    choices,
    topics,
  };
}

/**
 * Compare every accepted decision in a project against the others and return
 * the pairs that pick different values in the same family while still talking
 * about the same subject.
 */
export function detectContradictions(db: Db, options: ContradictionOptions = {}): Contradiction[] {
  const limit = options.limit ?? 50;
  const perProject = options.decisionsPerProject ?? 300;
  const minShared = options.minShared ?? 1;
  const names = new Map<number, string>(listProjects(db).map((project) => [project.id, project.name]));
  const scope: ProjectRow[] = listProjects(db).filter(
    (project) => options.projectId === undefined || options.projectId === null || project.id === options.projectId,
  );

  const found: Contradiction[] = [];
  for (const project of scope) {
    const rows = db
      .prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY ts DESC LIMIT ?')
      .all(project.id, perProject) as DecisionRow[];
    const analyzed = rows
      .filter((row) => decisionStatus(row.text, (row.tags ?? '').split(',').map((t) => t.trim())) === 'accepted')
      .map((row) => analyze(row, names.get(project.id) ?? null));

    for (let i = 0; i < analyzed.length; i++) {
      for (let j = i + 1; j < analyzed.length; j++) {
        const a = analyzed[i] as AnalyzedDecision;
        const b = analyzed[j] as AnalyzedDecision;
        let category: string | null = null;
        let choiceA = '';
        let choiceB = '';
        for (const [family, value] of a.choices) {
          const other = b.choices.get(family);
          if (other && other !== value) {
            category = family;
            choiceA = value;
            choiceB = other;
            break;
          }
        }
        if (!category) continue;
        const shared = [...a.topics].filter((topic) => b.topics.has(topic));
        if (shared.length < minShared) continue;
        const score = 2 + shared.length + (a.projectId === b.projectId ? 0.5 : 0);
        found.push({
          id: 0,
          projectId: a.projectId,
          projectName: a.projectName,
          category,
          choiceA,
          choiceB,
          score: Math.round(score * 100) / 100,
          reason:
            `both are accepted decisions in ${a.projectName ?? project.name} that pick a different ${category} ` +
            `("${choiceA}" vs "${choiceB}") while sharing ${shared.slice(0, 4).join(', ')}`,
          a: { id: a.id, text: a.text, ts: a.ts },
          b: { id: b.id, text: b.text, ts: b.ts },
        });
      }
    }
  }

  found.sort((x, y) => y.score - x.score || Math.max(y.a.ts, y.b.ts) - Math.max(x.a.ts, x.b.ts));
  return found.slice(0, limit);
}

/**
 * Store findings so the daemon can surface them later. Re-detecting the same
 * pair refreshes its timestamp instead of duplicating it.
 */
export function persistContradictions(db: Db, findings: Contradiction[]): number {
  const stmt = db.prepare(
    `INSERT INTO contradictions(project_id, a_id, b_id, category, choice_a, choice_b, score, reason, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(a_id, b_id) DO UPDATE SET
       category    = excluded.category,
       choice_a    = excluded.choice_a,
       choice_b    = excluded.choice_b,
       score       = excluded.score,
       reason      = excluded.reason,
       detected_at = excluded.detected_at`,
  );
  let inserted = 0;
  const tx = db.transaction((items: Contradiction[]) => {
    for (const item of items) {
      const [lo, hi] = item.a.id <= item.b.id ? [item.a.id, item.b.id] : [item.b.id, item.a.id];
      const before = db
        .prepare('SELECT id FROM contradictions WHERE a_id = ? AND b_id = ?')
        .get(lo, hi) as { id: number } | undefined;
      stmt.run(
        item.projectId,
        lo,
        hi,
        item.category,
        item.choiceA,
        item.choiceB,
        item.score,
        item.reason,
        Date.now(),
      );
      if (!before) inserted += 1;
    }
  });
  tx(findings);
  return inserted;
}

export interface StoredContradiction extends Contradiction {
  detectedAt: number;
  dismissed: boolean;
}

/** Stored findings, joined back to the decisions so the CLI can show the text. */
export function listContradictions(db: Db, projectId: number | null, limit = 20): StoredContradiction[] {
  const projectFilter = projectId === null ? '' : 'AND c.project_id = ?';
  const params = projectId === null ? [] : [projectId];
  const rows = db
    .prepare(
      `SELECT c.*,
              da.text AS a_text, da.ts AS a_ts,
              d2.text AS b_text, d2.ts AS b_ts,
              p.name  AS project_name
         FROM contradictions c
         JOIN decisions da ON da.id = c.a_id
         JOIN decisions d2 ON d2.id = c.b_id
         LEFT JOIN projects p ON p.id = c.project_id
        WHERE c.dismissed = 0 ${projectFilter}
        ORDER BY c.score DESC, c.detected_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<
    ContradictionRow & { a_text: string; a_ts: number; b_text: string; b_ts: number; project_name: string | null }
  >;

  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    category: row.category,
    choiceA: row.choice_a,
    choiceB: row.choice_b,
    score: row.score,
    reason: row.reason,
    detectedAt: row.detected_at,
    dismissed: row.dismissed !== 0,
    a: { id: row.a_id, text: row.a_text, ts: row.a_ts },
    b: { id: row.b_id, text: row.b_text, ts: row.b_ts },
  }));
}

export function countContradictions(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM contradictions WHERE dismissed = 0').get() as { n: number };
  return row.n;
}

export function dismissContradiction(db: Db, id: number): boolean {
  const info = db.prepare('UPDATE contradictions SET dismissed = 1 WHERE id = ?').run(id);
  return info.changes > 0;
}
