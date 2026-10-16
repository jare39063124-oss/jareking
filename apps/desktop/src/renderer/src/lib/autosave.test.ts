/**
 * autosave 调度器单测（纯逻辑）：id/title 稳定性、防抖只留最后一次、flush 清空、
 * 序列化抛错不冒泡、discard 后不再 flush。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAutosave,
  __setAutosaveTransport,
  AUTOSAVE_DEBOUNCE_MS,
  discardAutosave,
  flushAutosave,
  makeBackupTitle,
  makeDocumentId,
  scheduleAutosave,
  type AutosaveBackupPayload,
  type AutosaveTransport,
} from './autosave';

/** 记录调用的传输层替身 */
function makeTransport() {
  const saves: AutosaveBackupPayload[] = [];
  const discards: string[] = [];
  const transport: AutosaveTransport = {
    saveBackup: async (payload) => {
      saves.push(payload);
      return payload;
    },
    discardBackup: async (documentId) => {
      discards.push(documentId);
      return true;
    },
  };
  return { transport, saves, discards };
}

describe('lib/autosave 调度器', () => {
  let saves: AutosaveBackupPayload[];
  let discards: string[];

  beforeEach(() => {
    const t = makeTransport();
    saves = t.saves;
    discards = t.discards;
    __setAutosaveTransport(t.transport);
  });

  afterEach(() => {
    __resetAutosave();
    vi.useRealTimers();
  });

  describe('makeDocumentId / makeBackupTitle', () => {
    it('同一路径生成稳定 id 与标题', () => {
      const a = makeDocumentId('writer', 'C:/docs/报告.docx');
      const b = makeDocumentId('writer', 'C:/docs/报告.docx');
      expect(a).toBe(b);
      expect(makeBackupTitle('writer', 'C:/docs/报告.docx')).toBe('报告.docx');
    });

    it('不同路径生成不同 id', () => {
      const a = makeDocumentId('writer', 'C:/docs/a.docx');
      const b = makeDocumentId('writer', 'C:/docs/b.docx');
      expect(a).not.toBe(b);
    });

    it('无路径时生成唯一未命名 id，标题回落模块默认标题', () => {
      const a = makeDocumentId('sheet');
      const b = makeDocumentId('sheet');
      expect(a).toMatch(/^sheet-untitled-\d+$/);
      expect(a).not.toBe(b);
      expect(makeBackupTitle('sheet')).toBe('工作簿');
    });
  });

  it('防抖期间重复 schedule 只保留最后一次 serialize', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const mk = (tag: string) => () => {
      calls.push(tag);
      return new Uint8Array([1]);
    };

    scheduleAutosave({ documentId: 'doc-1', module: 'writer', title: 'T', serialize: mk('first') });
    scheduleAutosave({ documentId: 'doc-1', module: 'writer', title: 'T', serialize: mk('second') });
    scheduleAutosave({ documentId: 'doc-1', module: 'writer', title: 'T', serialize: mk('third') });

    // 未到防抖时间不落盘
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);

    expect(calls).toEqual(['third']);
    expect(saves).toHaveLength(1);
  });

  it('flush 后清空待存队列，二次 flush 返回 null', async () => {
    scheduleAutosave({
      documentId: 'doc-1',
      module: 'writer',
      title: 'T',
      serialize: () => new Uint8Array([1, 2, 3]),
    });

    const bytes = await flushAutosave('doc-1');
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(3);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.documentId).toBe('doc-1');
    expect(saves[0]!.bytes.length).toBe(3);

    expect(await flushAutosave('doc-1')).toBeNull();
    expect(saves).toHaveLength(1);
  });

  it('序列化抛错被捕获，不冒泡为 rejection、不落盘', async () => {
    scheduleAutosave({
      documentId: 'doc-1',
      module: 'sheet',
      title: 'T',
      serialize: () => {
        throw new Error('boom');
      },
    });

    await expect(flushAutosave('doc-1')).resolves.toBeNull();
    expect(saves).toHaveLength(0);
  });

  it('防抖计时器触发时序列化抛错也不产生未捕获异常', async () => {
    vi.useFakeTimers();
    scheduleAutosave({
      documentId: 'doc-1',
      module: 'slide',
      title: 'T',
      serialize: () => Promise.reject(new Error('async boom')),
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(saves).toHaveLength(0);
  });

  it('discard 后不再 flush（取消待存并通知主进程删除）', async () => {
    scheduleAutosave({
      documentId: 'doc-1',
      module: 'writer',
      title: 'T',
      serialize: () => new Uint8Array([1]),
    });

    const ok = await discardAutosave('doc-1');
    expect(ok).toBe(true);
    expect(discards).toEqual(['doc-1']);

    // 已取消：flush 无待存内容、不再落盘
    expect(await flushAutosave('doc-1')).toBeNull();
    expect(saves).toHaveLength(0);
  });
});
