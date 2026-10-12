/**
 * AI 层契约（Phase 4 实施，当前仅接口定义）。
 */

/** AI 服务商类型 */
export type AiProviderKind = 'openai-compatible' | 'claude' | 'gemini' | 'ollama';

/** 用户 AI 配置（apiKeyRef 指向 keytar/DPAPI 加密存储，契约中不含明文） */
export interface AiConfig {
  id: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  apiKeyRef: string;
  model: string;
  enabled: boolean;
  createdAt: number;
}

/** AI 结构化操作指令（Planner 输出，Executor 确定性执行） */
export interface AiOperation {
  op: string;
  [key: string]: unknown;
}

/** AI 执行计划 */
export interface AiPlan {
  operations: AiOperation[];
  explanation: string;
  /** 预估消耗积分 */
  estimatedPoints: number;
}

/** 模型用量（积分计量依据） */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
