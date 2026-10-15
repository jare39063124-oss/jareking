/**
 * AI 算力计量（token → 积分 折算 + 用量流水）。
 *
 * 定位：本模块只做「折算 + 内存流水」这层**可复用服务**，不触碰任何 AI 调用业务逻辑；
 *       契约类型来自 `@jareking/core`（单一事实源，此处只 import，不重复定义）；
 *       落库与积分扣减由桌面层注入的 `persist` 回调承接（见 core/account/aiMeteringLedger.ts）。
 *
 * 计量口径（重要）：
 *   points = ceil( promptTokens/1000 * promptPointsPer1k + completionTokens/1000 * completionPointsPer1k )
 *   - 采用 **Math.ceil 向上取整**：不足 1 分的调用（只要 token 用量 > 0）记 1 分，避免「小额漏计」；
 *   - token 用量为 0（例如空响应）时记 0 分（不产生无意义流水）；
 *   - 单价为**可配置的参考值**，非官方计价，后续可在设置中按服务商自定义。
 */
import type {
  AiMetering,
  AiMeteringSummary,
  AiPricingRule,
  AiUsage,
  AiUsageRecord,
} from '@jareking/core';

/** 每 1000 token 的折算基数 */
const TOKENS_PER_UNIT = 1000;

/** 兜底匹配规则的通配符 */
const FALLBACK_MODEL_PATTERN = '*';

/**
 * 默认定价规则（**参考值，非官方计价，可配置**）。
 *
 * 匹配优先级由 `pickPricingRule` 决定：精确匹配 → 前缀匹配（最长优先）→ `*` 兜底。
 * 故此处顺序不敏感，但仍按「具体 → 通用」排列，便于阅读。
 * 单价单位：每 1000 token 消耗的积分。
 */
export const DEFAULT_PRICING_RULES: AiPricingRule[] = [
  // —— OpenAI 系 ——
  { modelPattern: 'gpt-4o-mini', promptPointsPer1k: 0.5, completionPointsPer1k: 1.5 },
  { modelPattern: 'gpt-4o', promptPointsPer1k: 5, completionPointsPer1k: 15 },
  { modelPattern: 'gpt-4', promptPointsPer1k: 10, completionPointsPer1k: 30 },
  { modelPattern: 'gpt-3.5', promptPointsPer1k: 0.5, completionPointsPer1k: 1.5 },
  // —— Anthropic Claude 系 ——
  { modelPattern: 'claude-3-5-sonnet', promptPointsPer1k: 3, completionPointsPer1k: 15 },
  { modelPattern: 'claude-3-5-haiku', promptPointsPer1k: 0.8, completionPointsPer1k: 4 },
  { modelPattern: 'claude-3-opus', promptPointsPer1k: 15, completionPointsPer1k: 75 },
  { modelPattern: 'claude-3-haiku', promptPointsPer1k: 0.5, completionPointsPer1k: 1.5 },
  { modelPattern: 'claude-3', promptPointsPer1k: 3, completionPointsPer1k: 15 },
  // —— Google Gemini 系 ——
  { modelPattern: 'gemini-1.5-pro', promptPointsPer1k: 2.5, completionPointsPer1k: 7.5 },
  { modelPattern: 'gemini-1.5-flash', promptPointsPer1k: 0.075, completionPointsPer1k: 0.3 },
  { modelPattern: 'gemini', promptPointsPer1k: 1, completionPointsPer1k: 3 },
  // —— 国产 / 兼容网关 ——
  { modelPattern: 'deepseek-chat', promptPointsPer1k: 0.5, completionPointsPer1k: 1.5 },
  { modelPattern: 'deepseek', promptPointsPer1k: 0.5, completionPointsPer1k: 1.5 },
  { modelPattern: 'qwen', promptPointsPer1k: 1, completionPointsPer1k: 3 },
  { modelPattern: 'glm', promptPointsPer1k: 1, completionPointsPer1k: 3 },
  // —— 兜底（未识别模型一律按最低档计费，避免漏计） ——
  { modelPattern: FALLBACK_MODEL_PATTERN, promptPointsPer1k: 1, completionPointsPer1k: 2 },
];

/** 当调用方自定义规则未提供 `*` 兜底时的最后防线（确保 pickPricingRule 永不返回 undefined） */
export const ULTIMATE_FALLBACK_RULE: AiPricingRule = {
  modelPattern: FALLBACK_MODEL_PATTERN,
  promptPointsPer1k: 1,
  completionPointsPer1k: 2,
};

/**
 * 选取模型对应的定价规则。
 * 优先级：① 精确匹配（大小写不敏感）→ ② 前缀匹配（最长前缀优先）→ ③ `*` 兜底。
 * @param model 模型名（如 'gpt-4o-mini-2024-07-18'）
 * @param rules 规则表，缺省用 DEFAULT_PRICING_RULES
 */
export function pickPricingRule(
  model: string,
  rules: AiPricingRule[] = DEFAULT_PRICING_RULES,
): AiPricingRule {
  const normalized = model.trim().toLowerCase();

  // ① 精确匹配（忽略大小写与首尾空白）
  const exact = rules.find((rule) => rule.modelPattern.toLowerCase() === normalized);
  if (exact) return exact;

  // ② 前缀匹配：命中最长前缀者胜出（排除 `*` 兜底规则）
  let best: AiPricingRule | null = null;
  for (const rule of rules) {
    const pattern = rule.modelPattern.toLowerCase();
    if (pattern === FALLBACK_MODEL_PATTERN) continue;
    if (normalized.startsWith(pattern)) {
      if (!best || pattern.length > best.modelPattern.length) best = rule;
    }
  }
  if (best) return best;

  // ③ `*` 兜底
  const fallback = rules.find((rule) => rule.modelPattern === FALLBACK_MODEL_PATTERN);
  return fallback ?? ULTIMATE_FALLBACK_RULE;
}

/**
 * 按模型与用量折算积分（向上取整）。
 *
 * @param usage 单次调用用量
 * @param model 模型名
 * @param rules 规则表，缺省用 DEFAULT_PRICING_RULES
 * @returns 消耗积分（整数；用量为 0 时返回 0）
 */
export function computePoints(
  usage: AiUsage,
  model: string,
  rules: AiPricingRule[] = DEFAULT_PRICING_RULES,
): number {
  const rule = pickPricingRule(model, rules);
  const raw =
    (usage.promptTokens / TOKENS_PER_UNIT) * rule.promptPointsPer1k +
    (usage.completionTokens / TOKENS_PER_UNIT) * rule.completionPointsPer1k;
  return roundPoints(raw);
}

/** 取整策略：向上取整；非正/非法值一律记 0 分 */
function roundPoints(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.ceil(raw);
}

/** createAiMeteringService 的可选参数 */
export interface AiMeteringOptions {
  /** 自定义定价规则表（缺省用 DEFAULT_PRICING_RULES） */
  rules?: AiPricingRule[];
  /** 落库回调（供桌面层写入 ai_usage 表 / 扣减积分）；抛错时不入内存、向上抛出 */
  persist?: (record: AiUsageRecord) => void;
  /** 初始流水（用于从持久层加载历史） */
  initialRecords?: AiUsageRecord[];
}

/**
 * 创建 AI 算力计量服务（内存实现）。
 *
 * - 记录为**倒序**返回（最新在前）；
 * - `persist` 在入内存**之前**调用：先落库成功再更新内存，保证内存与持久层一致；
 *   若落库抛错（如积分不足），则本次不产生内存记录，异常向上抛出由调用方处理。
 *
 * @param opts 可选配置（规则 / 落库回调 / 初始流水）
 */
export function createAiMeteringService(opts: AiMeteringOptions = {}): AiMetering {
  const rules = opts.rules ?? DEFAULT_PRICING_RULES;
  const persist = opts.persist;
  const records: AiUsageRecord[] = [...(opts.initialRecords ?? [])];

  return {
    computePoints: (usage: AiUsage, model: string): number => computePoints(usage, model, rules),

    record: (
      usage: AiUsage,
      ctx: { model: string; configId?: string; feature?: string },
    ): AiUsageRecord => {
      const record: AiUsageRecord = {
        id: createRecordId(),
        at: Date.now(),
        model: ctx.model,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
        points: computePoints(usage, ctx.model, rules),
      };
      if (ctx.configId !== undefined) record.configId = ctx.configId;
      if (ctx.feature !== undefined) record.feature = ctx.feature;

      // 先落库（可能因积分不足抛错），成功后再进内存，保证二者一致
      if (persist) persist(record);
      records.push(record);
      return record;
    },

    // 倒序：先反转（插入序 → 最新在前），再按时间稳定降序，保证同一毫秒内仍是「最新在前」
    listRecords: (): AiUsageRecord[] => [...records].reverse().sort((a, b) => b.at - a.at),

    summary: (): AiMeteringSummary => summarize(records),
  };
}

/** 汇总内存流水 */
function summarize(records: AiUsageRecord[]): AiMeteringSummary {
  const summary: AiMeteringSummary = {
    totalCalls: records.length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalPoints: 0,
  };
  for (const record of records) {
    summary.promptTokens += record.usage.promptTokens;
    summary.completionTokens += record.usage.completionTokens;
    summary.totalTokens += record.usage.totalTokens;
    summary.totalPoints += record.points;
  }
  return summary;
}

/**
 * 生成本地唯一 id。
 * 采用全局 `crypto.randomUUID`（Node 18+ / 浏览器 / Electron 渲染进程均可用），
 * 不可用时回退到「时间戳 + 随机数」，保持本包在任意宿主下的同构可用性。
 */
function createRecordId(): string {
  const webCrypto: Crypto | undefined =
    typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  return `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
