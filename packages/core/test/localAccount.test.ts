/** 本地账户测试：getOrCreate 幂等、持久化 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalAccountStore } from '../src/account/localAccountStore.js';
import { Database } from '../src/db/database.js';
import { createTestDb, type TestDb } from './helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('LocalAccountStore', () => {
  let ctx: TestDb;
  let store: LocalAccountStore;

  beforeEach(async () => {
    ctx = await createTestDb();
    store = new LocalAccountStore(ctx.db);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('首次 getOrCreate 创建设备账户（默认昵称"本机用户"，UUID 标识）', () => {
    const account = store.getOrCreate();
    expect(account.id).toMatch(UUID_RE);
    expect(account.deviceId).toMatch(UUID_RE);
    expect(account.nickname).toBe('本机用户');
    expect(account.createdAt).toBeGreaterThan(0);
  });

  it('getOrCreate 幂等：重复调用返回同一账户', () => {
    const first = store.getOrCreate();
    const second = store.getOrCreate();
    const third = store.getOrCreate();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // 数据库中只有一条账户记录
    const rows = ctx.db.all('SELECT id FROM accounts');
    expect(rows).toHaveLength(1);
  });

  it('创建前 get() 为 null，创建后 get() 与 getOrCreate() 一致', () => {
    expect(store.get()).toBeNull();
    const account = store.getOrCreate();
    expect(store.get()).toEqual(account);
  });

  it('账户持久化：落盘重开数据库后仍是同一账户', () => {
    const account = store.getOrCreate();
    ctx.db.close(); // close 会 flush 落盘

    // 重开同一数据库文件
    return Database.open(ctx.dbPath).then((reopened) => {
      try {
        const reopenedStore = new LocalAccountStore(reopened);
        expect(reopenedStore.get()).toEqual(account);
        // 重开后 getOrCreate 不会重复创建
        expect(reopenedStore.getOrCreate()).toEqual(account);
      } finally {
        reopened.close();
      }
    });
  });
});
