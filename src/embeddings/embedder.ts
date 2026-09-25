import type { BrainConfig } from '../config.js';
import { log } from '../util/logger.js';

export interface Embedder {
  /** Stable identifier stored alongside vectors so model changes invalidate cleanly. */
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/* ------------------------------------------------------------------ *
 * Offline fallback: hashed bag-of-words (+ bigrams) with signed weights.
 * Not as good as a real model, but deterministic, dependency-free and
 * good enough that `brain ask` still works with no Ollama running.
 * ------------------------------------------------------------------ */

const TOKEN_RE = /[a-z0-9_]+/g;

function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

export function hashEmbedding(text: string, dim: number): Float32Array {
  const vector = new Float32Array(dim);
  const tokens = tokenize(text);
  const add = (token: string, weight: number): void => {
    const h = fnv1a(token);
    const index = h % dim;
    const sign = (h >>> 31) === 1 ? -1 : 1;
    vector[index] = (vector[index] ?? 0) + sign * weight;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    add(token, 1);
    if (i > 0) add(`${tokens[i - 1]}_${token}`, 0.6);
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vector[i] = (vector[i] as number) / norm;
  }
  return vector;
}

export function createHashEmbedder(dim = 512): Embedder {
  return {
    model: `hash-${dim}`,
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => hashEmbedding(text, dim));
    },
  };
}

/* ------------------------------------------------------------------ *
 * Ollama embeddings (local-first, offline).
 * ------------------------------------------------------------------ */

export interface OllamaOptions {
  url: string;
  model: string;
  timeoutMs?: number;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export function createOllamaEmbedder(options: OllamaOptions): Embedder {
  const timeoutMs = options.timeoutMs ?? 30000;
  let dim = 0;
  return {
    model: `ollama:${options.model}`,
    get dim() {
      return dim;
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const base = options.url.replace(/\/+$/, '');
      try {
        const body = await fetchJson(
          `${base}/api/embed`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: options.model, input: texts }),
          },
          timeoutMs,
        );
        const embeddings = (body as { embeddings?: number[][] }).embeddings;
        if (Array.isArray(embeddings) && embeddings.length === texts.length) {
          return embeddings.map((row) => {
            dim = row.length;
            return Float32Array.from(row);
          });
        }
        throw new Error('unexpected /api/embed response');
      } catch (err) {
        log.debug(`ollama /api/embed failed, falling back to /api/embeddings: ${String(err)}`);
      }
      // Older Ollama deployments only expose the single-prompt endpoint.
      const out: Float32Array[] = [];
      for (const text of texts) {
        const body = await fetchJson(
          `${base}/api/embeddings`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: options.model, prompt: text }),
          },
          timeoutMs,
        );
        const embedding = (body as { embedding?: number[] }).embedding;
        if (!Array.isArray(embedding)) throw new Error('unexpected /api/embeddings response');
        dim = embedding.length;
        out.push(Float32Array.from(embedding));
      }
      return out;
    },
  };
}

/**
 * List locally available Ollama models, or null when the server is unreachable.
 * Checking the model list (not just reachability) means a half-configured Ollama
 * degrades to the offline embedder instead of silently failing on every write.
 */
export async function listOllamaModels(url: string, timeoutMs = 1500): Promise<string[] | null> {
  try {
    const body = await fetchJson(`${url.replace(/\/+$/, '')}/api/tags`, { method: 'GET' }, timeoutMs);
    const models = (body as { models?: Array<{ name?: string; model?: string }> }).models ?? [];
    return models.map((m) => m.name ?? m.model ?? '').filter((name) => name.length > 0);
  } catch {
    return null;
  }
}

/** True when `model` is present locally (tolerating the `:latest` tag suffix). */
export function hasOllamaModel(models: string[], model: string): boolean {
  const wanted = model.trim();
  const base = wanted.split(':')[0] ?? wanted;
  return models.some((name) => name === wanted || name === base || name.startsWith(`${base}:`));
}

export async function probeOllama(url: string, model?: string, timeoutMs = 1500): Promise<boolean> {
  const models = await listOllamaModels(url, timeoutMs);
  if (!models) return false;
  return model ? hasOllamaModel(models, model) : true;
}

let cachedAuto: Promise<Embedder> | null = null;

/**
 * Resolve the embedder to use. `auto` prefers Ollama and quietly degrades to the
 * offline hashing embedder, so capture never blocks on a missing local model.
 */
export function createEmbedder(config: BrainConfig, forceMode?: 'auto' | 'ollama' | 'hash'): Promise<Embedder> {
  const mode = forceMode ?? config.embedding.provider;
  if (mode === 'hash') return Promise.resolve(createHashEmbedder(config.embedding.hashDim));
  if (mode === 'ollama') {
    return Promise.resolve(
      createOllamaEmbedder({ url: config.embedding.ollamaUrl, model: config.embedding.model }),
    );
  }
  if (!cachedAuto) {
    cachedAuto = (async () => {
      const fallback = (reason: string): Embedder => {
        log.warn(`${reason}; using the offline hashing embedder (lexical recall only)`);
        return createHashEmbedder(config.embedding.hashDim);
      };
      const models = await listOllamaModels(config.embedding.ollamaUrl);
      if (models === null) {
        log.debug('ollama not reachable; using offline hashing embedder');
        return createHashEmbedder(config.embedding.hashDim);
      }
      if (!hasOllamaModel(models, config.embedding.model)) {
        return fallback(
          `ollama is running but model "${config.embedding.model}" is not installed (run: ollama pull ${config.embedding.model})`,
        );
      }
      log.debug('using ollama embedder');
      return createOllamaEmbedder({ url: config.embedding.ollamaUrl, model: config.embedding.model });
    })();
  }
  return cachedAuto;
}

export function resetEmbedderCache(): void {
  cachedAuto = null;
}
