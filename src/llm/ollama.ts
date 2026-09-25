import { hasOllamaModel, listOllamaModels } from '../embeddings/embedder.js';
import { log } from '../util/logger.js';

export interface GenerateOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmClient {
  readonly name: string;
  available(): Promise<boolean>;
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
}

export interface OllamaLlmOptions {
  url: string;
  model: string;
  timeoutMs?: number;
}

export function createOllamaLlm(options: OllamaLlmOptions): LlmClient {
  const base = options.url.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 20000;

  async function request(prompt: string, stream: boolean, genOptions?: GenerateOptions): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          prompt,
          system: genOptions?.system,
          stream,
          options: {
            temperature: genOptions?.temperature ?? 0.2,
            num_predict: genOptions?.maxTokens,
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!stream) {
        const body = (await res.json()) as { response?: string };
        return body.response?.trim() ?? '';
      }
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: `ollama:${options.model}`,
    async available(): Promise<boolean> {
      const models = await listOllamaModels(base);
      if (!models) return false;
      if (!hasOllamaModel(models, options.model)) {
        log.debug(`ollama model ${options.model} is not installed; skipping LLM summarization`);
        return false;
      }
      return true;
    },
    async generate(prompt: string, genOptions?: GenerateOptions): Promise<string> {
      try {
        return await request(prompt, false, genOptions);
      } catch (err) {
        log.debug(`ollama generate failed: ${String(err)}`);
        return '';
      }
    },
  };
}
