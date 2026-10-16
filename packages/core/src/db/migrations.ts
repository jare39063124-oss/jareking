/**
 * 数据库迁移列表：按 version 升序应用。
 * 新增迁移只需在数组末尾追加一项（version 递增），切勿修改已应用的迁移。
 * 字段严格对齐 src/contracts/ 中的 DocumentMeta / RecentFile / AutosaveSnapshot /
 * LocalAccount / PointsEntry / PointsBalance / AiUsageRecord 契约。
 */
import type { Migration } from './database.js';

/** v1 初始 schema：账户、积分流水、文档元数据、最近文件、自动保存、设置 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          nickname TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS points_ledger (
          id TEXT PRIMARY KEY,
          delta INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          reason TEXT NOT NULL,
          detail TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS documents_meta (
          id TEXT PRIMARY KEY,
          module TEXT NOT NULL,
          title TEXT NOT NULL,
          file_path TEXT,
          format TEXT NOT NULL,
          fidelity TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS recent_files (
          document_id TEXT PRIMARY KEY,
          last_opened_at INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS autosaves (
          document_id TEXT PRIMARY KEY,
          saved_at INTEGER NOT NULL,
          snapshot_path TEXT NOT NULL,
          recovering INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    // v2：AI 算力计量——用量流水表（字段对齐 contracts/ai.ts 的 AiUsageRecord）
    version: 2,
    name: 'ai-usage',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_usage (
          id TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          model TEXT NOT NULL,
          config_id TEXT,
          feature TEXT,
          prompt_tokens INTEGER NOT NULL,
          completion_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          points INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage (at DESC);
      `);
    },
  },
  {
    // v3：崩溃恢复入口显性化——autosaves 增加「模块 / 标题 / 字节数」元信息，
    // 使渲染层「文档备份中心」能展示待恢复的「文件字节备份」完整信息。
    // 注意：仅追加列（sql.js / SQLite 支持 ALTER TABLE ADD COLUMN），
    // v1 的 CREATE TABLE 定义保持不变（已应用的迁移不可修改）。
    version: 3,
    name: 'autosave-backup-meta',
    up: (db) => {
      db.exec(`
        ALTER TABLE autosaves ADD COLUMN module TEXT;
        ALTER TABLE autosaves ADD COLUMN title TEXT;
        ALTER TABLE autosaves ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
];
