/** 自动保存测试：saveSnapshot → markRecovering → listPendingRecovery → clearRecovering */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutosaveManager } from '../src/library/autosaveManager.js';
import { createTestDb, sleep, type TestDb } from './helpers.js';

describe('AutosaveManager', () => {
  let ctx: TestDb;
  let manager: AutosaveManager;

  beforeEach(async () => {
    ctx = await createTestDb();
    manager = new AutosaveManager(ctx.db, ctx.autosaveDir);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('saveSnapshot 写入快照文件并登记 autosaves 表', () => {
    const snapshot = manager.saveSnapshot('doc-1', { text: 'hello', paragraphs: 3 });

    // 文件落在 autosaveDir 下，内容为 JSON
    expect(snapshot.snapshotPath).toBe(join(ctx.autosaveDir, 'doc-1.json'));
    expect(existsSync(snapshot.snapshotPath)).toBe(true);
    expect(snapshot.documentId).toBe('doc-1');
    expect(snapshot.savedAt).toBeGreaterThan(0);

    // 表记录：默认未处于恢复中
    const rows = ctx.db.all('SELECT document_id, recovering FROM autosaves');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['document_id']).toBe('doc-1');
    expect(Number(rows[0]!['recovering'])).toBe(0);

    // 快照内容可读回
    const content = manager.readSnapshot(snapshot.snapshotPath);
    expect(content).not.toBeNull();
    expect(content!.documentId).toBe('doc-1');
    expect(content!.data).toEqual({ text: 'hello', paragraphs: 3 });
  });

  it('完整恢复流程：markRecovering → listPendingRecovery → clearRecovering', async () => {
    const snap1 = manager.saveSnapshot('doc-1', { v: 1 });
    await sleep(2);
    const snap2 = manager.saveSnapshot('doc-2', { v: 2 });

    // 保存后均不处于恢复中
    expect(manager.listPendingRecovery()).toEqual([]);

    manager.markRecovering('doc-1');
    manager.markRecovering('doc-2');

    const pending = manager.listPendingRecovery();
    expect(pending).toHaveLength(2);
    // 按 saved_at 升序
    expect(pending.map((p) => p.documentId)).toEqual(['doc-1', 'doc-2']);
    expect(pending[0]!.snapshotPath).toBe(snap1.snapshotPath);
    expect(pending[1]!.snapshotPath).toBe(snap2.snapshotPath);

    // 清除一个后只剩另一个
    manager.clearRecovering('doc-1');
    const afterClear = manager.listPendingRecovery();
    expect(afterClear).toHaveLength(1);
    expect(afterClear[0]!.documentId).toBe('doc-2');

    manager.clearRecovering('doc-2');
    expect(manager.listPendingRecovery()).toEqual([]);
  });

  it('重复保存同一文档：覆盖文件、更新 saved_at、复位 recovering', async () => {
    manager.saveSnapshot('doc-1', { v: 1 });
    await sleep(2);
    manager.markRecovering('doc-1');
    expect(manager.listPendingRecovery()).toHaveLength(1);

    const second = manager.saveSnapshot('doc-1', { v: 2 });
    // 再次保存后恢复到"无需恢复"状态
    expect(manager.listPendingRecovery()).toEqual([]);

    const rows = ctx.db.all('SELECT saved_at, snapshot_path FROM autosaves');
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!['saved_at'])).toBe(second.savedAt);
    expect(String(rows[0]!['snapshot_path'])).toBe(second.snapshotPath);

    // 文件内容为最新数据
    expect(manager.readSnapshot(second.snapshotPath)!.data).toEqual({ v: 2 });
  });

  it('markRecovering / clearRecovering 不存在的条目时静默忽略', () => {
    expect(() => manager.markRecovering('missing')).not.toThrow();
    expect(() => manager.clearRecovering('missing')).not.toThrow();
    expect(manager.listPendingRecovery()).toEqual([]);
  });

  it('readSnapshot 对不存在的文件返回 null', () => {
    expect(manager.readSnapshot(join(ctx.autosaveDir, 'not-exist.json'))).toBeNull();
  });

  it('documentId 含异常字符时快照文件名安全（无路径逃逸）', () => {
    const snapshot = manager.saveSnapshot('../evil/id', { v: 1 });
    // 清洗后落在 autosaveDir 内
    expect(snapshot.snapshotPath.startsWith(ctx.autosaveDir)).toBe(true);
    expect(existsSync(snapshot.snapshotPath)).toBe(true);
    // 表中仍记录原始 documentId
    const rows = ctx.db.all('SELECT document_id FROM autosaves');
    expect(rows[0]!['document_id']).toBe('../evil/id');
  });
});
