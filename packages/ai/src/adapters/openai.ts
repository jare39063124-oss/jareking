/**
 * OpenAI 兼容适配器（T4.1）。
 *
 * 覆盖 OpenAI 官方与一切兼容网关（DeepSeek / 通义 DashScope 兼容模式 /
 * Kimi / 智谱 GLM / Ollama 的 OpenAI 端点 / vLLM / 自建中转）：
 * POST {baseUrl}/chat/completions，SSE `data: {...}` 帧。
 */
import type { ChatMessage, ChatResult, StreamEvent, AiCallOptions } from '../types.js';
import { readErrorMessage, toUsage } from '../types.js';
import { fetchWithRetry } from '../http.js';
import { sseData } from '../sse.js';
import type { AiConfig } from '@jareking/core';

export interface OpenAiLikeConfig {
  config: AiConfig;
  apiKey?: string;
}

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

/** OpenAI 兼容：单轮对话（非流式） */
export async function openaiChat(
  cfg: OpenAiLikeConfig,
  messages: ChatMessage[],
  options: AiCallOptions = {},
): Promise<ChatResult> {
  const apiKey = options.apiKey ?? cfg.apiKey ?? '';
  const res = await fetchWithRetry(
    joinUrl(cfg.config.baseUrl, '/chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: cfg.config.model, messages, stream: false }),
    },
    { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, signal: options.signal },
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    usage: toUsage(data.usage?.prompt_tokens, data.usage?.completion_tokens),
  };
}

/** OpenAI 兼容：流式对话（SSE） */
export async function* openaiStream(
  cfg: OpenAiLikeConfig,
  messages: ChatMessage[],
  options: AiCallOptions = {},
): AsyncGenerator<StreamEvent> {
  const apiKey = options.apiKey ?? cfg.apiKey ?? '';
  const res = await fetchWithRetry(
    joinUrl(cfg.config.baseUrl, '/chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: cfg.config.model, messages, stream: true }),
    },
    { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, signal: options.signal },
  );
  if (!res.ok || !res.body) {
    throw new Error(await readErrorMessage(res));
  }
  for await (const data of sseData(res.body)) {
    if (data === '[DONE]') break;
    try {
      const chunk = JSON.parse(data) as {
        choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield { type: 'text', delta };
      if (chunk.usage) {
        yield { type: 'usage', usage: toUsage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens) };
      }
      if (chunk.choices?.[0]?.finish_reason) break;
    } catch {
      // 非 JSON 帧：跳过（部分网关会发心跳帧）
    }
  }
  yield { type: 'done' };
}

/** OpenAI 兼容：模型列表 */
export async function openaiListModels(
  cfg: OpenAiLikeConfig,
  options: AiCallOptions = {},
): Promise<string[]> {
  const apiKey = options.apiKey ?? cfg.apiKey ?? '';
  const res = await fetchWithRetry(
    joinUrl(cfg.config.baseUrl, '/models'),
    { headers: { Authorization: `Bearer ${apiKey}` } },
    { timeoutMs: options.timeoutMs ?? 15_000, maxRetries: 1, signal: options.signal },
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const data = (await res.json()) as { data?: { id?: string }[] };
  return (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
}
