/**
 * 适配器接口与工厂（T4.1）。
 *
 * AiAdapter 统一四类服务商：chat（非流式）/ stream（流式）/ listModels。
 * 工厂按 config.kind 分派；明文 apiKey 由调用方在创建时或每次调用时注入
 * （契约层只存 apiKeyRef，T4.2 接入 DPAPI/keytar 加密存储）。
 */
import type { AiConfig, AiProviderKind } from '@jareking/core';
import type { ChatMessage, ChatResult, StreamEvent, AiCallOptions } from './types.js';
import * as openai from './adapters/openai.js';
import * as claude from './adapters/claude.js';
import * as gemini from './adapters/gemini.js';
import * as ollama from './adapters/ollama.js';

export type { AiConfig, AiProviderKind } from '@jareking/core';
export type { ChatMessage, ChatResult, StreamEvent, AiCallOptions } from './types.js';

export interface AiAdapter {
  readonly config: AiConfig;
  /** 单轮对话（非流式） */
  chat(messages: ChatMessage[], options?: AiCallOptions): Promise<ChatResult>;
  /** 流式对话（增量文本 + usage + done） */
  stream(messages: ChatMessage[], options?: AiCallOptions): AsyncIterable<StreamEvent>;
  /** 模型列表（支持的服务商提供） */
  listModels?(options?: AiCallOptions): Promise<string[]>;
}

/** Planner 接口：把用户指令 + 文档上下文编译为结构化 ops 计划（T4.3 实现） */
export interface AiPlanner {
  plan(instruction: string, context: unknown): Promise<import('@jareking/core').AiPlan>;
}

/** 创建适配器（按服务商分派；apiKey 为调用时已解析的明文） */
export function createAiAdapter(config: AiConfig, apiKey?: string): AiAdapter {
  const cfg = { config, apiKey };
  switch (config.kind) {
    case 'openai-compatible':
      return {
        config,
        chat: (m, o) => openai.openaiChat(cfg, m, o),
        stream: (m, o) => openai.openaiStream(cfg, m, o),
        listModels: (o) => openai.openaiListModels(cfg, o),
      };
    case 'claude':
      return {
        config,
        chat: (m, o) => claude.claudeChat(cfg, m, o),
        stream: (m, o) => claude.claudeStream(cfg, m, o),
      };
    case 'gemini':
      return {
        config,
        chat: (m, o) => gemini.geminiChat(cfg, m, o),
        stream: (m, o) => gemini.geminiStream(cfg, m, o),
        listModels: (o) => gemini.geminiListModels(cfg, o),
      };
    case 'ollama':
      return {
        config,
        chat: (m, o) => ollama.ollamaChat(cfg, m, o),
        stream: (m, o) => ollama.ollamaStream(cfg, m, o),
        listModels: (o) => ollama.ollamaListModels(cfg, o),
      };
    default: {
      const never: never = config.kind;
      throw new Error(`未知的 AI 服务商类型: ${String(never)}`);
    }
  }
}
