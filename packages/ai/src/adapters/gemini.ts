/**
 * Gemini（Google Generative Language API）适配器（T4.1）。
 *
 * baseUrl 如 https://generativelanguage.googleapis.com/v1beta；
 * Key 走查询参数 ?key=；system 消息 → systemInstruction；
 * 流式 :streamGenerateContent?alt=sse（SSE data: JSON 帧）。
 */
import type { ChatMessage, ChatResult, StreamEvent, AiCallOptions } from '../types.js';
import { readErrorMessage, toUsage } from '../types.js';
import { fetchWithRetry } from '../http.js';
import { sseData } from '../sse.js';
import type { AiConfig } from '@jareking/core';

export interface GeminiLikeConfig {
  config: AiConfig;
  apiKey?: string;
}

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

function toContents(messages: ChatMessage[]): {
  contents: { role: 'user' | 'model'; parts: { text: string }[] }[];
  system?: { parts: { text: string }[] };
} {
  const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
  const systemParts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  return {
    contents,
    system: systemParts.length ? { parts: [{ text: systemParts.join('\n') }] } : undefined,
  };
}

export async function geminiChat(
  cfg: GeminiLikeConfig,
  messages: ChatMessage[],
  options: AiCallOptions = {},
): Promise<ChatResult> {
  const apiKey = options.apiKey ?? cfg.apiKey ?? '';
  const { contents, system } = toContents(messages);
  const url = joinUrl(cfg.config.baseUrl, `/models/${cfg.config.model}:generateContent`);
  const res = await fetchWithRetry(
    `${url}?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, ...(system ? { systemInstruction: system } : {}) }),
    },
    { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, signal: options.signal },
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  return {
    content: (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
    usage: toUsage(
      data.usageMetadata?.promptTokenCount,
      data.usageMetadata?.candidatesTokenCount ?? data.usageMetadata?.totalTokenCount,
    ),
  };
}

export async function* geminiStream(
  cfg: GeminiLikeConfig,
  messages: ChatMessage[],
  options: AiCallOptions = {},
): AsyncGenerator<StreamEvent> {
  const apiKey = options.apiKey ?? cfg.apiKey ?? '';
  const { contents, system } = toContents(messages);
  const url = joinUrl(cfg.config.baseUrl, `/models/${cfg.config.model}:streamGenerateContent`);
  const res = await fetchWithRetry(
    `${url}?alt=sse&key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, ...(system ? { systemInstruction: system } : {}) }),
    },
    { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, signal: options.signal },
  );
  if (!res.ok || !res.body) throw new Error(await readErrorMessage(res));

  for await (const data of sseData(res.body)) {
    try {
      const chunk = JSON.parse(data) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = (chunk.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (text) yield { type: 'text', delta: text };
      if (chunk.usageMetadata) {
        yield {
          type: 'usage',
          usage: toUsage(chunk.usageMetadata.promptTokenCount, chunk.usageMetadata.candidatesTokenCount),
        };
      }
    } catch {
      /* 心跳帧跳过 */
    }
  }
  yield { type: 'done' };
}

export async function geminiListModels(
  cfg: GeminiLikeConfig,
  options: AiCallOptions = {},
): Promise<string[]> {
  const apiKey = options.apiKey ?? cfg.apiKey ?? '';
  const res = await fetchWithRetry(
    `${joinUrl(cfg.config.baseUrl, '/models')}?key=${encodeURIComponent(apiKey)}`,
    {},
    { timeoutMs: options.timeoutMs ?? 15_000, maxRetries: 1, signal: options.signal },
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const data = (await res.json()) as { models?: { name?: string }[] };
  return (data.models ?? [])
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
}
