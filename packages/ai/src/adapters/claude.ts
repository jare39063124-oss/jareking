/**
 * Claude（Anthropic Messages API）适配器（T4.1）。
 *
 * POST {baseUrl}/v1/messages（baseUrl 如 https://api.anthropic.com），
 * 头：x-api-key + anthropic-version；system 消息独立字段；
 * 流式 SSE：content_block_delta(.delta.text) / message_delta(usage) / message_stop。
 */
import type { ChatMessage, ChatResult, StreamEvent, AiCallOptions } from '../types.js';
import { readErrorMessage, toUsage } from '../types.js';
import { fetchWithRetry } from '../http.js';
import { sseData } from '../sse.js';
import type { AiConfig } from '@jareking/core';

export interface ClaudeLikeConfig {
  config: AiConfig;
  apiKey?: string;
}

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

function splitSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  return { system, rest: messages.filter((m) => m.role !== 'system') };
}

function headers(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

export async function claudeChat(
  cfg: ClaudeLikeConfig,
  messages: ChatMessage[],
  options: AiCallOptions = {},
): Promise<ChatResult> {
  const apiKey = options.apiKey ?? cfg.apiKey ?? '';
  const { system, rest } = splitSystem(messages);
  const res = await fetchWithRetry(
    joinUrl(cfg.config.baseUrl, '/v1/messages'),
    {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        model: cfg.config.model,
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: rest,
      }),
    },
    { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, signal: options.signal },
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };
  return {
    content: (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    usage: toUsage(data.usage?.input_tokens, data.usage?.output_tokens),
  };
}

export async function* claudeStream(
  cfg: ClaudeLikeConfig,
  messages: ChatMessage[],
  options: AiCallOptions = {},
): AsyncGenerator<StreamEvent> {
  const apiKey = options.apiKey ?? cfg.apiKey ?? '';
  const { system, rest } = splitSystem(messages);
  const res = await fetchWithRetry(
    joinUrl(cfg.config.baseUrl, '/v1/messages'),
    {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify({
        model: cfg.config.model,
        max_tokens: 4096,
        stream: true,
        ...(system ? { system } : {}),
        messages: rest,
      }),
    },
    { timeoutMs: options.timeoutMs, maxRetries: options.maxRetries, signal: options.signal },
  );
  if (!res.ok || !res.body) throw new Error(await readErrorMessage(res));

  let inputTokens: number | undefined;
  for await (const data of sseData(res.body)) {
    try {
      const ev = JSON.parse(data) as {
        type: string;
        delta?: { text?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        message?: { usage?: { input_tokens?: number } };
      };
      if (ev.type === 'content_block_delta' && ev.delta?.text) {
        yield { type: 'text', delta: ev.delta.text };
      } else if (ev.type === 'message_start' && ev.message?.usage?.input_tokens !== undefined) {
        inputTokens = ev.message.usage.input_tokens;
      } else if (ev.type === 'message_delta' && ev.delta?.usage?.output_tokens !== undefined) {
        yield { type: 'usage', usage: toUsage(inputTokens, ev.delta.usage.output_tokens) };
      } else if (ev.type === 'message_stop') {
        break;
      }
    } catch {
      /* 心跳帧跳过 */
    }
  }
  yield { type: 'done' };
}
