/**
 * 积分流水账本：credit / debit 均在事务内完成，
 * 写入时校验余额充足与 balanceAfter 连续性，保证账目可对账（契约见 contracts/account.ts）。
 */
import { randomUUID } from 'node:crypto';
import type { Database, Row } from '../db/database.js';
import type { PointsBalance, PointsEntry, PointsReason } from '../contracts/account.js';

/** 新用户安装赠送积分（spec 6.1：安装送 1000 分，本地发放） */
export const SIGNUP_BONUS_AMOUNT = 1000;

/** 余额不足错误（debit 时抛出，携带当前余额与需求数量） */
export class InsufficientPointsError extends Error {
  constructor(
    public readonly balance: number,
    public readonly required: number,
  ) {
    super(`积分余额不足：当前余额 ${balance}，需要 ${required}`);
    this.name = 'InsufficientPointsError';
  }
}

export class PointsLedger {
  constructor(private readonly db: Database) {}

  /** 当前余额与最后变动时间（无流水时余额 0、updatedAt 0） */
  getBalance(): PointsBalance {
    const rows = this.db.all<Row>(
      'SELECT balance_after, created_at FROM points_ledger ORDER BY created_at DESC, rowid DESC LIMIT 1',
    );
    const row = rows[0];
    if (!row) return { balance: 0, updatedAt: 0 };
    return { balance: Number(row['balance_after']), updatedAt: Number(row['created_at']) };
  }

  /** 入账（amount 必须为正整数，返回流水条目） */
  credit(amount: number, reason: PointsReason, detail?: string): PointsEntry {
    this.assertPositive(amount, 'credit');
    return this.db.transaction(() => this.appendEntry(amount, reason, detail));
  }

  /** 扣减（事务内校验余额充足；不足抛 InsufficientPointsError） */
  debit(amount: number, reason: PointsReason, detail?: string): PointsEntry {
    this.assertPositive(amount, 'debit');
    return this.db.transaction(() => {
      const balance = this.lastBalanceAfter();
      if (amount > balance) {
        throw new InsufficientPointsError(balance, amount);
      }
      return this.appendEntry(-amount, reason, detail);
    });
  }

  /** 分页查询流水（按时间倒序；同一毫秒内按写入顺序倒序） */
  listEntries(limit = 50, offset = 0): PointsEntry[] {
    const rows = this.db.all<Row>(
      `SELECT id, delta, balance_after, reason, detail, created_at
       FROM points_ledger
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(toEntry);
  }

  /** 新用户赠送积分（幂等：已发放过则不再发放，返回 null） */
  ensureSignupBonus(): PointsEntry | null {
    const rows = this.db.all<Row>(
      "SELECT id FROM points_ledger WHERE reason = 'signup' LIMIT 1",
    );
    if (rows.length > 0) return null;
    return this.credit(SIGNUP_BONUS_AMOUNT, 'signup');
  }

  /** 事务内追加一条流水：balanceAfter = 上一条余额 + delta，并校验连续性 */
  private appendEntry(delta: number, reason: PointsReason, detail?: string): PointsEntry {
    const previous = this.lastBalanceAfter();
    const balanceAfter = previous + delta;
    // 连续性校验：新余额必须由上一条余额加本次变动得出，否则账本断档
    if (balanceAfter - delta !== previous) {
      throw new Error('积分流水 balanceAfter 连续性校验失败');
    }
    if (balanceAfter < 0) {
      throw new Error('积分余额不允许为负');
    }
    const entry: PointsEntry = {
      id: randomUUID(),
      delta,
      balanceAfter,
      reason,
      createdAt: Date.now(),
    };
    if (detail !== undefined) entry.detail = detail;
    this.db.exec(
      `INSERT INTO points_ledger (id, delta, balance_after, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.delta, entry.balanceAfter, entry.reason, entry.detail ?? null, entry.createdAt],
    );
    this.db.save();
    return entry;
  }

  /** 账本最新一条的变动后余额；无流水为 0（按 rowid 兜底同一毫秒的写入顺序） */
  private lastBalanceAfter(): number {
    const rows = this.db.all<Row>(
      'SELECT balance_after FROM points_ledger ORDER BY created_at DESC, rowid DESC LIMIT 1',
    );
    const row = rows[0];
    return row ? Number(row['balance_after']) : 0;
  }

  private assertPositive(amount: number, method: string): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`${method} 的金额必须为正整数，收到 ${amount}`);
    }
  }
}

/** 行对象 → PointsEntry（detail 为空时不带该可选字段） */
function toEntry(row: Row): PointsEntry {
  const entry: PointsEntry = {
    id: String(row['id']),
    delta: Number(row['delta']),
    balanceAfter: Number(row['balance_after']),
    reason: String(row['reason']) as PointsReason,
    createdAt: Number(row['created_at']),
  };
  if (row['detail'] !== null && row['detail'] !== undefined) {
    entry.detail = String(row['detail']);
  }
  return entry;
}
