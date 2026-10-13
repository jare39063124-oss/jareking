/**
 * Ollama（本地模型）适配器（T4.1）。
 *
 * baseUrl 如 http://127.0.0.1:11434；POST /api/chat（NDJSON 流）；
 * usage 来自末帧 done:true 的 prompt_eval_count / eval_count；无需鉴权头。
 */
import type { ChatMessage, ChatResult, StreamEvent, AiCallOptions } from '../types.js';
import { readErrorMessage, toUsage } from '../types.js';
import { fetchWithRetry } from '../http.js';
import { ndjson } from '../sse.js';
import type { AiConfig } from '@jareking/core';

export interface OllamaLikeConfig {
  config: AiConfig;
  apiKey?: string; // Ollama 不需要，占位统一签名
}

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

export async function ollamaChat(
  cfg: OllamaLikeConfig,
  messages: ChatMessage[],
  options: AiCallOptions = {},
): Promise<ChatResult> {
  const res = await fetchWithRetry(
    joinUrl(cfg.config.baseUrl, '/api/chat'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.config.model, messages, stream: false }),
    },
    { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, signal: options.signal },
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const data = (await res.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  return {
    content: data.message?.content ?? '',
    usage: toUsage(data.prompt_eval_count, data.eval_count),
  };
}

export async function* ollamaStream(
  cfg: OllamaLikeConfig,
  messages: ChatMessage[],
  options: AiCallOptions = {},
): AsyncGenerator<StreamEvent> {
  const res = await fetchWithRetry(
    joinUrl(cfg.config.baseUrl, '/api/chat'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.config.model, messages, stream: true }),
    },
    { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, signal: options.signal },
  );
  if (!res.ok || !res.body) throw new Error(await readErrorMessage(res));

  for await (const line of ndjson(res.body)) {
    try {
      const chunk = JSON.parse(line) as {
        message?: { content?: string };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      if (chunk.message?.content) yield { type: 'text', delta: chunk.message.content };
      if (chunk.done) {
        yield { type: 'usage', usage: toUsage(chunk.prompt_eval_count, chunk.eval_count) };
        break;
      }
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  yield { type: 'done' };
}

export async function ollamaListModels(
  cfg: OllamaLikeConfig,
  options: AiCallOptions = {},
): Promise<string[]> {
  const res = await fetchWithRetry(
    joinUrl(cfg.config.baseUrl, '/api/tags'),
    {},
    { timeoutMs: options.timeoutMs ?? 15_000, maxRetries: 1, signal: options.signal },
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const data = (await res.json()) as { models?: { name?: string }[] };
  return (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
}
