/**
 * AI 算力计量持久层（core/account）。
 *
 * 职责：
 *   ① `ai_usage` 表读写（用量流水，供「算力用量」汇总与列表）；
 *   ② 用量积分与积分账本联动（复用 PointsLedger.debit + PointsReason 'ai-consume'）。
 *
 * 计量口径：见 packages/ai/src/metering.ts（points = 向上取整的 token→积分折算）。
 * 单一来源：积分变动原因复用 contracts/account.ts 已有的 `'ai-consume'`（即「AI 调用消耗」），
 *           不新增重复枚举；用量/汇总类型复用 contracts/ai.ts（AiUsageRecord / AiMeteringSummary）。
 */
import type { Database, Row } from '../db/database.js';
import type { AiMeteringSummary, AiUsageRecord } from '../contracts/ai.js';
import type { PointsEntry, PointsReason } from '../contracts/account.js';
import { PointsLedger } from './pointsLedger.js';

/** AI 调用消耗积分对应的积分变动原因（复用既有枚举，语义即「AI 调用消耗」） */
const AI_CONSUME_REASON: PointsReason = 'ai-consume';

export class AiMeteringLedger {
  /** 积分账本（复用同一 Database，保证与账户余额同源） */
  private readonly points: PointsLedger;

  constructor(private readonly db: Database) {
    this.points = new PointsLedger(db);
  }

  /**
   * 写入一条用量流水（**不扣分**，仅登记；供汇总 / 列表 / 由外部单独扣减时使用）。
   * @param record 用量记录
   */
  insertRecord(record: AiUsageRecord): AiUsageRecord {
    this.db.exec(
      `INSERT INTO ai_usage
         (id, at, model, config_id, feature, prompt_tokens, completion_tokens, total_tokens, points)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.at,
        record.model,
        record.configId ?? null,
        record.feature ?? null,
        record.usage.promptTokens,
        record.usage.completionTokens,
        record.usage.totalTokens,
        record.points,
      ],
    );
    this.db.save();
    return record;
  }

  /**
   * 事务内：写入用量流水 + 扣减对应积分（原子）。
   * 扣分失败（如余额不足）时整笔回滚，保证「有流水必有扣分」不出现半截状态。
   * @returns 写入的用量记录
   */
  recordAndDebit(record: AiUsageRecord): AiUsageRecord {
    return this.db.transaction(() => {
      this.insertRecord(record);
      this.debitForAi(record.points, { model: record.model, feature: record.feature });
      return record;
    });
  }

  /**
   * 按用量积分扣减积分账本（复用 PointsLedger.debit，reason='ai-consume'）。
   * @param points 折算积分（<=0 时视为无消耗，返回 null）
   * @param meta 计费上下文（模型名 + 可选功能标签，写入流水 detail 便于对账）
   * @returns 积分流水条目；无消耗时返回 null
   */
  debitForAi(
    points: number,
    meta: { model: string; feature?: string },
  ): PointsEntry | null {
    if (!Number.isFinite(points) || points <= 0) return null;
    // 账本要求正整数：兜底向上取整并至少 1 分，避免四舍五入后为 0 的调用漏扣
    const amount = Math.max(1, Math.ceil(points));
    const detail = meta.feature
      ? `AI 调用：${meta.model}（${meta.feature}）`
      : `AI 调用：${meta.model}`;
    return this.points.debit(amount, AI_CONSUME_REASON, detail);
  }

  /** 列出用量流水（按时间倒序；同一毫秒内按写入顺序倒序） */
  listRecords(limit = 50, offset = 0): AiUsageRecord[] {
    const rows = this.db.all<Row>(
      `SELECT id, at, model, config_id, feature, prompt_tokens, completion_tokens, total_tokens, points
       FROM ai_usage
       ORDER BY at DESC, rowid DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map(toRecord);
  }

  /** 汇总全部用量（无流水时全 0） */
  summary(): AiMeteringSummary {
    const rows = this.db.all<Row>(
      `SELECT
         COUNT(*)                        AS calls,
         COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)      AS total_tokens,
         COALESCE(SUM(points), 0)            AS points
       FROM ai_usage`,
    );
    const row = rows[0];
    return {
      totalCalls: Number(row?.['calls'] ?? 0),
      promptTokens: Number(row?.['prompt_tokens'] ?? 0),
      completionTokens: Number(row?.['completion_tokens'] ?? 0),
      totalTokens: Number(row?.['total_tokens'] ?? 0),
      totalPoints: Number(row?.['points'] ?? 0),
    };
  }
}

/** 行对象 → AiUsageRecord（可选字段为空时不带该字段） */
function toRecord(row: Row): AiUsageRecord {
  const record: AiUsageRecord = {
    id: String(row['id']),
    at: Number(row['at']),
    model: String(row['model']),
    usage: {
      promptTokens: Number(row['prompt_tokens']),
      completionTokens: Number(row['completion_tokens']),
      totalTokens: Number(row['total_tokens']),
    },
    points: Number(row['points']),
  };
  if (row['config_id'] !== null && row['config_id'] !== undefined) {
    record.configId = String(row['config_id']);
  }
  if (row['feature'] !== null && row['feature'] !== undefined) {
    record.feature = String(row['feature']);
  }
  return record;
}
