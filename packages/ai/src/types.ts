/**
 * 适配器公共类型（T4.1）。
 *
 * 流式事件统一为四类：text / usage / done / error；
 * 各服务商差异（SSE/NDJSON、事件名、usage 字段）在各自适配器内消化。
 */
import type { AiUsage } from '@jareking/core';

export type { AiUsage } from '@jareking/core';

/** 对话消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 单轮调用结果 */
export interface ChatResult {
  content: string;
  usage: AiUsage;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'usage'; usage: AiUsage }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AiCallOptions {
  /** 调用方取消信号 */
  signal?: AbortSignal;
  /** 单次覆盖超时（毫秒） */
  timeoutMs?: number;
  /** 单次覆盖重试次数 */
  maxRetries?: number;
  /** 明文 API Key（T4.2 之前由 UI 直接传入；之后经 DPAPI 解析 apiKeyRef） */
  apiKey?: string;
}

/** usage 兜底构造 */
export function toUsage(promptTokens?: number, completionTokens?: number): AiUsage {
  const p = promptTokens ?? 0;
  const c = completionTokens ?? 0;
  return { promptTokens: p, completionTokens: c, totalTokens: p + c };
}

/** 从响应 JSON 提取错误信息（各服务商风格不一） */
export async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const obj = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof obj.error === 'string') return obj.error;
    if (obj.error?.message) return obj.error.message;
    if (obj.message) return obj.message;
  } catch {
    /* 非 JSON */
  }
  return `HTTP ${res.status}: ${text.slice(0, 200)}`;
}
