/**
 * 账户服务：封装 LocalAccountStore + PointsLedger，
 * 供 IPC / 渲染层调用（v1 全部本地，无服务端）。
 */
import {
  LocalAccountStore,
  PointsLedger,
  type Database,
  type LocalAccount,
  type PointsBalance,
  type PointsEntry,
} from '@jareking/core';
import { getDb } from './db.js';

export class AccountService {
  /** 本地账户存储 */
  readonly accounts: LocalAccountStore;
  /** 积分账本 */
  readonly points: PointsLedger;

  constructor(db: Database) {
    this.accounts = new LocalAccountStore(db);
    this.points = new PointsLedger(db);
  }

  /** 首次启动引导：确保账户存在并发放新用户积分（幂等） */
  bootstrapAccount(): { account: LocalAccount; balance: PointsBalance; bonus: PointsEntry | null } {
    const account = this.accounts.getOrCreate();
    const bonus = this.points.ensureSignupBonus();
    return { account, balance: this.points.getBalance(), bonus };
  }
}

/** 账户服务单例（依赖数据库单例） */
let instance: AccountService | null = null;

export async function getAccountService(): Promise<AccountService> {
  if (!instance) {
    instance = new AccountService(await getDb());
  }
  return instance;
}
