/** 积分账本测试：credit/debit、余额不足、balanceAfter 连续性、signup 幂等 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InsufficientPointsError,
  PointsLedger,
  SIGNUP_BONUS_AMOUNT,
} from '../src/account/pointsLedger.js';
import { createTestDb, type TestDb } from './helpers.js';

describe('PointsLedger', () => {
  let ctx: TestDb;
  let ledger: PointsLedger;

  beforeEach(async () => {
    ctx = await createTestDb();
    ledger = new PointsLedger(ctx.db);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('credit 正常入账，余额与 balanceAfter 正确', () => {
    const entry = ledger.credit(100, 'redeem', '兑换码 A');
    expect(entry.delta).toBe(100);
    expect(entry.balanceAfter).toBe(100);
    expect(entry.reason).toBe('redeem');
    expect(entry.detail).toBe('兑换码 A');
    expect(ledger.getBalance().balance).toBe(100);
  });

  it('debit 正常扣减', () => {
    ledger.credit(100, 'redeem');
    const entry = ledger.debit(30, 'ai-consume', 'AI 摘要');
    expect(entry.delta).toBe(-30);
    expect(entry.balanceAfter).toBe(70);
    expect(ledger.getBalance().balance).toBe(70);
  });

  it('余额不足时拒绝扣减且不产生流水', () => {
    ledger.credit(50, 'redeem');
    expect(() => ledger.debit(51, 'feature')).toThrow(InsufficientPointsError);
    expect(ledger.getBalance().balance).toBe(50);
    expect(ledger.listEntries()).toHaveLength(1);
  });

  it('余额不足错误携带当前余额与需求数量', () => {
    ledger.credit(50, 'redeem');
    try {
      ledger.debit(80, 'feature');
      expect.unreachable('应当抛出 InsufficientPointsError');
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientPointsError);
      expect((error as InsufficientPointsError).balance).toBe(50);
      expect((error as InsufficientPointsError).required).toBe(80);
    }
  });

  it('balanceAfter 保持连续：每条流水等于上一条余额加本次变动', () => {
    ledger.credit(1000, 'signup');
    ledger.debit(300, 'ai-consume');
    ledger.credit(500, 'redeem');
    ledger.debit(200, 'feature');

    const entries = ledger.listEntries().reverse(); // 转为时间正序
    expect(entries).toHaveLength(4);

    let expected = 0;
    for (const entry of entries) {
      expected += entry.delta;
      expect(entry.balanceAfter).toBe(expected);
    }
    // 账目可对账：最后一条 balanceAfter 即当前余额
    expect(ledger.getBalance().balance).toBe(entries[3]!.balanceAfter);
    expect(entries[3]!.balanceAfter).toBe(1000);
  });

  it('ensureSignupBonus 首次赠送 1000 积分，重复调用幂等', () => {
    const first = ledger.ensureSignupBonus();
    expect(first).not.toBeNull();
    expect(first!.delta).toBe(SIGNUP_BONUS_AMOUNT);
    expect(first!.reason).toBe('signup');
    expect(ledger.getBalance().balance).toBe(SIGNUP_BONUS_AMOUNT);

    // 再次调用不再发放
    const second = ledger.ensureSignupBonus();
    expect(second).toBeNull();
    expect(ledger.getBalance().balance).toBe(SIGNUP_BONUS_AMOUNT);
    expect(ledger.listEntries()).toHaveLength(1);
  });

  it('已有其他流水后 ensureSignupBonus 仍会补发 signup 赠送', () => {
    ledger.credit(100, 'redeem');
    const bonus = ledger.ensureSignupBonus();
    expect(bonus).not.toBeNull();
    expect(ledger.getBalance().balance).toBe(100 + SIGNUP_BONUS_AMOUNT);
  });

  it('listEntries 支持分页（limit / offset）', () => {
    for (let i = 1; i <= 5; i += 1) {
      ledger.credit(i * 10, 'redeem');
    }
    const page1 = ledger.listEntries(2, 0);
    expect(page1).toHaveLength(2);
    // 倒序：最新的一条（50）在最前
    expect(page1[0]!.delta).toBe(50);
    expect(page1[1]!.delta).toBe(40);

    const page2 = ledger.listEntries(2, 2);
    expect(page2.map((e) => e.delta)).toEqual([30, 20]);

    const page3 = ledger.listEntries(2, 4);
    expect(page3.map((e) => e.delta)).toEqual([10]);
  });

  it('拒绝非正整数的 credit / debit 金额', () => {
    expect(() => ledger.credit(0, 'redeem')).toThrow();
    expect(() => ledger.credit(-10, 'redeem')).toThrow();
    expect(() => ledger.credit(1.5, 'redeem')).toThrow();
    expect(() => ledger.debit(0, 'ai-consume')).toThrow();
    expect(() => ledger.debit(-5, 'ai-consume')).toThrow();
    expect(() => ledger.debit(2.5, 'ai-consume')).toThrow();
    expect(ledger.getBalance().balance).toBe(0);
    expect(ledger.listEntries()).toHaveLength(0);
  });

  it('空账本余额为 0', () => {
    expect(ledger.getBalance()).toEqual({ balance: 0, updatedAt: 0 });
    expect(ledger.listEntries()).toEqual([]);
  });
});
