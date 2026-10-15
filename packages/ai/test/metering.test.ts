/** AI 算力计量服务测试：定价规则匹配、积分折算取整、内存服务 record/list/summary、persist 回调 */
import { describe, expect, it, vi } from 'vitest';
import type { AiPricingRule, AiUsage, AiUsageRecord } from '@jareking/core';
import {
  DEFAULT_PRICING_RULES,
  ULTIMATE_FALLBACK_RULE,
  computePoints,
  createAiMeteringService,
  pickPricingRule,
} from '../src/metering.js';

/** 构造用量 */
function usage(promptTokens: number, completionTokens: number): AiUsage {
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

describe('pickPricingRule', () => {
  it('精确匹配优先（大小写不敏感、忽略首尾空白）', () => {
    expect(pickPricingRule('gpt-4o-mini').promptPointsPer1k).toBe(0.5);
    expect(pickPricingRule('GPT-4O').promptPointsPer1k).toBe(5);
    expect(pickPricingRule('  deepseek-chat  ').completionPointsPer1k).toBe(1.5);
  });

  it('前缀匹配时最长前缀优先', () => {
    // 'gpt-4o-mini-...' 应命中 gpt-4o-mini（而非更短的 gpt-4o）
    const miniDated = pickPricingRule('gpt-4o-mini-2024-07-18');
    expect(miniDated.modelPattern).toBe('gpt-4o-mini');

    const sonnetDated = pickPricingRule('claude-3-5-sonnet-20241022');
    expect(sonnetDated.modelPattern).toBe('claude-3-5-sonnet');

    // 非精确的前缀：'claude-3-5-sonnet-latest' → claude-3-5-sonnet
    expect(pickPricingRule('claude-3-5-sonnet-latest').modelPattern).toBe('claude-3-5-sonnet');
  });

  it('未命中任何特定规则时回退到 * 兜底', () => {
    const rule = pickPricingRule('some-unknown-model-v9');
    expect(rule.modelPattern).toBe('*');
    expect(rule.promptPointsPer1k).toBe(1);
    expect(rule.completionPointsPer1k).toBe(2);
  });

  it('自定义规则表缺少 * 时，返回最后防线规则（永不 undefined）', () => {
    const rules: AiPricingRule[] = [
      { modelPattern: 'foo', promptPointsPer1k: 9, completionPointsPer1k: 9 },
    ];
    expect(pickPricingRule('bar', rules)).toEqual(ULTIMATE_FALLBACK_RULE);
  });

  it('自定义规则表按最长前缀选中', () => {
    const rules: AiPricingRule[] = [
      { modelPattern: 'ab', promptPointsPer1k: 1, completionPointsPer1k: 1 },
      { modelPattern: 'abc', promptPointsPer1k: 2, completionPointsPer1k: 2 },
      { modelPattern: '*', promptPointsPer1k: 9, completionPointsPer1k: 9 },
    ];
    expect(pickPricingRule('abcd', rules).promptPointsPer1k).toBe(2);
  });
});

describe('computePoints', () => {
  it('用量为 0 记 0 分', () => {
    expect(computePoints(usage(0, 0), 'gpt-4o')).toBe(0);
  });

  it('按每 1000 token 单价折算（无小数时精确）', () => {
    // gpt-4o：prompt 5/1k，completion 15/1k
    expect(computePoints(usage(1000, 0), 'gpt-4o')).toBe(5);
    expect(computePoints(usage(0, 1000), 'gpt-4o')).toBe(15);
    expect(computePoints(usage(1000, 1000), 'gpt-4o')).toBe(20);
  });

  it('向上取整：小额调用至少记 1 分', () => {
    // gpt-4o-mini：0.5/1k、1.5/1k → 0.05 + 0.075 = 0.125 → ceil = 1
    expect(computePoints(usage(100, 50), 'gpt-4o-mini')).toBe(1);
    // gpt-4o：200/1000*5=1.0，100/1000*15=1.5 → 2.5 → ceil = 3
    expect(computePoints(usage(200, 100), 'gpt-4o')).toBe(3);
    // 极小用量（1 token）仍记 1 分
    expect(computePoints(usage(1, 0), 'gpt-4o')).toBe(1);
  });

  it('未知模型走 * 兜底单价', () => {
    // 兜底 1/1k、2/1k → 1000 prompt + 500 completion = 1 + 1 = 2
    expect(computePoints(usage(1000, 500), 'totally-unknown')).toBe(2);
  });

  it('支持自定义规则表', () => {
    const rules: AiPricingRule[] = [
      { modelPattern: '*', promptPointsPer1k: 1000, completionPointsPer1k: 1000 },
    ];
    expect(computePoints(usage(1, 1), 'any', rules)).toBe(2);
  });
});

describe('createAiMeteringService', () => {
  it('record 折算积分并生成完整流水；listRecords 倒序；summary 汇总', () => {
    const service = createAiMeteringService();
    const r1 = service.record(usage(1000, 0), { model: 'gpt-4o', feature: 'writer-polish' });
    const r2 = service.record(usage(0, 1000), { model: 'claude-3-5-sonnet', configId: 'cfg-1' });

    expect(r1.points).toBe(5);
    expect(r1.feature).toBe('writer-polish');
    expect(r2.points).toBe(15);
    expect(r2.configId).toBe('cfg-1');
    expect(r1.id).toBeTruthy();
    expect(r1.at).toBeGreaterThan(0);

    // 倒序：后录入的在前
    const records = service.listRecords();
    expect(records.map((r) => r.id)).toEqual([r2.id, r1.id]);

    expect(service.summary()).toEqual({
      totalCalls: 2,
      promptTokens: 1000,
      completionTokens: 1000,
      totalTokens: 2000,
      totalPoints: 20,
    });
  });

  it('computePoints 方法使用服务创建时的规则表', () => {
    const rules: AiPricingRule[] = [
      { modelPattern: '*', promptPointsPer1k: 1000, completionPointsPer1k: 0 },
    ];
    const service = createAiMeteringService({ rules });
    expect(service.computePoints(usage(2, 0), 'anything')).toBe(2);
  });

  it('persist 回调每记录一次被调用一次，且先于入内存（记录在回调中可见）', () => {
    const seen: AiUsageRecord[] = [];
    const persist = vi.fn((record: AiUsageRecord) => {
      seen.push(record);
    });
    const service = createAiMeteringService({ persist });

    const record = service.record(usage(1000, 1000), { model: 'gpt-4o' });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual(record);
    expect(service.listRecords()).toHaveLength(1);
  });

  it('persist 抛错时不入内存并向上抛出（保持内存与持久层一致）', () => {
    const persist = vi.fn(() => {
      throw new Error('落库失败');
    });
    const service = createAiMeteringService({ persist });

    expect(() => service.record(usage(1000, 0), { model: 'gpt-4o' })).toThrow('落库失败');
    expect(service.listRecords()).toHaveLength(0);
    expect(service.summary().totalCalls).toBe(0);
  });

  it('initialRecords 作为初始流水载入并被汇总', () => {
    const seed: AiUsageRecord[] = [
      {
        id: 'seed-1',
        at: 100,
        model: 'gpt-4o-mini',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        points: 1,
      },
    ];
    const service = createAiMeteringService({ initialRecords: seed });
    expect(service.listRecords()).toHaveLength(1);
    expect(service.summary().totalPoints).toBe(1);
  });
});

describe('DEFAULT_PRICING_RULES', () => {
  it('包含 * 兜底规则（最后一项）', () => {
    const last = DEFAULT_PRICING_RULES[DEFAULT_PRICING_RULES.length - 1]!;
    expect(last.modelPattern).toBe('*');
  });
});
