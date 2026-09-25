import type { Db } from '../db/index.js';
import type { Embedder } from '../embeddings/embedder.js';
import { saveEmbedding } from '../embeddings/store.js';
import { log } from '../util/logger.js';
import type { OwnerType } from './types.js';

export interface IndexInput {
  ownerType: OwnerType;
  ownerId: number;
  projectId: number | null;
  ts: number;
  text: string;
}

/** Upsert the lexical index row (kept in sync with FTS5 by triggers). */
export function upsertSearchDoc(db: Db, input: IndexInput): void {
  db.prepare(
    `INSERT INTO search_docs(owner_type, owner_id, project_id, ts, text)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id) DO UPDATE SET
       project_id = excluded.project_id,
       ts         = excluded.ts,
       text       = excluded.text`,
  ).run(input.ownerType, input.ownerId, input.projectId, input.ts, input.text);
}

export function deleteSearchDoc(db: Db, ownerType: OwnerType, ownerId: number): void {
  db.prepare('DELETE FROM search_docs WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
}

/** Lexical index only — used when embeddings are disabled or the model is down. */
export function indexLexically(db: Db, inputs: IndexInput[]): void {
  const tx = db.transaction((batch: IndexInput[]) => {
    for (const input of batch) upsertSearchDoc(db, input);
  });
  tx(inputs);
}

/**
 * Index a batch of documents: lexical always, vectors best-effort.
 * A failing embedder degrades recall but never loses captured data.
 */
export async function indexBatch(db: Db, embedder: Embedder, inputs: IndexInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  const useful = inputs.filter((i) => i.text.trim().length > 0);
  indexLexically(db, useful);
  let embedded = 0;
  try {
    const vectors = await embedder.embed(useful.map((i) => i.text));
    useful.forEach((input, i) => {
      const vector = vectors[i];
      if (!vector) return;
      saveEmbedding(db, {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        projectId: input.projectId,
        model: embedder.model,
        vector,
        text: input.text,
        ts: input.ts,
      });
      embedded++;
    });
  } catch (err) {
    log.warn(`embedding failed (${inputs.length} docs indexed lexically only): ${String(err)}`);
  }
  return embedded;
}

export async function indexOne(db: Db, embedder: Embedder, input: IndexInput): Promise<void> {
  await indexBatch(db, embedder, [input]);
}

/** Count of indexed docs, by owner type. */
export function indexStats(db: Db): Record<string, number> {
  const rows = db.prepare('SELECT owner_type, COUNT(*) AS n FROM search_docs GROUP BY owner_type').all() as Array<{
    owner_type: string;
    n: number;
  }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.owner_type] = row.n;
  return out;
}
