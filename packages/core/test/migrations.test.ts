/** 迁移测试：重复 migrate 幂等、schema 完整、数据保留、重开不重复建表 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/db/database.js';
import { createTestDb, type TestDb } from './helpers.js';

/** 迁移后应包含的全部表 */
const EXPECTED_TABLES = [
  'migrations',
  'accounts',
  'points_ledger',
  'documents_meta',
  'recent_files',
  'autosaves',
  'settings',
  'ai_usage',
];

describe('migrations', () => {
  let ctx: TestDb;

  beforeEach(async () => {
    ctx = await createTestDb();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('初始迁移创建全部约定表', () => {
    const rows = ctx.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const tables = rows.map((r) => String(r['name'])).sort();
    expect(tables).toEqual([...EXPECTED_TABLES].sort());
  });

  it('重复执行 migrate 不重复建表、不重复记录版本', () => {
    const tablesBefore = ctx.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => String(r['name']))
      .sort();
    const migrationsBefore = ctx.db.all('SELECT version, name FROM migrations');

    // 重复迁移多次
    const version = ctx.db.migrate();
    ctx.db.migrate();
    ctx.db.migrate();

    expect(version).toBe(3);
    expect(ctx.db.currentVersion()).toBe(3);

    const tablesAfter = ctx.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => String(r['name']))
      .sort();
    expect(tablesAfter).toEqual(tablesBefore);
    expect(ctx.db.all('SELECT version, name FROM migrations')).toEqual(migrationsBefore);
    expect(migrationsBefore).toEqual([
      { version: 1, name: 'initial-schema' },
      { version: 2, name: 'ai-usage' },
      { version: 3, name: 'autosave-backup-meta' },
    ]);
  });

  it('重复 migrate 不破坏已有数据', () => {
    ctx.db.exec("INSERT INTO settings (key, value) VALUES ('theme', 'dark')");
    ctx.db.migrate();
    const rows = ctx.db.all("SELECT key, value FROM settings WHERE key = 'theme'");
    expect(rows).toEqual([{ key: 'theme', value: 'dark' }]);
  });

  it('数据库字段与契约对齐（列名 / 类型 / 约束）', () => {
    const columns = (table: string) =>
      ctx.db
        .all<{ name: string; type: string; notnull: number; pk: number }>(
          `PRAGMA table_info(${table})`,
        )
        .map((r) => ({
          name: String(r['name']),
          type: String(r['type']),
          notnull: Number(r['notnull']),
          pk: Number(r['pk']),
        }));

    expect(columns('accounts')).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'device_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'nickname', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ]);

    expect(columns('points_ledger')).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'delta', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'balance_after', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'reason', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'detail', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
    ]);

    expect(columns('documents_meta')).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'module', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'file_path', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'format', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'fidelity', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'created_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'size_bytes', type: 'INTEGER', notnull: 1, pk: 0 },
    ]);

    expect(columns('recent_files')).toEqual([
      { name: 'document_id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'last_opened_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'pinned', type: 'INTEGER', notnull: 1, pk: 0 },
    ]);

    expect(columns('autosaves')).toEqual([
      { name: 'document_id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'saved_at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'snapshot_path', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'recovering', type: 'INTEGER', notnull: 1, pk: 0 },
      // v3：崩溃恢复入口显性化新增的元信息列
      { name: 'module', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'title', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'size_bytes', type: 'INTEGER', notnull: 1, pk: 0 },
    ]);

    expect(columns('settings')).toEqual([
      { name: 'key', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'value', type: 'TEXT', notnull: 1, pk: 0 },
    ]);

    expect(columns('ai_usage')).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'at', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'model', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'config_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'feature', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'prompt_tokens', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'completion_tokens', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'total_tokens', type: 'INTEGER', notnull: 1, pk: 0 },
      { name: 'points', type: 'INTEGER', notnull: 1, pk: 0 },
    ]);
  });

  it('重开数据库文件：迁移不重复执行，数据完整保留', async () => {
    ctx.db.exec("INSERT INTO settings (key, value) VALUES ('theme', 'light')");
    ctx.db.exec(
      "INSERT INTO accounts (id, device_id, nickname, created_at) VALUES ('acc-1', 'dev-1', '测试', 100)",
    );
    ctx.db.close(); // flush 落盘

    const reopened = await Database.open(ctx.dbPath);
    try {
      expect(reopened.currentVersion()).toBe(3);
      expect(reopened.all("SELECT value FROM settings WHERE key = 'theme'")).toEqual([
        { value: 'light' },
      ]);
      expect(reopened.all('SELECT id FROM accounts')).toEqual([{ id: 'acc-1' }]);
    } finally {
      reopened.close();
    }
    // 原上下文 cleanup 会二次 close，已被 close 保护（幂等）
    expect(existsSync(ctx.dbPath)).toBe(true);
  });
});
