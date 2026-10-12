/** 文档库测试：addOrUpdate / 排序 / 置顶 / 移除 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentLibrary } from '../src/library/documentLibrary.js';
import type { DocumentMeta } from '../src/contracts/document.js';
import { createTestDb, type TestDb } from './helpers.js';

/** 构造文档元数据（可覆盖字段） */
function makeMeta(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  const now = Date.now();
  return {
    id: randomUUID(),
    module: 'writer',
    title: '未命名文档',
    filePath: null,
    format: 'docx',
    fidelity: 'L2',
    createdAt: now,
    updatedAt: now,
    sizeBytes: 1024,
    ...overrides,
  };
}

describe('DocumentLibrary', () => {
  let ctx: TestDb;
  let library: DocumentLibrary;

  beforeEach(async () => {
    ctx = await createTestDb();
    library = new DocumentLibrary(ctx.db);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it('addOrUpdateRecent 后可按 lastOpenedAt 倒序列出', () => {
    const a = makeMeta({ title: 'A' });
    const b = makeMeta({ title: 'B' });
    const c = makeMeta({ title: 'C' });
    library.addOrUpdateRecent(a, 1000);
    library.addOrUpdateRecent(b, 2000);
    library.addOrUpdateRecent(c, 3000);

    const recent = library.listRecent();
    expect(recent.map((r) => r.document.title)).toEqual(['C', 'B', 'A']);
    expect(recent.map((r) => r.lastOpenedAt)).toEqual([3000, 2000, 1000]);
    expect(recent.every((r) => !r.pinned)).toBe(true);
  });

  it('置顶优先：pinned 条目排在最前（即使打开时间更早）', () => {
    const a = makeMeta({ title: 'A' });
    const b = makeMeta({ title: 'B' });
    const c = makeMeta({ title: 'C' });
    library.addOrUpdateRecent(a, 1000);
    library.addOrUpdateRecent(b, 2000);
    library.addOrUpdateRecent(c, 3000);

    library.pin(a.id, true);
    const recent = library.listRecent();
    expect(recent.map((r) => r.document.title)).toEqual(['A', 'C', 'B']);
    expect(recent[0]!.pinned).toBe(true);

    // 取消置顶后恢复时间倒序
    library.pin(a.id, false);
    expect(library.listRecent().map((r) => r.document.title)).toEqual(['C', 'B', 'A']);
  });

  it('重复 addOrUpdateRecent 更新元数据并刷新打开时间到最前', () => {
    const a = makeMeta({ title: '旧标题', module: 'writer' });
    const b = makeMeta({ title: 'B' });
    library.addOrUpdateRecent(a, 1000);
    library.addOrUpdateRecent(b, 2000);

    const updated = makeMeta({
      id: a.id,
      title: '新标题',
      module: 'sheet',
      filePath: 'D:/docs/a.xlsx',
      format: 'xlsx',
      fidelity: 'L3',
      sizeBytes: 2048,
      createdAt: a.createdAt, // created_at 不变
      updatedAt: 9999,
    });
    library.addOrUpdateRecent(updated, 3000);

    const recent = library.listRecent();
    expect(recent.map((r) => r.document.title)).toEqual(['新标题', 'B']);
    expect(recent[0]!.document.module).toBe('sheet');
    expect(recent[0]!.document.filePath).toBe('D:/docs/a.xlsx');
    expect(recent[0]!.document.format).toBe('xlsx');
    expect(recent[0]!.document.fidelity).toBe('L3');
    expect(recent[0]!.document.sizeBytes).toBe(2048);
    expect(recent[0]!.document.createdAt).toBe(a.createdAt);
    expect(recent[0]!.document.updatedAt).toBe(9999);
    // 仍只有两条记录（upsert 而非重复插入）
    expect(recent).toHaveLength(2);
  });

  it('filePath 为 null 时正确映射（未保存的新建文档）', () => {
    const a = makeMeta({ filePath: null });
    library.addOrUpdateRecent(a, 1000);
    expect(library.listRecent()[0]!.document.filePath).toBeNull();
  });

  it('removeRecent 移除条目及其元数据', () => {
    const a = makeMeta({ title: 'A' });
    const b = makeMeta({ title: 'B' });
    library.addOrUpdateRecent(a, 1000);
    library.addOrUpdateRecent(b, 2000);

    library.removeRecent(a.id);

    const recent = library.listRecent();
    expect(recent.map((r) => r.document.title)).toEqual(['B']);
    // 元数据一并清理
    const metaRows = ctx.db.all('SELECT id FROM documents_meta');
    expect(metaRows).toHaveLength(1);
    // 移除后重新打开同一文件可再次入库
    library.addOrUpdateRecent(a, 4000);
    expect(library.listRecent().map((r) => r.document.title)).toEqual(['A', 'B']);
  });

  it('pin 不存在的条目时静默忽略', () => {
    expect(() => library.pin(randomUUID(), true)).not.toThrow();
    expect(library.listRecent()).toEqual([]);
  });
});
