/** 自动保存测试：saveSnapshot → markRecovering → listPendingRecovery → clearRecovering */
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

describe('AutosaveManager 文件字节备份（崩溃恢复中心）', () => {
  let ctx: TestDb;
  let manager: AutosaveManager;

  beforeEach(async () => {
    ctx = await createTestDb();
    manager = new AutosaveManager(ctx.db, ctx.autosaveDir);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('saveBackup 写 <safeId>.<ext> 并登记 module/title/size_bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const backup = manager.saveBackup('doc-1', { module: 'writer', title: '报告.docx' }, bytes);

    // 扩展名由模块映射（writer → docx）
    expect(backup.snapshotPath).toBe(join(ctx.autosaveDir, 'doc-1.docx'));
    expect(existsSync(backup.snapshotPath)).toBe(true);
    expect(backup.sizeBytes).toBe(5);
    expect(backup.pending).toBe(false);

    // 文件内容与传入字节一致
    expect(new Uint8Array(readFileSync(backup.snapshotPath))).toEqual(bytes);

    const rows = ctx.db.all('SELECT module, title, size_bytes, recovering FROM autosaves');
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!['module'])).toBe('writer');
    expect(String(rows[0]!['title'])).toBe('报告.docx');
    expect(Number(rows[0]!['size_bytes'])).toBe(5);
    expect(Number(rows[0]!['recovering'])).toBe(0);
  });

  it('saveBackup 的 documentId 含异常字符时文件名安全（无路径逃逸）', () => {
    const backup = manager.saveBackup('../evil/id', { module: 'sheet', title: 'x' }, new Uint8Array([9]));
    expect(backup.snapshotPath.startsWith(ctx.autosaveDir)).toBe(true);
    expect(existsSync(backup.snapshotPath)).toBe(true);
  });

  it('listBackups 仅返回 module 非空行，按 saved_at 倒序，pending 反映 recovering', async () => {
    // 遗留 JSON 快照（module 为空）不应出现在 listBackups
    manager.saveSnapshot('legacy-1', { v: 1 });
    manager.saveBackup('doc-1', { module: 'writer', title: 'A' }, new Uint8Array([1]));
    await sleep(2);
    manager.saveBackup('doc-2', { module: 'slide', title: 'B' }, new Uint8Array([1, 2]));

    const list = manager.listBackups();
    expect(list).toHaveLength(2);
    // saved_at 倒序：后保存的 doc-2 在前
    expect(list.map((b) => b.documentId)).toEqual(['doc-2', 'doc-1']);
    expect(list.every((b) => b.pending === false)).toBe(true);

    manager.beginSession();
    const afterBegin = manager.listBackups();
    expect(afterBegin.every((b) => b.pending === true)).toBe(true);
  });

  it('beginSession 把所有行置 recovering=1 并返回条数', () => {
    expect(manager.beginSession()).toBe(0);

    manager.saveBackup('doc-1', { module: 'writer', title: 'A' }, new Uint8Array([1]));
    manager.saveBackup('doc-2', { module: 'sheet', title: 'B' }, new Uint8Array([1]));

    expect(manager.beginSession()).toBe(2);
    expect(manager.listPendingRecovery()).toHaveLength(2);
  });

  it('resolveBackup 物化字节到目标目录并清除 recovering；文件缺失返回 null', () => {
    const bytes = new Uint8Array([10, 20, 30]);
    manager.saveBackup('doc-1', { module: 'writer', title: '报告.docx' }, bytes);
    manager.beginSession();
    expect(manager.listBackups()[0]!.pending).toBe(true);

    const targetDir = join(ctx.dir, 'recovered');
    const resolved = manager.resolveBackup('doc-1', targetDir);
    expect(resolved).not.toBeNull();
    // 标题中的扩展名被剥离，避免 .docx.docx
    expect(resolved!.name).toBe('报告.docx');
    expect(resolved!.module).toBe('writer');
    expect(resolved!.path).toBe(join(targetDir, '报告.docx'));
    expect(existsSync(resolved!.path)).toBe(true);
    expect(new Uint8Array(readFileSync(resolved!.path))).toEqual(bytes);

    // 恢复后该文档不再待恢复
    expect(manager.listBackups()[0]!.pending).toBe(false);

    // 文件缺失：删除快照后返回 null（不抛）
    rmSync(manager.listBackups()[0]!.snapshotPath, { force: true });
    expect(manager.resolveBackup('doc-1', targetDir)).toBeNull();
    // 不存在的 documentId 也返回 null
    expect(manager.resolveBackup('missing', targetDir)).toBeNull();
  });

  it('resolveBackup 的标题含路径分隔符时文件名被清洗', () => {
    manager.saveBackup('doc-1', { module: 'slide', title: '../evil/演示.pptx' }, new Uint8Array([1]));
    const targetDir = join(ctx.dir, 'recovered');
    const resolved = manager.resolveBackup('doc-1', targetDir);
    expect(resolved).not.toBeNull();
    // 清洗后不含路径分隔符，且落在 targetDir 内
    expect(resolved!.name.includes('/')).toBe(false);
    expect(resolved!.name.includes('\\')).toBe(false);
    expect(resolved!.path.startsWith(targetDir)).toBe(true);
  });

  it('discardBackup 删除文件与行；文件缺失也删行', () => {
    const backup = manager.saveBackup('doc-1', { module: 'writer', title: 'A' }, new Uint8Array([1]));
    expect(manager.discardBackup('doc-1')).toBe(true);
    expect(existsSync(backup.snapshotPath)).toBe(false);
    expect(manager.listBackups()).toHaveLength(0);

    // 文件已被删：再次丢弃（行已无）返回 false
    expect(manager.discardBackup('doc-1')).toBe(false);

    // 文件缺失但行仍在 → 仍删行
    manager.saveBackup('doc-2', { module: 'writer', title: 'B' }, new Uint8Array([1]));
    const snap2 = manager.listBackups()[0]!.snapshotPath;
    rmSync(snap2, { force: true });
    expect(manager.discardBackup('doc-2')).toBe(true);
    expect(manager.listBackups()).toHaveLength(0);
  });

  it('保存同一文档的字节备份：覆盖文件并更新元信息', async () => {
    manager.saveBackup('doc-1', { module: 'writer', title: '旧' }, new Uint8Array([1]));
    await sleep(2);
    manager.beginSession();
    expect(manager.listBackups()[0]!.pending).toBe(true);

    const second = manager.saveBackup('doc-1', { module: 'writer', title: '新' }, new Uint8Array([1, 2, 3]));
    const list = manager.listBackups();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('新');
    expect(list[0]!.sizeBytes).toBe(3);
    // 再次保存后复位为「无需恢复」
    expect(list[0]!.pending).toBe(false);
    expect(new Uint8Array(readFileSync(second.snapshotPath))).toEqual(new Uint8Array([1, 2, 3]));
  });
});
