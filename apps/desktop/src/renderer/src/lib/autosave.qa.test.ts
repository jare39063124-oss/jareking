// @vitest-environment jsdom
/**
 * autosave.qa.test.ts —— QA 独立对抗测试（渲染层自动保存调度器 lib/autosave.ts）。
 *
 * 独立于工程师的 autosave.test.ts，不改动任何源码；覆盖：
 *  E StrictMode / 双调用：调度器对同一 documentId 幂等（重复 schedule 只落盘一次）；
 *    并复现 SlideEditor 源码 firstPresRef 守卫在 StrictMode 下失效的模式（支撑 P2 发现）。
 *  G 多文档并发：不同 documentId 各自独立落盘，互不覆盖。
 *  F flush 语义：flush 立即落盘并清空待存；之后再 schedule 可重新武装。
 *  C discard 语义：discard 取消待存并通知主进程删除。
 *  额外：序列化抛错 / 传输层抛错均不产生未捕获异常。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, useEffect, useRef, createElement, act } from 'react';
import { createRoot } from 'react-dom/client';import {
  __resetAutosave,
  __setAutosaveTransport,
  AUTOSAVE_DEBOUNCE_MS,
  discardAutosave,
  flushAllAutosaves,
  flushAutosave,
  makeBackupTitle,
  makeDocumentId,
  scheduleAutosave,
  type AutosaveBackupPayload,
  type AutosaveTransport,
} from './autosave';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function mount(): { container: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

describe('QA·E StrictMode / 双调用', () => {
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

  it('对照：StrictMode 下 effect 确会 setup→cleanup→setup（双调用）', async () => {
    let setups = 0;
    let cleanups = 0;
    function Probe() {
      useEffect(() => {
        setups++;
        return () => {
          cleanups++;
        };
      }, []);
      return null;
    }
    const { container, root } = mount();
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
    expect(setups).toBe(2);
    expect(cleanups).toBe(1);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('挂载期 effect 双调用 schedule 同一 docId：防抖后只落盘 1 次（调度器幂等）', async () => {
    vi.useFakeTimers();
    function Probe() {
      useEffect(() => {
        scheduleAutosave({
          documentId: 'writer-untitled-1',
          module: 'writer',
          title: 'T',
          serialize: () => new Uint8Array([1]),
        });
      }, []);
      return null;
    }
    const { container, root } = mount();
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
    expect(saves).toHaveLength(0); // 防抖期内不落盘
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    });
    expect(saves).toHaveLength(1); // 双调用未产生重复落盘
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('复现 SlideEditor firstPresRef 守卫在 StrictMode 下失效（支撑 P2 发现）', async () => {
    // 说明：本用例复现 SlideEditor 源码中「首次 pres 变更才调度、挂载时不调度」的守卫模式，
    // 因 Konva/Univer 依赖无法在 jsdom 直接渲染 SlideEditor，故以等价模式隔离验证。
    const scheduled = vi.fn();
    function FirstGuardProbe() {
      const firstRef = useRef(true);
      useEffect(() => {
        if (firstRef.current) {
          firstRef.current = false;
          return; // 守卫：首次挂载不调度
        }
        scheduled(); // 仅后续变更调度
      }, []);
      return null;
    }
    const { container, root } = mount();
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(FirstGuardProbe)));
    });
    // StrictMode 双调用使守卫失效：第二次挂载即调度（dev-only 噪音备份）
    expect(scheduled).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe('QA·G 多文档并发 / 去重', () => {
  let saves: AutosaveBackupPayload[];
  beforeEach(() => {
    const t = makeTransport();
    saves = t.saves;
    __setAutosaveTransport(t.transport);
  });
  afterEach(() => {
    __resetAutosave();
    vi.useRealTimers();
  });

  it('两个不同 docId 并发 schedule：各自独立落盘、互不覆盖', async () => {
    vi.useFakeTimers();
    scheduleAutosave({ documentId: 'sheet-untitled-1', module: 'sheet', title: '工作簿', serialize: () => new Uint8Array([1]) });
    scheduleAutosave({ documentId: 'sheet-untitled-2', module: 'sheet', title: '工作簿', serialize: () => new Uint8Array([2, 2]) });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(saves).toHaveLength(2);
    const byId = Object.fromEntries(saves.map((s) => [s.documentId, s.bytes.length]));
    expect(byId).toEqual({ 'sheet-untitled-1': 1, 'sheet-untitled-2': 2 });
  });

  it('makeDocumentId：同路径稳定、未命名递增唯一、标题为文件名', () => {
    expect(makeDocumentId('writer', 'C:/a/报告.docx')).toBe(makeDocumentId('writer', 'C:/a/报告.docx'));
    expect(makeDocumentId('writer', 'C:/a/x.docx')).not.toBe(makeDocumentId('writer', 'C:/a/y.docx'));
    const u1 = makeDocumentId('writer');
    const u2 = makeDocumentId('writer');
    expect(u1).not.toBe(u2);
    expect(u1).toMatch(/^writer-untitled-\d+$/);
    expect(makeBackupTitle('writer', 'C:/a/报告.docx')).toBe('报告.docx');
    expect(makeBackupTitle('writer')).toBe('文档');
  });
});

describe('QA·F flush 语义', () => {
  let saves: AutosaveBackupPayload[];
  beforeEach(() => {
    const t = makeTransport();
    saves = t.saves;
    __setAutosaveTransport(t.transport);
  });
  afterEach(() => {
    __resetAutosave();
    vi.useRealTimers();
  });

  it('flush 立即落盘并清空待存；之后再 schedule 可重新武装并再次落盘', async () => {
    vi.useFakeTimers();
    scheduleAutosave({ documentId: 'd1', module: 'writer', title: 'T', serialize: () => new Uint8Array([1]) });
    const first = await flushAutosave('d1');
    expect(first!.length).toBe(1);
    expect(saves).toHaveLength(1);
    // 二次 flush 无待存
    expect(await flushAutosave('d1')).toBeNull();
    // 重新武装
    scheduleAutosave({ documentId: 'd1', module: 'writer', title: 'T', serialize: () => new Uint8Array([9, 9]) });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(saves).toHaveLength(2);
    expect(saves[1]!.bytes.length).toBe(2);
  });

  it('flushAllAutosaves 落盘全部待存条目', async () => {
    vi.useFakeTimers();
    scheduleAutosave({ documentId: 'a', module: 'writer', title: 'A', serialize: () => new Uint8Array([1]) });
    scheduleAutosave({ documentId: 'b', module: 'sheet', title: 'B', serialize: () => new Uint8Array([2]) });
    await flushAllAutosaves();
    expect(saves.map((s) => s.documentId).sort()).toEqual(['a', 'b']);
  });
});

describe('QA·C discard / 错误隔离', () => {
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

  it('discard 取消待存并通知主进程；后续 flush 不再落盘', async () => {
    scheduleAutosave({ documentId: 'd1', module: 'writer', title: 'T', serialize: () => new Uint8Array([1]) });
    expect(await discardAutosave('d1')).toBe(true);
    expect(discards).toEqual(['d1']);
    expect(await flushAutosave('d1')).toBeNull();
    expect(saves).toHaveLength(0);
  });

  it('传输层 saveBackup 抛错被捕获（不冒泡、不落盘泄漏）', async () => {
    __setAutosaveTransport({
      saveBackup: async () => {
        throw new Error('ipc down');
      },
      discardBackup: async () => false,
    });
    scheduleAutosave({ documentId: 'd1', module: 'writer', title: 'T', serialize: () => new Uint8Array([1]) });
    await expect(flushAutosave('d1')).resolves.toBeNull();
  });

  it('传输层 discardBackup 抛错被捕获并返回 false', async () => {
    __setAutosaveTransport({
      saveBackup: async () => null,
      discardBackup: async () => {
        throw new Error('ipc down');
      },
    });
    await expect(discardAutosave('d1')).resolves.toBe(false);
  });
});
