/**
 * autosave.qa.test.ts —— QA 独立对抗测试（崩溃恢复「文件字节备份」）。
 *
 * 独立于工程师的 autosave.test.ts，不改动任何源码；覆盖：
 *  A 路径逃逸（saveBackup 落盘 / resolveBackup 物化，均须落在目标目录内）
 *  B 损坏 / 缺失快照（删文件、截断、据在文件无 → 不抛异常）
 *  C 保存后语义（discard 清理文件与行）
 *  G 多文档 / 去重（同 id 覆盖、异 id 独立、遗留 JSON 快照不展示）
 *  H 恢复语义（pending 翻转、其余保留、全部忽略后文件确删）
 *  额外：saveBackup 依赖 db.flush() 的即时持久化（崩溃前元信息必须落盘）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutosaveManager } from '../src/library/autosaveManager.js';
import { Database } from '../src/db/database.js';
import { createTestDb, sleep, type TestDb } from './helpers.js';

/** 断言 target 位于 base 目录内（逐段判断，避免 startsWith 前缀误判 / 文件名以 .. 开头误判） */
function assertInside(base: string, target: string): void {
  const rel = relative(resolve(base), resolve(target));
  const segments = rel.split(/[\\/]/);
  const escaped = isAbsolute(rel) || segments.includes('..');
  expect({ target, rel, escaped }).toEqual({ target, rel, escaped: false });
}

/** 目录下所有文件的落盘路径（含子目录，用于确认无目录外副作用） */
function listAllFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe('QA·A 路径逃逸 —— saveBackup 落盘文件名', () => {
  let ctx: TestDb;
  let manager: AutosaveManager;

  beforeEach(async () => {
    ctx = await createTestDb();
    manager = new AutosaveManager(ctx.db, ctx.autosaveDir);
  });
  afterEach(() => ctx.cleanup());

  const maliciousIds = [
    '../evil',
    '..\\evil',
    '../../../../etc/passwd',
    'C:/Windows/System32/evil',
    'C:\\Windows\\evil',
    'a b c/pre fixed',
    '<script>alert(1)</script>',
    '....//....//escape',
    'con',
    'nul',
    'a'.repeat(120),
  ];

  it.each(maliciousIds)('documentId=%j 落盘不逃逸 autosaveDir', (id) => {
    const backup = manager.saveBackup(id, { module: 'writer', title: 't' }, new Uint8Array([1, 2]));
    assertInside(ctx.autosaveDir, backup.snapshotPath);
    expect(existsSync(backup.snapshotPath)).toBe(true);
    // 快照「文件名」不得含任何路径分隔符
    const name = basename(backup.snapshotPath);
    expect(name.includes('/')).toBe(false);
    expect(name.includes('\\')).toBe(false);
    // 库中仍记录原始 documentId
    const rows = ctx.db.all<{ document_id: string }>('SELECT document_id FROM autosaves');
    expect(rows.some((r) => r.document_id === id)).toBe(true);
  });

  it('超长 documentId：要么成功且落在目录内，要么抛错但无目录外副作用（记录真实行为）', () => {
    const longId = 'x'.repeat(400);
    let threw = false;
    let path: string | null = null;
    try {
      path = manager.saveBackup(longId, { module: 'writer', title: 't' }, new Uint8Array([1]))
        .snapshotPath;
    } catch {
      threw = true;
    }
    if (!threw && path) assertInside(ctx.autosaveDir, path);
    // 无论哪种路径，autosaves 目录下所有文件都必须在目录内
    for (const f of listAllFiles(ctx.autosaveDir)) assertInside(ctx.autosaveDir, f);
    // 记录真实行为：true=抛 ENAMETOOLONG（由渲染层 persist 捕获，不崩溃）；false=成功落盘
    console.log(`[QA] 超长 documentId 抛错=${threw}`);
  });
});

describe('QA·A2 路径逃逸 —— resolveBackup 物化文件名 / 扩展名', () => {
  let ctx: TestDb;
  let manager: AutosaveManager;

  beforeEach(async () => {
    ctx = await createTestDb();
    manager = new AutosaveManager(ctx.db, ctx.autosaveDir);
  });
  afterEach(() => ctx.cleanup());

  const cases: Array<{ module: string; title: string; ext: string }> = [
    { module: 'writer', title: '../../evil', ext: 'docx' },
    { module: 'sheet', title: '..\\..\\evil', ext: 'xlsx' },
    { module: 'slide', title: 'C:\\Windows\\evil', ext: 'pptx' },
    { module: 'writer', title: '<script>alert(1)</script>', ext: 'docx' },
    { module: 'writer', title: '正常 报告 名称', ext: 'docx' },
  ];

  it.each(cases)('module=$module title=$title → 物化名落在 targetDir 内、扩展名=$ext', (c) => {
    manager.saveBackup('doc-1', { module: c.module, title: c.title }, new Uint8Array([7]));
    const targetDir = join(ctx.dir, 'recovered');
    const resolved = manager.resolveBackup('doc-1', targetDir);
    expect(resolved).not.toBeNull();
    assertInside(targetDir, resolved!.path);
    expect(resolved!.name.endsWith(`.${c.ext}`)).toBe(true);
    expect(resolved!.name.includes('/')).toBe(false);
    expect(resolved!.name.includes('\\')).toBe(false);
    expect(existsSync(resolved!.path)).toBe(true);
  });

  it('标题已含扩展名时剥离，避免 .docx.docx', () => {
    manager.saveBackup('doc-1', { module: 'writer', title: '报告.docx' }, new Uint8Array([1]));
    const resolved = manager.resolveBackup('doc-1', join(ctx.dir, 'r'));
    expect(resolved!.name).toBe('报告.docx');
  });

  it('标题为空 / 为 "." / ".." 时兜底「未命名」，不产生隐藏或穿越文件名', () => {
    for (const title of ['', '.', '..', '   ']) {
      manager.saveBackup(`d-${Math.random()}`, { module: 'writer', title }, new Uint8Array([1]));
    }
    const targetDir = join(ctx.dir, 'r2');
    for (const b of manager.listBackups()) {
      const resolved = manager.resolveBackup(b.documentId, targetDir);
      expect(resolved).not.toBeNull();
      assertInside(targetDir, resolved!.path);
      expect(resolved!.name.startsWith('.')).toBe(false);
    }
  });

  it('超长标题：resolveBackup 若抛错则不得在目录外产生副作用', () => {
    const longTitle = 'y'.repeat(400);
    manager.saveBackup('doc-1', { module: 'writer', title: longTitle }, new Uint8Array([1]));
    const targetDir = join(ctx.dir, 'r3');
    let threw = false;
    let resolvedPath: string | null = null;
    try {
      resolvedPath = manager.resolveBackup('doc-1', targetDir)?.path ?? null;
    } catch {
      threw = true;
    }
    if (!threw && resolvedPath) assertInside(targetDir, resolvedPath);
    for (const f of listAllFiles(targetDir)) assertInside(targetDir, f);
    console.log(`[QA] 超长标题 resolveBackup 抛错=${threw}`);
  });
});

describe('QA·B 损坏 / 缺失快照对恢复中心的鲁棒性', () => {
  let ctx: TestDb;
  let manager: AutosaveManager;

  beforeEach(async () => {
    ctx = await createTestDb();
    manager = new AutosaveManager(ctx.db, ctx.autosaveDir);
  });
  afterEach(() => ctx.cleanup());

  it('文件被删（据在文件无）→ resolveBackup 返回 null，listBackups 不抛', () => {
    const b = manager.saveBackup('doc-1', { module: 'writer', title: 'A' }, new Uint8Array([1, 2, 3]));
    rmSync(b.snapshotPath, { force: true });
    expect(() => manager.listBackups()).not.toThrow();
    expect(manager.resolveBackup('doc-1', join(ctx.dir, 'r'))).toBeNull();
  });

  it('内容被截断（半截字节）→ resolveBackup 不抛异常且物化物不逃逸目录', () => {
    const b = manager.saveBackup('doc-1', { module: 'writer', title: 'A' }, new Uint8Array([1, 2, 3, 4, 5]));
    // 截断为前 2 字节
    writeFileSync(b.snapshotPath, new Uint8Array([1, 2]));
    const targetDir = join(ctx.dir, 'r');
    let resolved: { path: string; name: string } | null = null;
    expect(() => {
      resolved = manager.resolveBackup('doc-1', targetDir);
    }).not.toThrow();
    // 不带内容校验：返回物化路径（记录真实行为，供路由判定）
    console.log(`[QA] 截断快照 resolveBackup 返回 null=${resolved === null}`);
    if (resolved) {
      assertInside(targetDir, resolved.path);
      expect(new Uint8Array(readFileSync(resolved.path))).toEqual(new Uint8Array([1, 2]));
    }
  });

  it('不存在的 documentId → resolveBackup 返回 null（不抛）', () => {
    expect(manager.resolveBackup('no-such-id', join(ctx.dir, 'r'))).toBeNull();
  });

  it('快照路径被替换为目录 → resolveBackup 抛错不越权（记录真实行为）', () => {
    const b = manager.saveBackup('doc-1', { module: 'writer', title: 'A' }, new Uint8Array([1]));
    rmSync(b.snapshotPath, { force: true });
    mkdirSync(b.snapshotPath);
    // existsSync 为 true（目录存在）→ 后续 readFileSync 会抛 EISDIR
    let threw = false;
    try {
      manager.resolveBackup('doc-1', join(ctx.dir, 'r'));
    } catch {
      threw = true;
    }
    console.log(`[QA] 快照路径为目录 resolveBackup 抛错=${threw}`);
  });

  it('listBackups 不因坏行抛错（含 module 为空 / 非法字节行）', () => {
    manager.saveBackup('doc-1', { module: 'writer', title: 'A' }, new Uint8Array([1]));
    // 手工插入一行 module 为空（模拟遗留 JSON 快照）与一个未知 module
    manager.saveSnapshot('legacy-x', { v: 1 });
    manager.saveBackup('doc-2', { module: 'weird', title: 'B' }, new Uint8Array([1]));
    expect(() => manager.listBackups()).not.toThrow();
    const list = manager.listBackups();
    // 遗留 JSON 快照（module 空）不展示；未知 module 正常展示
    expect(list.some((b) => b.documentId === 'legacy-x')).toBe(false);
    expect(list.some((b) => b.documentId === 'doc-2')).toBe(true);
  });
});

describe('QA·G 多文档 / 去重', () => {
  let ctx: TestDb;
  let manager: AutosaveManager;

  beforeEach(async () => {
    ctx = await createTestDb();
    manager = new AutosaveManager(ctx.db, ctx.autosaveDir);
  });
  afterEach(() => ctx.cleanup());

  it('同一 documentId 重复保存 → 单条记录、覆盖文件、更新元信息', async () => {
    const first = manager.saveBackup('writer-untitled-1', { module: 'writer', title: '文档' }, new Uint8Array([1]));
    await sleep(2);
    const second = manager.saveBackup(
      'writer-untitled-1',
      { module: 'writer', title: '文档' },
      new Uint8Array([1, 2, 3]),
    );
    const list = manager.listBackups();
    expect(list).toHaveLength(1);
    expect(list[0]!.sizeBytes).toBe(3);
    expect(new Uint8Array(readFileSync(second.snapshotPath))).toEqual(new Uint8Array([1, 2, 3]));
    expect(first.snapshotPath).toBe(second.snapshotPath);
  });

  it('不同 documentId（同标题）→ 各自独立条目与独立文件', () => {
    const a = manager.saveBackup('sheet-untitled-1', { module: 'sheet', title: '工作簿' }, new Uint8Array([1]));
    const b = manager.saveBackup('sheet-untitled-2', { module: 'sheet', title: '工作簿' }, new Uint8Array([2]));
    const list = manager.listBackups();
    expect(list).toHaveLength(2);
    expect(a.snapshotPath).not.toBe(b.snapshotPath);
    expect(existsSync(a.snapshotPath)).toBe(true);
    expect(existsSync(b.snapshotPath)).toBe(true);
  });

  it('按 saved_at 倒序（最近保存在前）', async () => {
    manager.saveBackup('d1', { module: 'writer', title: 'A' }, new Uint8Array([1]));
    await sleep(2);
    manager.saveBackup('d2', { module: 'writer', title: 'B' }, new Uint8Array([1]));
    await sleep(2);
    manager.saveBackup('d3', { module: 'writer', title: 'C' }, new Uint8Array([1]));
    expect(manager.listBackups().map((b) => b.documentId)).toEqual(['d3', 'd2', 'd1']);
  });
});

describe('QA·H 恢复语义', () => {
  let ctx: TestDb;
  let manager: AutosaveManager;

  beforeEach(async () => {
    ctx = await createTestDb();
    manager = new AutosaveManager(ctx.db, ctx.autosaveDir);
  });
  afterEach(() => ctx.cleanup());

  it('beginSession 后全部 pending；恢复其中一条 → 该条 pending=false，其余仍保留', () => {
    manager.saveBackup('d1', { module: 'writer', title: 'A' }, new Uint8Array([1]));
    manager.saveBackup('d2', { module: 'writer', title: 'B' }, new Uint8Array([1]));
    manager.saveBackup('d3', { module: 'writer', title: 'C' }, new Uint8Array([1]));
    expect(manager.beginSession()).toBe(3);
    expect(manager.listBackups().filter((b) => b.pending)).toHaveLength(3);

    const resolved = manager.resolveBackup('d2', join(ctx.dir, 'r'));
    expect(resolved).not.toBeNull();

    const after = manager.listBackups();
    const byId = Object.fromEntries(after.map((b) => [b.documentId, b.pending]));
    expect(byId['d2']).toBe(false);
    expect(byId['d1']).toBe(true);
    expect(byId['d3']).toBe(true);
    // 恢复不清除原始快照文件（供再次恢复 / 审计）
    expect(after).toHaveLength(3);
  });

  it('discard 单条 → 仅删除该条文件与记录，其余完好', () => {
    const a = manager.saveBackup('d1', { module: 'writer', title: 'A' }, new Uint8Array([1]));
    const b = manager.saveBackup('d2', { module: 'writer', title: 'B' }, new Uint8Array([1]));
    expect(manager.discardBackup('d1')).toBe(true);
    expect(existsSync(a.snapshotPath)).toBe(false);
    expect(existsSync(b.snapshotPath)).toBe(true);
    expect(manager.listBackups().map((x) => x.documentId)).toEqual(['d2']);
  });

  it('全部忽略（逐条 discard）→ 列表清空且磁盘备份文件确实被删', () => {
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      paths.push(manager.saveBackup(`d${i}`, { module: 'writer', title: `T${i}` }, new Uint8Array([i])).snapshotPath);
    }
    for (const b of manager.listBackups()) expect(manager.discardBackup(b.documentId)).toBe(true);
    expect(manager.listBackups()).toHaveLength(0);
    for (const p of paths) expect(existsSync(p)).toBe(false);
    // 目录内不留残留文件
    expect(listAllFiles(ctx.autosaveDir)).toHaveLength(0);
  });

  it('文件缺失但记录仍在 → discardBackup 仍删记录并返回 true', () => {
    const b = manager.saveBackup('d1', { module: 'writer', title: 'A' }, new Uint8Array([1]));
    rmSync(b.snapshotPath, { force: true });
    expect(manager.discardBackup('d1')).toBe(true);
    expect(manager.listBackups()).toHaveLength(0);
  });
});

describe('QA·持久化 —— saveBackup 依赖 db.flush() 即时落盘', () => {
  let ctx: TestDb;
  afterEach(() => ctx.cleanup());

  it('saveBackup 后未 close，重开数据库仍能读到该备份行（证明 flush 已写盘）', async () => {
    ctx = await createTestDb();
    const manager = new AutosaveManager(ctx.db, ctx.autosaveDir);
    manager.saveBackup('doc-1', { module: 'writer', title: 'A' }, new Uint8Array([1, 2, 3]));

    // 不关闭原句柄，直接用另一句柄读取同一 db 文件（模拟「进程被杀后再启动」）
    const reopened = await Database.open(ctx.dbPath);
    const rows = reopened.all<{ document_id: string; module: string; size_bytes: number }>(
      'SELECT document_id, module, size_bytes FROM autosaves',
    );
    reopened.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.document_id).toBe('doc-1');
    expect(rows[0]!.module).toBe('writer');
    expect(Number(rows[0]!.size_bytes)).toBe(3);
  });
});
