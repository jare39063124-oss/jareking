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

/* ------------------------------------------------------------------ *
 * AI 算力计量（token → 积分 折算）
 * 说明：仅定义接口（单一事实源），实现见 packages/ai/src/metering.ts，
 *       持久化与积分联动见 packages/core/src/account/aiMeteringLedger.ts。
 * ------------------------------------------------------------------ */

/** 模型定价规则（token → 积分 折算） */
export interface AiPricingRule {
  /** 模型匹配：精确或前缀（如 "gpt-4o" / "claude-3" / "deepseek" / "*" 兜底） */
  modelPattern: string;
  /** 每 1000 prompt token 消耗积分 */
  promptPointsPer1k: number;
  /** 每 1000 completion token 消耗积分 */
  completionPointsPer1k: number;
}

/** 一次 AI 调用的用量记录（计量流水） */
export interface AiUsageRecord {
  id: string;
  /** 时间戳 ms */
  at: number;
  /** 模型名 */
  model: string;
  /** 配置 id（可选） */
  configId?: string;
  /** 功能标签（如 'writer-polish' / 'sheet-formula'，可选） */
  feature?: string;
  usage: AiUsage;
  /** 折算积分（可含小数或取整，按你的规则注释说明） */
  points: number;
}

/** 计量汇总 */
export interface AiMeteringSummary {
  totalCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalPoints: number;
}

/** 算力计量服务接口（实现见 packages/ai，持久化见 core/account） */
export interface AiMetering {
  /** 按模型与用量折算积分 */
  computePoints(usage: AiUsage, model: string): number;
  /** 记录一次调用用量，返回流水记录 */
  record(usage: AiUsage, ctx: { model: string; configId?: string; feature?: string }): AiUsageRecord;
  /** 列出流水（倒序） */
  listRecords(): AiUsageRecord[];
  /** 汇总 */
  summary(): AiMeteringSummary;
}
