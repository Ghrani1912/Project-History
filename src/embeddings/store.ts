import type { Db } from '../db/index.js';
import type { OwnerType } from '../core/types.js';

export interface EmbeddingRecord {
  ownerType: OwnerType;
  ownerId: number;
  projectId: number | null;
  ts: number;
  text: string;
  vector: Float32Array;
}

export function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function fromBuffer(buffer: Buffer, dim: number): Float32Array {
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = buffer.readFloatLE(i * 4);
  return out;
}

export function saveEmbedding(
  db: Db,
  input: {
    ownerType: OwnerType;
    ownerId: number;
    projectId: number | null;
    model: string;
    vector: Float32Array;
    text: string;
    ts: number;
  },
): void {
  db.prepare(
    `INSERT INTO embeddings(owner_type, owner_id, project_id, model, dim, vector, text, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_type, owner_id, model) DO UPDATE SET
       project_id = excluded.project_id,
       dim        = excluded.dim,
       vector     = excluded.vector,
       text       = excluded.text,
       ts         = excluded.ts`,
  ).run(
    input.ownerType,
    input.ownerId,
    input.projectId,
    input.model,
    input.vector.length,
    toBuffer(input.vector),
    input.text,
    input.ts,
  );
}

export function deleteEmbeddings(db: Db, ownerType: OwnerType, ownerId: number): void {
  db.prepare('DELETE FROM embeddings WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
}

export interface LoadEmbeddingsOptions {
  projectId?: number | null;
  ownerTypes?: OwnerType[];
  model?: string;
}

export function loadEmbeddings(db: Db, options: LoadEmbeddingsOptions = {}): EmbeddingRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.projectId !== undefined && options.projectId !== null) {
    where.push('project_id = ?');
    params.push(options.projectId);
  }
  if (options.ownerTypes && options.ownerTypes.length > 0) {
    where.push(`owner_type IN (${options.ownerTypes.map(() => '?').join(',')})`);
    params.push(...options.ownerTypes);
  }
  if (options.model) {
    where.push('model = ?');
    params.push(options.model);
  }
  const sql = `SELECT owner_type, owner_id, project_id, ts, text, dim, vector FROM embeddings${
    where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  }`;
  const rows = db.prepare(sql).all(...params) as Array<{
    owner_type: OwnerType;
    owner_id: number;
    project_id: number | null;
    ts: number;
    text: string;
    dim: number;
    vector: Buffer;
  }>;
  return rows.map((row) => ({
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    projectId: row.project_id,
    ts: row.ts,
    text: row.text,
    vector: fromBuffer(row.vector, row.dim),
  }));
}

export function countEmbeddings(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as { n: number };
  return row.n;
}

/** Cosine similarity; both inputs are expected to be L2-normalised where possible. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
