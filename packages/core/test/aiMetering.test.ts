/** AI 算力计量持久层测试：用量流水读写、汇总、积分联动（'ai-consume'）、事务回滚 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiMeteringLedger } from '../src/account/aiMeteringLedger.js';
import { InsufficientPointsError, PointsLedger } from '../src/account/pointsLedger.js';
import type { AiUsageRecord } from '../src/contracts/ai.js';
import { createTestDb, type TestDb } from './helpers.js';

/** 构造一条用量记录（默认时间递增、模型固定） */
function makeRecord(overrides: Partial<AiUsageRecord> = {}): AiUsageRecord {
  return {
    id: overrides.id ?? `rec-${Math.random().toString(36).slice(2, 8)}`,
    at: overrides.at ?? 1000,
    model: overrides.model ?? 'gpt-4o-mini',
    usage: overrides.usage ?? { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    points: overrides.points ?? 1,
    ...(overrides.configId !== undefined ? { configId: overrides.configId } : {}),
    ...(overrides.feature !== undefined ? { feature: overrides.feature } : {}),
  };
}

describe('AiMeteringLedger', () => {
  let ctx: TestDb;
  let ledger: AiMeteringLedger;
  let points: PointsLedger;

  beforeEach(async () => {
    ctx = await createTestDb();
    ledger = new AiMeteringLedger(ctx.db);
    points = new PointsLedger(ctx.db);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('insertRecord 写入后可按倒序读出，可选字段正确往返', () => {
    ledger.insertRecord(makeRecord({ id: 'a', at: 1000 }));
    ledger.insertRecord(
      makeRecord({ id: 'b', at: 2000, configId: 'cfg-1', feature: 'writer-polish' }),
    );

    const records = ledger.listRecords();
    // 倒序：时间大的在前
    expect(records.map((r) => r.id)).toEqual(['b', 'a']);
    expect(records[0]).toEqual({
      id: 'b',
      at: 2000,
      model: 'gpt-4o-mini',
      configId: 'cfg-1',
      feature: 'writer-polish',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      points: 1,
    });
    // 无可选字段时不带该字段
    expect(records[1]).not.toHaveProperty('configId');
    expect(records[1]).not.toHaveProperty('feature');
  });

  it('summary 汇总调用数 / token / 积分', () => {
    ledger.insertRecord(
      makeRecord({
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        points: 3,
      }),
    );
    ledger.insertRecord(
      makeRecord({
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
        points: 1,
      }),
    );

    expect(ledger.summary()).toEqual({
      totalCalls: 2,
      promptTokens: 1200,
      completionTokens: 600,
      totalTokens: 1800,
      totalPoints: 4,
    });
  });

  it('空表汇总全 0', () => {
    expect(ledger.summary()).toEqual({
      totalCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      totalPoints: 0,
    });
    expect(ledger.listRecords()).toEqual([]);
  });

  it('debitForAi 复用积分账本扣分（reason=ai-consume，detail 含模型与功能）', () => {
    points.credit(1000, 'signup');
    const entry = ledger.debitForAi(5, { model: 'gpt-4o', feature: 'sheet-formula' });
    expect(entry).not.toBeNull();
    expect(entry!.delta).toBe(-5);
    expect(entry!.reason).toBe('ai-consume');
    expect(entry!.balanceAfter).toBe(995);
    expect(entry!.detail).toContain('gpt-4o');
    expect(entry!.detail).toContain('sheet-formula');
  });

  it('debitForAi 对 <=0 / 非有限值不扣分（返回 null）', () => {
    points.credit(1000, 'signup');
    expect(ledger.debitForAi(0, { model: 'gpt-4o' })).toBeNull();
    expect(ledger.debitForAi(-3, { model: 'gpt-4o' })).toBeNull();
    expect(ledger.debitForAi(Number.NaN, { model: 'gpt-4o' })).toBeNull();
    expect(points.getBalance().balance).toBe(1000);
  });

  it('recordAndDebit 事务内写流水 + 扣分（余额与流水一致）', () => {
    points.credit(1000, 'signup');
    const record = ledger.recordAndDebit(
      makeRecord({ id: 'r1', model: 'claude-3-5-sonnet', points: 7, feature: 'writer-polish' }),
    );

    expect(ledger.listRecords()).toHaveLength(1);
    expect(ledger.listRecords()[0]!.id).toBe('r1');
    expect(points.getBalance().balance).toBe(993);
    const aiEntries = points.listEntries().filter((e) => e.reason === 'ai-consume');
    expect(aiEntries).toHaveLength(1);
    expect(aiEntries[0]!.delta).toBe(-7);
    expect(record.points).toBe(7);
  });

  it('recordAndDebit 余额不足时整笔回滚（不留下无扣分的流水）', () => {
    // 无任何入账：余额 0
    expect(() =>
      ledger.recordAndDebit(makeRecord({ id: 'rx', points: 10 })),
    ).toThrow(InsufficientPointsError);

    // 事务回滚：用量流水与积分流水都未写入
    expect(ledger.listRecords()).toEqual([]);
    expect(points.getBalance().balance).toBe(0);
    expect(points.listEntries()).toEqual([]);
  });

  it('listRecords 支持分页（limit / offset）', () => {
    for (let i = 1; i <= 5; i += 1) {
      ledger.insertRecord(makeRecord({ id: `rec-${i}`, at: i * 1000 }));
    }
    const page1 = ledger.listRecords(2, 0);
    expect(page1.map((r) => r.id)).toEqual(['rec-5', 'rec-4']);
    const page3 = ledger.listRecords(2, 4);
    expect(page3.map((r) => r.id)).toEqual(['rec-1']);
  });
});
