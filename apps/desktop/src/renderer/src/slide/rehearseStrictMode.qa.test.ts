// @vitest-environment jsdom
/**
 * rehearseStrictMode.qa.test.ts —— QA 独立探针（第 3 轮：定向回归「未访问 ≡ 无记录(NaN)」）。
 *
 * 历史：
 *  - 第 1 轮缺陷（P1）：SlideshowOverlay 里基于 effect 卸载的「兜底结算」在 StrictMode 下
 *    会在挂载阶段误触发 onRehearsalFinish。第 2 轮已翻转为「修复后正向断言」。
 *  - 第 3 轮语义变更（team-lead 拍板：「未访问 ≡ 无记录」）：
 *      · 新增纯函数 `finalizeRehearsal(rec, visited)`：未访问页 → `slideMs[i] = NaN`，
 *        已访问页保留实际用时；`totalMs` 只累计「已访问且有限」的页。
 *      · `SlideshowOverlay` 维护 `visitedRef`，切页/结算时标记已访问；**NaN 只出现在
 *        结算产出的副本里**，`recordRef` 始终只含有限数（浮层「累计用时」不得被 NaN 污染）。
 *      · `applyRehearsalTimings`：NaN（未访问）→ 保持该页既有 `advanceAfterMs`；
 *        有限且 < min → 删除；>= min → 写入 clamp 值。
 *    理由：旧行为下「排练中途 Esc」会把后续**从未访问**页既有的自动换片时间静默删除，
 *    与「无记录 → 保持既有值」自相矛盾，属丢配置。
 *
 * 本轮据此：
 *  (1) 更新第 2 轮里 2 条锁定旧语义的断言（Esc 中途 / 末页 next）；
 *  (2) 独立复验新语义（未访问页保留既有 advTm / <min 删除 / clamp / 纯函数性 /
 *      visited 越界 / 浮层累计无 NaN / 普通放映零回归）；
 *  (3) 新增：非排练放映 DOM 逐字节表征守卫（对照 HEAD「改造前」footer）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { StrictMode, useEffect, createElement, act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import type { JkPresentation } from '@jareking/presentation';
import { SlideshowOverlay } from './SlideshowOverlay';
import {
  MAX_ADVANCE_MS,
  MIN_ADVANCE_MS,
  applyRehearsalTimings,
  createRehearsal,
  finalizeRehearsal,
  recordSlideTime,
  type RehearsalRecord,
} from './rehearse';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pres: JkPresentation = {
  slideWidth: 9144000,
  slideHeight: 6858000,
  slides: [{ shapes: [] }, { shapes: [] }, { shapes: [] }],
};

/** 对照探针：确认本测试环境确实复现 StrictMode 的 effect 双调用 */
function ControlProbe({ onSetup, onCleanup }: { onSetup: () => void; onCleanup: () => void }) {
  useEffect(() => {
    onSetup();
    return () => onCleanup();
  }, []);
  return null;
}

function mountOverlay(): { container: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

type OverlayProps = ComponentProps<typeof SlideshowOverlay>;

async function renderOverlay(
  root: ReturnType<typeof createRoot>,
  props: OverlayProps,
): Promise<void> {
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(SlideshowOverlay, props)));
  });
}

/** 以 window 派发键盘事件模拟真实放映按键（监听器挂在 window 上） */
async function press(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('QA·StrictMode 排练挂载探针（第 3 轮·「未访问≡无记录(NaN)」新语义）', () => {
  it('对照：StrictMode 下 effect 会被 setup→cleanup→setup（环境有效性）', async () => {
    let setups = 0;
    let cleanups = 0;
    const { container, root } = mountOverlay();
    await act(async () => {
      root.render(
        createElement(StrictMode, null,
          createElement(ControlProbe, { onSetup: () => setups++, onCleanup: () => cleanups++ }),
        ),
      );
    });
    expect(setups).toBe(2); // 双调用
    expect(cleanups).toBe(1); // 一次模拟卸载
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('rehearse=true：挂载后用户未操作前不触发 onRehearsalFinish（P1 修复）', async () => {
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres,
      startIndex: 0,
      onClose: () => {},
      rehearse: true,
      onRehearsalFinish: onFinish,
    });
    expect(onFinish).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('rehearse=true：纯卸载（无 Esc / 未到末页 next）也不触发结算（P1 修复关键点）', async () => {
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres,
      startIndex: 0,
      onClose: () => {},
      rehearse: true,
      onRehearsalFinish: onFinish,
    });
    // 模拟「挂载即 StrictMode 卸载-重挂」后直接由父组件卸载：不应有任何兜底结算
    await act(async () => {
      root.unmount();
    });
    expect(onFinish).not.toHaveBeenCalled();
    container.remove();
  });

  it('排练中途 Esc：前两页 = [2000,1500]，第 3 页未访问 → NaN，totalMs = 3500（第 3 轮语义）', async () => {
    let now = 1000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres,
      startIndex: 0,
      onClose: () => {},
      rehearse: true,
      onRehearsalFinish: onFinish,
    });

    now = 3000; // 第 1 页停留 2000ms
    await press('ArrowRight'); // → 第 2 页
    now = 4500; // 第 2 页停留 1500ms
    await press('Escape'); // 结算（补记第 2 页 1500ms）

    expect(onFinish).toHaveBeenCalledTimes(1);
    const rec = onFinish.mock.calls[0][0] as RehearsalRecord;
    // 第 3 页从未访问 → NaN（无记录）；前两页保留实际用时
    expect(rec.slideMs[0]).toBe(2000);
    expect(rec.slideMs[1]).toBe(1500);
    expect(Number.isNaN(rec.slideMs[2])).toBe(true);
    expect(rec.slideMs).toHaveLength(3);
    // totalMs 只累计「已访问且有限」的页（NaN 不参与求和）
    expect(rec.totalMs).toBe(3500);

    await act(async () => {
      root.unmount();
    });
    spy.mockRestore();
    container.remove();
  });

  it('末页 next 结算：第 2 页未访问 → NaN，totalMs = 2000，且幂等（再次 next / Esc 不重复回调）', async () => {
    let now = 1000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres,
      startIndex: 0,
      onClose: () => {},
      rehearse: true,
      onRehearsalFinish: onFinish,
    });

    now = 1200;
    await press('End'); // 跳到第 3 页，记录第 1 页 200ms
    now = 3000;
    await press(' '); // 末页 next（空格）→ 结算，补记第 3 页 1800ms

    expect(onFinish).toHaveBeenCalledTimes(1);
    const rec = onFinish.mock.calls[0][0] as RehearsalRecord;
    expect(rec.slideMs[0]).toBe(200);
    expect(rec.slideMs[2]).toBe(1800);
    // 第 2 页被 End 跳过、从未访问 → NaN；故 reduce 求和会变 NaN，
    // 改用显式 totalMs 断言 + NaN 断言（第 3 轮语义）
    expect(Number.isNaN(rec.slideMs[1])).toBe(true);
    expect(rec.totalMs).toBe(2000);

    // 幂等：结算后再按键不应产生第二次回调（finishedRef）
    now = 4000;
    await press('ArrowRight');
    now = 5000;
    await press('Escape');
    expect(onFinish).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    spy.mockRestore();
    container.remove();
  });
});

describe('QA·非排练模式回归（既有放映行为不受改造影响）', () => {
  it('Esc → 仅调用 onClose，绝不触发排练结算', async () => {
    const onClose = vi.fn();
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres,
      startIndex: 0,
      onClose,
      rehearse: false,
      onRehearsalFinish: onFinish,
    });
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('末页 next → 仅调用 onClose（既有行为不变）', async () => {
    const onClose = vi.fn();
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres,
      startIndex: 2, // 直接落在末页
      onClose,
      rehearse: false,
      onRehearsalFinish: onFinish,
    });
    await press('ArrowRight');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('非排练 + 无 advTm：页脚维持既有文案（不出现自动换片倒计时）', async () => {
    const { container, root } = mountOverlay();
    await renderOverlay(root, { pres, startIndex: 0, onClose: () => {}, rehearse: false });
    expect(container.textContent).toContain('Esc 退出');
    expect(container.textContent).not.toContain('自动换片');
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('非排练 + 当前页有合法 advTm：页脚出现自动换片倒计时', async () => {
    const presAdv: JkPresentation = {
      ...pres,
      slides: [{ shapes: [], advanceAfterMs: 3000 }, { shapes: [] }, { shapes: [] }],
    };
    const { container, root } = mountOverlay();
    await renderOverlay(root, { pres: presAdv, startIndex: 0, onClose: () => {}, rehearse: false });
    expect(container.textContent).toContain('自动换片');
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('非排练：advTm 到期自动 next；后续无 advTm 的页不会自动切', async () => {
    vi.useFakeTimers();
    const presAdv: JkPresentation = {
      ...pres,
      slides: [{ shapes: [], advanceAfterMs: 1000 }, { shapes: [] }, { shapes: [] }],
    };
    const { container, root } = mountOverlay();
    await renderOverlay(root, { pres: presAdv, startIndex: 0, onClose: () => {}, rehearse: false });
    expect(container.textContent).toContain('1 / 3');

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toContain('2 / 3');

    // 第 2 页无 advTm → 时间继续推进也不会自动切到第 3 页
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(container.textContent).toContain('2 / 3');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe('QA·非排练放映 DOM 逐字节表征（对照 HEAD「改造前」零回归守卫）', () => {
  it('默认非排练（无 advTm）完整 innerHTML 与「改造前」逐字节一致', async () => {
    const { container, root } = mountOverlay();
    await renderOverlay(root, { pres, startIndex: 0, onClose: () => {}, rehearse: false });
    // HEAD（未引入排练计时前）该页脚文案为 `{idx+1} / {n} · Esc 退出 · 右键上一页`；
    // 本轮 diff 仅把该文本节点换成 `footerText`，默认非排练分支求值结果与旧版逐字符相同，
    // 且 JSX 其余部分零改动 —— 故整段 innerHTML 应与改造前逐字节一致。
    const golden = `<div class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black"><style>
        @keyframes jk-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes jk-slide-in { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes jk-enter { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
      </style><div class="relative bg-white shadow-2xl" style="width: 901.1200000000001px; height: 675.84px;"></div><div class="absolute bottom-4 rounded-full bg-black/60 px-4 py-1 text-sm text-white/90">1 / 3 · Esc 退出 · 右键上一页</div></div>`;
    expect(container.innerHTML).toBe(golden);
    // 默认非排练 DOM 不含任何排练痕迹
    expect(container.innerHTML).not.toContain('未排练');
    expect(container.innerHTML).not.toContain('NaN');
    expect(container.innerHTML).not.toContain('排练');
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe('QA·applyRehearsalTimings 边界（P2-1 修复 + 第 3 轮 NaN 语义）', () => {
  const mk = (adv: (number | undefined)[]): JkPresentation => ({
    slideWidth: 1,
    slideHeight: 1,
    slides: adv.map((a) => (a === undefined ? { shapes: [] } : { shapes: [], advanceAfterMs: a })),
  });

  it('记录前缀为「无记录」(undefined) → 前面各页既有 advTm 原样保留', () => {
    const source = mk([1111, 2222, 3333, 4444]);
    const rec = { slideMs: [undefined, undefined, 3000, 4000], totalMs: 7000 } as unknown as RehearsalRecord;
    const out = applyRehearsalTimings(source, rec);
    expect(out.slides.map((s) => s.advanceAfterMs)).toEqual([1111, 2222, 3000, 4000]);
    // 入参未被修改
    expect(source.slides.map((s) => s.advanceAfterMs)).toEqual([1111, 2222, 3333, 4444]);
  });

  it('部分记录（页数少于 slides）→ 未覆盖页保持既有 advTm，覆盖为 0 的页被删除', () => {
    const source = mk([1000, 2000, 3000, 4000]);
    const rec = createRehearsal(2); // slideMs=[0,0] → 索引 2/3 无记录
    const out = applyRehearsalTimings(source, rec);
    expect(out.slides[0].advanceAfterMs).toBeUndefined(); // 有记录 0 < min → 删除
    expect(out.slides[1].advanceAfterMs).toBeUndefined();
    expect(out.slides[2].advanceAfterMs).toBe(3000); // 无记录 → 保持
    expect(out.slides[3].advanceAfterMs).toBe(4000);
  });

  it('记录项为 NaN / Infinity → 视为无记录，保持既有值', () => {
    const source = mk([1111, 2222]);
    const rec = { slideMs: [Number.NaN, Number.POSITIVE_INFINITY], totalMs: 0 };
    const out = applyRehearsalTimings(source, rec);
    expect(out.slides.map((s) => s.advanceAfterMs)).toEqual([1111, 2222]);
  });

  it('有记录恰为下限 500 → 写入 500（不删除）；499 → 删除该页 advTm', () => {
    expect(MIN_ADVANCE_MS).toBe(500);
    const atMin = applyRehearsalTimings(
      mk([undefined]),
      recordSlideTime(createRehearsal(1), 0, MIN_ADVANCE_MS),
    );
    expect(atMin.slides[0].advanceAfterMs).toBe(500);

    const belowMin = applyRehearsalTimings(
      mk([9999]),
      recordSlideTime(createRehearsal(1), 0, MIN_ADVANCE_MS - 1),
    );
    expect(belowMin.slides[0].advanceAfterMs).toBeUndefined();
  });

  it('有记录超过上限 → 钳制到 MAX_ADVANCE_MS（700000 → 600000）', () => {
    expect(MAX_ADVANCE_MS).toBe(600000);
    const out = applyRehearsalTimings(
      mk([undefined]),
      recordSlideTime(createRehearsal(1), 0, 700000),
    );
    expect(out.slides[0].advanceAfterMs).toBe(MAX_ADVANCE_MS);
  });
});

describe('QA·「未访问 ≡ 无记录(NaN)」新语义独立复验（第 3 轮）', () => {
  it('finalizeRehearsal：未访问 → NaN；已访问保留（含 0）；totalMs 仅累计有限已访问项', () => {
    let rec = createRehearsal(3);
    rec = recordSlideTime(rec, 0, 2500);
    rec = recordSlideTime(rec, 1, 0); // 已访问但瞬间切换 → 保留 0，不等于「未访问」
    const out = finalizeRehearsal(rec, [true, true, false]);
    expect(out.slideMs[0]).toBe(2500);
    expect(out.slideMs[1]).toBe(0);
    expect(Number.isNaN(out.slideMs[2])).toBe(true);
    expect(out.totalMs).toBe(2500);
    expect(out.slideMs).toHaveLength(3);
  });

  it('finalizeRehearsal：纯函数 —— rec 与 visited 均不被修改', () => {
    let rec = createRehearsal(2);
    rec = recordSlideTime(rec, 0, 1234);
    const visited = [true, false];
    const recSnap = JSON.stringify(rec);
    const visitedSnap = JSON.stringify(visited);
    const out = finalizeRehearsal(rec, visited);
    expect(JSON.stringify(rec)).toBe(recSnap);
    expect(JSON.stringify(visited)).toBe(visitedSnap);
    expect(out).not.toBe(rec);
    expect(out.slideMs).not.toBe(rec.slideMs);
  });

  it('finalizeRehearsal：visited 长度不足 → 缺失按未访问；超长 → 多余项安全忽略', () => {
    let rec = createRehearsal(3);
    rec = recordSlideTime(rec, 0, 1000);
    rec = recordSlideTime(rec, 1, 2000);
    rec = recordSlideTime(rec, 2, 3000);
    const short = finalizeRehearsal(rec, [true]);
    expect(short.slideMs[0]).toBe(1000);
    expect(Number.isNaN(short.slideMs[1])).toBe(true);
    expect(Number.isNaN(short.slideMs[2])).toBe(true);
    expect(short.totalMs).toBe(1000);
    expect(short.slideMs).toHaveLength(3);

    const long = finalizeRehearsal(rec, [true, true, true, true, true]);
    expect(long.slideMs).toEqual([1000, 2000, 3000]);
    expect(long.totalMs).toBe(6000);
    expect(long.slideMs).toHaveLength(3);
  });

  it('finalizeRehearsal：已访问页记录为非有限数（NaN/Infinity）→ 兜底为 0（不产生 NaN 污染）', () => {
    const rec: RehearsalRecord = { slideMs: [Number.NaN, Number.POSITIVE_INFINITY], totalMs: 0 };
    const out = finalizeRehearsal(rec, [true, true]);
    expect(out.slideMs).toEqual([0, 0]);
    expect(out.totalMs).toBe(0);
  });

  it('端到端：仅访问第 1 页即 Esc → 第 2/3 页既有 advTm 原样保留', async () => {
    let now = 1000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const presAdv: JkPresentation = {
      slideWidth: 9144000,
      slideHeight: 6858000,
      slides: [
        { shapes: [], advanceAfterMs: 1111 },
        { shapes: [], advanceAfterMs: 2222 },
        { shapes: [], advanceAfterMs: 3333 },
      ],
    };
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres: presAdv,
      startIndex: 0,
      onClose: () => {},
      rehearse: true,
      onRehearsalFinish: onFinish,
    });

    now = 4000; // 第 1 页停留 3000ms
    await press('Escape');

    const rec = onFinish.mock.calls[0][0] as RehearsalRecord;
    expect(rec.slideMs[0]).toBe(3000);
    expect(Number.isNaN(rec.slideMs[1])).toBe(true);
    expect(Number.isNaN(rec.slideMs[2])).toBe(true);
    expect(rec.totalMs).toBe(3000);

    const applied = applyRehearsalTimings(presAdv, rec);
    expect(applied.slides.map((s) => s.advanceAfterMs)).toEqual([3000, 2222, 3333]);
    // 入参未被修改
    expect(presAdv.slides.map((s) => s.advanceAfterMs)).toEqual([1111, 2222, 3333]);

    await act(async () => {
      root.unmount();
    });
    spy.mockRestore();
    container.remove();
  });

  it('端到端：第 1 页用时 300ms(< min) 即 Esc → 该页既有 advTm 删除，其余保留', async () => {
    let now = 1000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const presAdv: JkPresentation = {
      slideWidth: 9144000,
      slideHeight: 6858000,
      slides: [
        { shapes: [], advanceAfterMs: 9999 },
        { shapes: [], advanceAfterMs: 2222 },
        { shapes: [], advanceAfterMs: 3333 },
      ],
    };
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres: presAdv,
      startIndex: 0,
      onClose: () => {},
      rehearse: true,
      onRehearsalFinish: onFinish,
    });

    now = 1300; // 第 1 页仅停留 300ms（刻意点击换片）
    await press('Escape');

    const rec = onFinish.mock.calls[0][0] as RehearsalRecord;
    expect(rec.slideMs[0]).toBe(300);
    const applied = applyRehearsalTimings(presAdv, rec);
    expect(applied.slides[0].advanceAfterMs).toBeUndefined(); // < min → 删除
    expect(applied.slides[1].advanceAfterMs).toBe(2222); // 未访问 → 保持
    expect(applied.slides[2].advanceAfterMs).toBe(3333);

    await act(async () => {
      root.unmount();
    });
    spy.mockRestore();
    container.remove();
  });

  it('浮层「累计用时」在排练过程中及结算后均不出现 NaN（NaN 只在结算副本里）', async () => {
    let now = 1000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres,
      startIndex: 0,
      onClose: () => {},
      rehearse: true,
      onRehearsalFinish: onFinish,
    });

    expect(container.textContent).toContain('累计');
    expect(container.textContent).not.toContain('NaN');

    now = 3000;
    await press('ArrowRight');
    expect(container.textContent).not.toContain('NaN');

    now = 7000;
    await press('ArrowRight');
    expect(container.textContent).not.toContain('NaN');

    now = 9000;
    await press('Escape'); // 结算（第 3 页已访问，第 1/2 页保留 —— 本轮 3 页全被访问，无 NaN）
    expect(container.textContent).not.toContain('NaN');
    const rec = onFinish.mock.calls[0][0] as RehearsalRecord;
    // 3 页均被访问（0→1→2→末页结算）→ 副本里也不应有 NaN
    expect(rec.slideMs.every((v) => Number.isFinite(v))).toBe(true);

    await act(async () => {
      root.unmount();
    });
    spy.mockRestore();
    container.remove();
  });

  it('浮层「累计用时」：中途 Esc 场景下结算前文本无 NaN，NaN 仅出现在回传副本的第 3 页', async () => {
    let now = 1000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onFinish = vi.fn();
    const { container, root } = mountOverlay();
    await renderOverlay(root, {
      pres,
      startIndex: 0,
      onClose: () => {},
      rehearse: true,
      onRehearsalFinish: onFinish,
    });

    now = 3000;
    await press('ArrowRight'); // 第 1 页 2000ms
    now = 4000;
    await press('Escape'); // 结算（第 2 页补记 1000ms，第 3 页未访问）

    // 结算后浮层仍挂载（rehearse 结算不关闭，由父组件决策）→ 累计文本仍为有限数
    expect(container.textContent).not.toContain('NaN');
    const rec = onFinish.mock.calls[0][0] as RehearsalRecord;
    expect(Number.isNaN(rec.slideMs[2])).toBe(true);

    await act(async () => {
      root.unmount();
    });
    spy.mockRestore();
    container.remove();
  });
});
