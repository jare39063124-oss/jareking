/** 测试辅助：临时目录 + 独立 Database 实例（每个测试文件/用例互不共享） */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/db/database.js';

export interface TestDb {
  db: Database;
  /** 临时目录（数据库文件与 autosaves 均在此下） */
  dir: string;
  /** 数据库文件完整路径 */
  dbPath: string;
  /** autosaves 快照目录 */
  autosaveDir: string;
  cleanup: () => void;
}

/** 在系统临时目录下创建独立的测试数据库（自动完成迁移） */
export async function createTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), 'jareking-test-'));
  const dbPath = join(dir, 'test.db');
  const db = await Database.open(dbPath);
  return {
    db,
    dir,
    dbPath,
    autosaveDir: join(dir, 'autosaves'),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 等待指定毫秒（用于防抖/时间排序场景） */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
