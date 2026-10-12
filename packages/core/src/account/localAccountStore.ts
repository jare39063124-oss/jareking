/**
 * 本地账户存储：设备级单账户（v1 无注册登录、无联网）。
 * getOrCreate 幂等：首次启动创建设备账户，之后始终返回同一账户。
 */
import { randomUUID } from 'node:crypto';
import type { Database, Row } from '../db/database.js';
import type { LocalAccount } from '../contracts/account.js';

/** 默认昵称（spec 4.7：本机用户） */
const DEFAULT_NICKNAME = '本机用户';

export class LocalAccountStore {
  constructor(private readonly db: Database) {}

  /** 获取本机账户；首次调用时创建设备账户（deviceId 用 crypto.randomUUID） */
  getOrCreate(): LocalAccount {
    const existing = this.get();
    if (existing) return existing;
    const account: LocalAccount = {
      id: randomUUID(),
      deviceId: randomUUID(),
      nickname: DEFAULT_NICKNAME,
      createdAt: Date.now(),
    };
    this.db.transaction(() => {
      this.db.exec(
        'INSERT INTO accounts (id, device_id, nickname, created_at) VALUES (?, ?, ?, ?)',
        [account.id, account.deviceId, account.nickname, account.createdAt],
      );
    });
    this.db.save();
    return account;
  }

  /** 读取本机账户；不存在返回 null */
  get(): LocalAccount | null {
    const rows = this.db.all<Row>(
      'SELECT id, device_id, nickname, created_at FROM accounts LIMIT 1',
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row['id']),
      deviceId: String(row['device_id']),
      nickname: String(row['nickname']),
      createdAt: Number(row['created_at']),
    };
  }
}
