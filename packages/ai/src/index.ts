/**
 * @jareking/ai — AI 适配层（Phase 4 实施，当前仅接口契约）
 *
 * 设计见 docs/spec.md 7.5：适配器模式 + LLM-as-Planner 输出结构化 ops。
 * 实现任务见 docs/todo.md T4.1~T4.3。
 */
import type { AiConfig, AiPlan, AiUsage } from '@jareking/core';

export type { AiConfig, AiPlan, AiUsage } from '@jareking/core';

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

/** 适配器接口：所有服务商（OpenAI 兼容 / Claude / Gemini / Ollama）统一实现 */
export interface AiAdapter {
  readonly config: AiConfig;
  chat(messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<ChatResult>;
}

/** Planner 接口：把用户指令 + 文档上下文编译为结构化 ops 计划 */
export interface AiPlanner {
  plan(instruction: string, context: unknown): Promise<AiPlan>;
}
