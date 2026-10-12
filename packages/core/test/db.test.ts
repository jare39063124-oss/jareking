/** Database 基础能力测试：事务提交/回滚/嵌套、防抖落盘 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, sleep, type TestDb } from './helpers.js';

describe('Database', () => {
  let ctx: TestDb;

  beforeEach(async () => {
    ctx = await createTestDb();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('transaction 正常提交', () => {
    ctx.db.transaction(() => {
      ctx.db.exec("INSERT INTO settings (key, value) VALUES ('a', '1')");
      ctx.db.exec("INSERT INTO settings (key, value) VALUES ('b', '2')");
    });
    expect(ctx.db.all('SELECT key FROM settings ORDER BY key')).toEqual([{ key: 'a' }, { key: 'b' }]);
  });

  it('transaction 出错整体回滚', () => {
    expect(() =>
      ctx.db.transaction(() => {
        ctx.db.exec("INSERT INTO settings (key, value) VALUES ('a', '1')");
        throw new Error('业务错误');
      }),
    ).toThrow('业务错误');
    // 回滚后无任何写入
    expect(ctx.db.all('SELECT key FROM settings')).toEqual([]);
  });

  it('嵌套 transaction 内层失败时外层一并回滚', () => {
    expect(() =>
      ctx.db.transaction(() => {
        ctx.db.exec("INSERT INTO settings (key, value) VALUES ('outer', '1')");
        ctx.db.transaction(() => {
          ctx.db.exec("INSERT INTO settings (key, value) VALUES ('inner', '2')");
          throw new Error('内层失败');
        });
      }),
    ).toThrow('内层失败');
    expect(ctx.db.all('SELECT key FROM settings')).toEqual([]);
  });

  it('嵌套 transaction 均成功时全部提交', () => {
    ctx.db.transaction(() => {
      ctx.db.exec("INSERT INTO settings (key, value) VALUES ('outer', '1')");
      ctx.db.transaction(() => {
        ctx.db.exec("INSERT INTO settings (key, value) VALUES ('inner', '2')");
      });
    });
    expect(ctx.db.all('SELECT key FROM settings ORDER BY key')).toEqual([
      { key: 'inner' },
      { key: 'outer' },
    ]);
  });

  it('save() 防抖 500ms 后落盘，flush() 可立即落盘', async () => {
    ctx.db.exec("INSERT INTO settings (key, value) VALUES ('k', 'v')");

    // save() 后文件尚未写出（防抖窗口内）
    ctx.db.save();
    expect(existsSync(ctx.dbPath)).toBe(false);

    // 等待超过防抖间隔后自动落盘
    await sleep(700);
    expect(existsSync(ctx.dbPath)).toBe(true);

    // flush() 立即可见
    ctx.db.exec("INSERT INTO settings (key, value) VALUES ('k2', 'v2')");
    ctx.db.flush();
    expect(existsSync(ctx.dbPath)).toBe(true);
  });

  it('close 后不可再操作', () => {
    ctx.db.close();
    expect(() => ctx.db.exec('SELECT 1')).toThrow('数据库已关闭');
    // close 幂等
    expect(() => ctx.db.close()).not.toThrow();
  });

  it('getSetting / setSetting 读写与覆盖', () => {
    expect(ctx.db.getSetting('theme')).toBeNull();
    ctx.db.setSetting('theme', 'dark');
    expect(ctx.db.getSetting('theme')).toBe('dark');
    ctx.db.setSetting('theme', 'light');
    expect(ctx.db.getSetting('theme')).toBe('light');
  });
});
