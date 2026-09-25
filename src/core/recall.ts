import type { Db } from '../db/index.js';
import { tokenize, type Embedder } from '../embeddings/embedder.js';
import { cosineSimilarity, loadEmbeddings } from '../embeddings/store.js';
import { indexBatch } from './indexing.js';
import { ensureGlobalProject } from './projects.js';
import type { OwnerType, SearchHit } from './types.js';

export interface AskOptions {
  /** Restrict to one project; global-bucket decisions are still included. */
  projectId?: number | null;
  limit?: number;
  since?: number;
  ownerTypes?: OwnerType[];
  /** Fusion constant for reciprocal rank fusion (higher = flatter weighting). */
  rrfK?: number;
}

export interface AskResult {
  query: string;
  hits: SearchHit[];
  embedderModel: string;
  lexicalCount: number;
  vectorCount: number;
}

interface Candidate {
  ownerType: OwnerType;
  ownerId: number;
  projectId: number | null;
  projectName: string | null;
  ts: number;
  text: string;
  lexicalRank?: number;
  vectorRank?: number;
  vectorScore?: number;
}

/**
 * Build a safe FTS5 MATCH expression: every token becomes a quoted phrase so
 * user punctuation can never be parsed as FTS syntax.
 */
export function toFtsQuery(query: string): string | null {
  const tokens = Array.from(new Set(tokenize(query))).filter((t) => t.length > 1);
  if (tokens.length === 0) {
    const raw = query.trim();
    return raw.length > 0 ? `"${raw.replace(/"/g, '""')}"` : null;
  }
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export async function ask(db: Db, embedder: Embedder, query: string, options: AskOptions = {}): Promise<AskResult> {
  const limit = options.limit ?? 8;
  const since = options.since ?? 0;
  const rrfK = options.rrfK ?? 60;
  const poolSize = Math.max(limit * 4, 24);
  const candidates = new Map<string, Candidate>();
  const key = (ownerType: string, ownerId: number): string => `${ownerType}#${ownerId}`;

  const projectScope: number[] = [];
  if (options.projectId !== undefined && options.projectId !== null) {
    projectScope.push(options.projectId);
    const global = ensureGlobalProject(db);
    if (global.id !== options.projectId) projectScope.push(global.id);
  }

  /* ---------------- lexical ---------------- */
  const match = toFtsQuery(query);
  let lexicalCount = 0;
  if (match) {
    const filters = ['f.search_fts MATCH ?', 'd.ts >= ?'];
    const params: unknown[] = [match, since];
    if (projectScope.length > 0) {
      filters.push(`d.project_id IN (${projectScope.map(() => '?').join(',')})`);
      params.push(...projectScope);
    }
    if (options.ownerTypes && options.ownerTypes.length > 0) {
      filters.push(`d.owner_type IN (${options.ownerTypes.map(() => '?').join(',')})`);
      params.push(...options.ownerTypes);
    }
    params.push(poolSize);
    const rows = db
      .prepare(
        `SELECT d.owner_type AS ownerType, d.owner_id AS ownerId, d.project_id AS projectId,
                d.ts AS ts, d.text AS text, p.name AS projectName
           FROM search_fts f
           JOIN search_docs d ON d.id = f.rowid
           LEFT JOIN projects p ON p.id = d.project_id
          WHERE ${filters.join(' AND ')}
          ORDER BY bm25(search_fts)
          LIMIT ?`,
      )
      .all(...params) as Array<Omit<Candidate, 'lexicalRank'>>;
    rows.forEach((row, index) => {
      const k = key(row.ownerType, row.ownerId);
      const existing = candidates.get(k) ?? { ...row };
      existing.lexicalRank = index + 1;
      candidates.set(k, existing);
      lexicalCount++;
    });
  }

  /* ---------------- vector ---------------- */
  const embeddingScope = projectScope.length > 0 ? null : undefined;
  const scopeIds = projectScope.length > 0 ? new Set(projectScope) : null;
  let vectorCount = 0;
  try {
    const [queryVector] = await embedder.embed([query]);
    if (queryVector) {
      const records = loadEmbeddings(db, {
        projectId: embeddingScope,
        ownerTypes: options.ownerTypes,
      });
      const scored: Array<{ record: (typeof records)[number]; score: number }> = [];
      for (const record of records) {
        if (record.ts < since) continue;
        if (scopeIds && (record.projectId === null || !scopeIds.has(record.projectId))) continue;
        const score = cosineSimilarity(queryVector, record.vector);
        if (score > 0.05) scored.push({ record, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const projectNames = new Map<number, string>();
      for (const { record, score } of scored.slice(0, poolSize)) {
        const k = key(record.ownerType, record.ownerId);
        if (record.projectId !== null && !projectNames.has(record.projectId)) {
          const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(record.projectId) as
            | { name: string }
            | undefined;
          projectNames.set(record.projectId, row?.name ?? 'unknown');
        }
        const existing = candidates.get(k);
        const next: Candidate = existing ?? {
          ownerType: record.ownerType,
          ownerId: record.ownerId,
          projectId: record.projectId,
          projectName: record.projectId === null ? null : (projectNames.get(record.projectId) ?? null),
          ts: record.ts,
          text: record.text,
        };
        next.vectorRank = vectorCount + 1;
        next.vectorScore = score;
        candidates.set(k, next);
        vectorCount++;
      }
    }
  } catch {
    // Vector recall is best-effort; lexical results still stand.
  }

  /* ---------------- fuse ---------------- */
  const hits: SearchHit[] = [];
  for (const candidate of candidates.values()) {
    let score = 0;
    const via: SearchHit['via'] = [];
    if (candidate.lexicalRank !== undefined) {
      score += 1 / (rrfK + candidate.lexicalRank);
      via.push('lexical');
    }
    if (candidate.vectorRank !== undefined) {
      score += 1 / (rrfK + candidate.vectorRank);
      via.push('vector');
    }
    hits.push({
      ownerType: candidate.ownerType,
      ownerId: candidate.ownerId,
      projectId: candidate.projectId,
      projectName: candidate.projectName,
      ts: candidate.ts,
      text: candidate.text,
      score,
      via,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);

  return {
    query,
    hits: hits.slice(0, limit),
    embedderModel: embedder.model,
    lexicalCount,
    vectorCount,
  };
}

/** Re-embed everything already in the lexical index; used after a model change. */
export async function rebuildIndex(
  db: Db,
  embedder: Embedder,
): Promise<{ total: number; embedded: number }> {
  const rows = db
    .prepare('SELECT owner_type AS ownerType, owner_id AS ownerId, project_id AS projectId, ts, text FROM search_docs')
    .all() as Array<{ ownerType: OwnerType; ownerId: number; projectId: number | null; ts: number; text: string }>;
  db.prepare('DELETE FROM embeddings').run();
  const embedded = await indexBatch(db, embedder, rows);
  return { total: rows.length, embedded };
}
