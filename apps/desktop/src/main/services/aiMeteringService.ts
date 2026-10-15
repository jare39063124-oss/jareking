/**
 * AI 算力计量服务（主进程）。
 *
 * 组合两个层次：
 *   - core `AiMeteringLedger`：用量流水持久化（`ai_usage` 表）+ 积分联动（'ai-consume'）；
 *   - packages/ai `createAiMeteringService`：token→积分折算 + 内存流水（可复用服务）。
 *
 * `persist` 回调把每次计量落到 `recordAndDebit`（事务内写流水 + 扣分），
 * 于是内存流水与本地库保持一致；查询路径（汇总/列表）一律读库，保证跨会话稳定。
 *
 * 注意：本轮**不改动现有 AI 调用业务逻辑**，`recordAndDebit` 仅作为后续 AI 功能的
 * 预留接入钩子——目前没有任何调用点触发它，因此不会改变现有行为、也不会扣用户积分。
 */
import {
  AiMeteringLedger,
  type AiMetering,
  type AiMeteringSummary,
  type AiUsage,
  type AiUsageRecord,
  type Database,
} from '@jareking/core';
import { createAiMeteringService } from '@jareking/ai';
import { getDb } from './db.js';

/** 内存初始加载 + 列表默认返回的最大流水条数 */
const MAX_RECORDS = 100;

export class AiMeteringService {
  /** 持久层：用量流水读写 + 积分联动 */
  readonly ledger: AiMeteringLedger;
  /** 折算/内存服务（persist 已接到底层账本） */
  readonly metering: AiMetering;

  constructor(db: Database) {
    this.ledger = new AiMeteringLedger(db);
    this.metering = createAiMeteringService({
      // 用库里已有流水初始化内存，保持内存与持久层一致
      initialRecords: this.ledger.listRecords(MAX_RECORDS),
      // 每次计量：事务内写流水 + 扣减积分（余额不足则整体回滚并抛错）
      persist: (record) => {
        this.ledger.recordAndDebit(record);
      },
    });
  }

  /**
   * 记录一次 AI 调用：折算积分 + 持久化流水 + 扣减积分。
   * 供后续 AI 功能（writer-polish / sheet-formula 等）接入时调用；本轮未接入任何调用点。
   */
  recordAndDebit(
    usage: AiUsage,
    ctx: { model: string; configId?: string; feature?: string },
  ): AiUsageRecord {
    return this.metering.record(usage, ctx);
  }

  /** 汇总（读库） */
  summary(): AiMeteringSummary {
    return this.ledger.summary();
  }

  /** 最近用量流水（读库，倒序） */
  listRecords(limit = MAX_RECORDS, offset = 0): AiUsageRecord[] {
    return this.ledger.listRecords(limit, offset);
  }
}

/** 计量服务单例（依赖数据库单例） */
let instance: AiMeteringService | null = null;

export async function getAiMeteringService(): Promise<AiMeteringService> {
  if (!instance) {
    instance = new AiMeteringService(await getDb());
  }
  return instance;
}
