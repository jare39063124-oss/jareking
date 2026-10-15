/**
 * rehearse.test.ts —— 演示「排练计时」纯函数层单测。
 *
 * 覆盖：formatClock 分档与非法输入、createRehearsal / recordSlideTime 边界
 * （负数、NaN、越界、累加、纯函数性）、finalizeRehearsal 结算（未访问 → NaN、
 * totalMs 只计已访问、纯函数性、visited 长度容错）、rehearsalSummary 零页不除零、
 * applyRehearsalTimings 三态语义（无记录保持既有 / 有记录钳制 / 低于下限删除）、
 * clear / has / total。
 */
import { describe, expect, it } from 'vitest';
import type { JkPresentation } from '@jareking/presentation';
import {
  MIN_ADVANCE_MS,
  MAX_ADVANCE_MS,
  applyRehearsalTimings,
  clearRehearsalTimings,
  createRehearsal,
  finalizeRehearsal,
  formatClock,
  hasRehearsalTimings,
  recordSlideTime,
  rehearsalSummary,
  totalRehearsalMs,
} from './rehearse';

/** 便捷构造：n 页空演示文稿 */
function makePres(n: number, advance?: (number | undefined)[]): JkPresentation {
  return {
    slideWidth: 9144000,
    slideHeight: 6858000,
    slides: Array.from({ length: n }, (_, i) => ({
      shapes: [],
      ...(advance && advance[i] !== undefined ? { advanceAfterMs: advance[i] } : {}),
    })),
  };
}

describe('formatClock 时间格式化', () => {
  it('毫秒向下取整到秒：0ms → 0:00，5000ms → 0:05', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5000)).toBe('0:05');
    expect(formatClock(5999)).toBe('0:05');
  });

  it('不足 1 小时：M:SS（分不补零、秒补零）', () => {
    expect(formatClock(83000)).toBe('1:23');
    expect(formatClock(723000)).toBe('12:03');
  });

  it('达到 1 小时：H:MM:SS（分、秒补零）', () => {
    expect(formatClock(3600000)).toBe('1:00:00');
    expect(formatClock(3723000)).toBe('1:02:03');
  });

  it('负数 / NaN / Infinity 按 0 处理', () => {
    expect(formatClock(-100)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('createRehearsal 创建记录', () => {
  it('按页数创建全 0 记录，总用时为 0', () => {
    const rec = createRehearsal(3);
    expect(rec.slideMs).toEqual([0, 0, 0]);
    expect(rec.totalMs).toBe(0);
  });

  it('非法页数（负数 / 小数向下取整 / 非有限数）', () => {
    expect(createRehearsal(-2).slideMs).toHaveLength(0);
    expect(createRehearsal(2.9).slideMs).toHaveLength(2);
    expect(createRehearsal(Number.NaN).slideMs).toHaveLength(0);
  });
});

describe('recordSlideTime 逐页记录', () => {
  it('写入某页并重算总用时', () => {
    let rec = createRehearsal(3);
    rec = recordSlideTime(rec, 0, 1200);
    rec = recordSlideTime(rec, 2, 800);
    expect(rec.slideMs).toEqual([1200, 0, 800]);
    expect(rec.totalMs).toBe(2000);
  });

  it('覆盖同一页时以新值替换（非累加）', () => {
    let rec = createRehearsal(2);
    rec = recordSlideTime(rec, 0, 1000);
    rec = recordSlideTime(rec, 0, 3000);
    expect(rec.slideMs[0]).toBe(3000);
    expect(rec.totalMs).toBe(3000);
  });

  it('负数 / NaN 一律按 0', () => {
    let rec = createRehearsal(2);
    rec = recordSlideTime(rec, 0, -500);
    rec = recordSlideTime(rec, 1, Number.NaN);
    expect(rec.slideMs).toEqual([0, 0]);
    expect(rec.totalMs).toBe(0);
  });

  it('index 越界忽略（值不变、totalMs 重算为原值）', () => {
    let rec = createRehearsal(2);
    rec = recordSlideTime(rec, 0, 1000);
    const outLow = recordSlideTime(rec, -1, 9999);
    const outHigh = recordSlideTime(rec, 5, 9999);
    expect(outLow.slideMs).toEqual([1000, 0]);
    expect(outHigh.slideMs).toEqual([1000, 0]);
    expect(outHigh.totalMs).toBe(1000);
  });

  it('为纯函数：不修改入参', () => {
    const rec = createRehearsal(2);
    const snapshot = JSON.stringify(rec);
    const out = recordSlideTime(rec, 0, 1234);
    expect(JSON.stringify(rec)).toBe(snapshot);
    expect(out).not.toBe(rec);
    expect(out.slideMs).not.toBe(rec.slideMs);
  });
});

describe('finalizeRehearsal 结算（未访问 → 无记录 NaN）', () => {
  it('未访问页 → NaN，已访问页保留实际用时，页数不变', () => {
    let rec = createRehearsal(4);
    rec = recordSlideTime(rec, 0, 3000);
    rec = recordSlideTime(rec, 1, 0); // 已访问但瞬间切换（保留 0，不转为 NaN）
    // 页 2、3 从未访问
    const out = finalizeRehearsal(rec, [true, true, false, false]);
    expect(out.slideMs[0]).toBe(3000);
    expect(out.slideMs[1]).toBe(0);
    expect(Number.isNaN(out.slideMs[2])).toBe(true);
    expect(Number.isNaN(out.slideMs[3])).toBe(true);
    expect(out.slideMs).toHaveLength(4);
  });

  it('totalMs 只累计已访问且有限值（NaN 不参与求和）', () => {
    let rec = createRehearsal(3);
    rec = recordSlideTime(rec, 0, 1200);
    rec = recordSlideTime(rec, 1, 800);
    rec = recordSlideTime(rec, 2, 5000);
    const out = finalizeRehearsal(rec, [true, false, true]);
    // 仅页 0（1200）+ 页 2（5000）= 6200；页 1 未访问 → NaN 不计入
    expect(out.totalMs).toBe(6200);
    expect(Number.isNaN(out.slideMs[1])).toBe(true);
  });

  it('为纯函数：不修改入参（rec 与 visited 均不变）', () => {
    let rec = createRehearsal(2);
    rec = recordSlideTime(rec, 0, 1000);
    const visited = [true, false];
    const recSnap = JSON.stringify(rec);
    const visitedSnap = JSON.stringify(visited);
    const out = finalizeRehearsal(rec, visited);
    expect(JSON.stringify(rec)).toBe(recSnap);
    expect(JSON.stringify(visited)).toBe(visitedSnap);
    expect(out).not.toBe(rec);
    expect(out.slideMs).not.toBe(rec.slideMs);
    expect(visited[1]).toBe(false);
  });

  it('visited 长度不足 → 缺失下标按未访问（NaN）；超长 → 多出项安全忽略', () => {
    let rec = createRehearsal(3);
    rec = recordSlideTime(rec, 0, 1000);
    rec = recordSlideTime(rec, 1, 2000);
    rec = recordSlideTime(rec, 2, 3000);
    // 长度不足：仅标记第 0 页已访问
    const short = finalizeRehearsal(rec, [true]);
    expect(short.slideMs[0]).toBe(1000);
    expect(Number.isNaN(short.slideMs[1])).toBe(true);
    expect(Number.isNaN(short.slideMs[2])).toBe(true);
    expect(short.totalMs).toBe(1000);
    expect(short.slideMs).toHaveLength(3);
    // 超长：多出的 visited 项被忽略，长度仍与 rec 一致
    const long = finalizeRehearsal(rec, [true, true, true, true, true, true]);
    expect(long.slideMs).toEqual([1000, 2000, 3000]);
    expect(long.totalMs).toBe(6000);
    expect(long.slideMs).toHaveLength(3);
  });

  it('结算结果写回：未访问页保持既有值，已访问的 0 页删除既有值', () => {
    // 4 页，全部已有自动换片时间
    const pres = makePres(4, [1111, 2222, 3333, 4444]);
    let rec = createRehearsal(4);
    rec = recordSlideTime(rec, 0, 3000); // 已访问且 ≥ 下限 → 覆盖
    rec = recordSlideTime(rec, 1, 0); // 已访问但瞬间切换 → 删除既有值
    // 页 2、3 未访问 → 保持既有值
    const finalized = finalizeRehearsal(rec, [true, true, false, false]);
    const out = applyRehearsalTimings(pres, finalized);
    expect(out.slides[0].advanceAfterMs).toBe(3000);
    expect(out.slides[1].advanceAfterMs).toBeUndefined();
    expect(out.slides[2].advanceAfterMs).toBe(3333);
    expect(out.slides[3].advanceAfterMs).toBe(4444);
    // 入参未被修改
    expect(pres.slides.map((s) => s.advanceAfterMs)).toEqual([1111, 2222, 3333, 4444]);
  });
});

describe('rehearsalSummary 汇总', () => {
  it('总用时 / 每页用时 / 平均用时', () => {
    let rec = createRehearsal(4);
    [1000, 3000, 0, 4000].forEach((v, i) => {
      rec = recordSlideTime(rec, i, v);
    });
    const sum = rehearsalSummary(rec);
    expect(sum.totalText).toBe('0:08');
    expect(sum.slideTexts).toEqual(['0:01', '0:03', '0:00', '0:04']);
    // (1000+3000+0+4000)/4 = 2000ms → 0:02
    expect(sum.averageText).toBe('0:02');
  });

  it('零页不除零：平均用时按 0', () => {
    const sum = rehearsalSummary(createRehearsal(0));
    expect(sum.totalText).toBe('0:00');
    expect(sum.slideTexts).toEqual([]);
    expect(sum.averageText).toBe('0:00');
  });
});

describe('applyRehearsalTimings 写回计时', () => {
  it('有记录且 >= 下限写 clamp 值，有记录但 < 下限删除既有值，且不改入参', () => {
    const pres = makePres(3, [9999, 9999, 9999]);
    const snapshot = JSON.stringify(pres);
    let rec = createRehearsal(3);
    rec = recordSlideTime(rec, 0, 3000);
    rec = recordSlideTime(rec, 1, 100); // 有记录但低于下限 → 删除
    rec = recordSlideTime(rec, 2, 5000);

    const out = applyRehearsalTimings(pres, rec);
    expect(out.slides[0].advanceAfterMs).toBe(3000);
    expect(out.slides[1].advanceAfterMs).toBeUndefined();
    expect(out.slides[2].advanceAfterMs).toBe(5000);
    // 入参未被修改
    expect(JSON.stringify(pres)).toBe(snapshot);
    expect(pres.slides[1].advanceAfterMs).toBe(9999);
  });

  it('无记录（undefined / 非有限数）→ 保持该页既有 advanceAfterMs 不变（不删不改）', () => {
    // 记录长度不足 → 索引 1/2 为 undefined（无记录）
    const pres = makePres(3, [1111, 2222, 3333]);
    const shortRec = createRehearsal(1); // slideMs = [0]，索引 1/2 无记录
    const out = applyRehearsalTimings(pres, shortRec);
    // 索引 0 有明确记录 0（< 下限）→ 删除；索引 1/2 无记录 → 保持既有值
    expect(out.slides[0].advanceAfterMs).toBeUndefined();
    expect(out.slides[1].advanceAfterMs).toBe(2222);
    expect(out.slides[2].advanceAfterMs).toBe(3333);

    // 非有限数（NaN / Infinity）同样按「无记录」处理，保持既有值
    const pres2 = makePres(3, [1111, 2222, 3333]);
    const nanRec = { slideMs: [Number.NaN, Number.POSITIVE_INFINITY, 100], totalMs: 0 };
    const out2 = applyRehearsalTimings(pres2, nanRec);
    expect(out2.slides[0].advanceAfterMs).toBe(1111); // NaN → 保持
    expect(out2.slides[1].advanceAfterMs).toBe(2222); // Infinity → 保持
    expect(out2.slides[2].advanceAfterMs).toBeUndefined(); // 100 < 下限 → 删除
    // 入参未被修改
    expect(pres.slides.map((s) => s.advanceAfterMs)).toEqual([1111, 2222, 3333]);
  });

  it('超过上限钳制到 MAX_ADVANCE_MS', () => {
    const pres = makePres(1);
    const rec = recordSlideTime(createRehearsal(1), 0, MAX_ADVANCE_MS + 100000);
    const out = applyRehearsalTimings(pres, rec);
    expect(out.slides[0].advanceAfterMs).toBe(MAX_ADVANCE_MS);
  });

  it('记录多出的页（超出幻灯片数）被忽略', () => {
    const pres = makePres(2);
    let rec = createRehearsal(5);
    rec = recordSlideTime(rec, 0, 2000);
    rec = recordSlideTime(rec, 4, 8000); // 越界页
    const out = applyRehearsalTimings(pres, rec);
    expect(out.slides).toHaveLength(2);
    expect(out.slides[0].advanceAfterMs).toBe(2000);
    expect(out.slides[1].advanceAfterMs).toBeUndefined();
  });

  it('可通过 opts 自定义下限', () => {
    const pres = makePres(1);
    const rec = recordSlideTime(createRehearsal(1), 0, 300);
    const out = applyRehearsalTimings(pres, rec, { minAdvanceMs: 200 });
    expect(out.slides[0].advanceAfterMs).toBe(300);
    // 默认下限下同一记录应被删除
    expect(applyRehearsalTimings(pres, rec).slides[0].advanceAfterMs).toBeUndefined();
    expect(MIN_ADVANCE_MS).toBe(500);
  });
});

describe('clear / has / total', () => {
  it('clearRehearsalTimings 清除全部页且返回新对象', () => {
    const pres = makePres(3, [1000, undefined, 2000]);
    const out = clearRehearsalTimings(pres);
    expect(out.slides.every((s) => s.advanceAfterMs === undefined)).toBe(true);
    expect(out).not.toBe(pres);
    // 入参保留原值
    expect(pres.slides[0].advanceAfterMs).toBe(1000);
  });

  it('hasRehearsalTimings 与 totalRehearsalMs 仅统计合法值', () => {
    const none = makePres(2);
    expect(hasRehearsalTimings(none)).toBe(false);
    expect(totalRehearsalMs(none)).toBe(0);

    const some = makePres(3, [1000, undefined, 2500]);
    expect(hasRehearsalTimings(some)).toBe(true);
    expect(totalRehearsalMs(some)).toBe(3500);

    // 非法值（0 / 负数）不计入
    const bad: JkPresentation = {
      slideWidth: 1,
      slideHeight: 1,
      slides: [{ shapes: [], advanceAfterMs: 0 }, { shapes: [], advanceAfterMs: -5 }],
    };
    expect(hasRehearsalTimings(bad)).toBe(false);
    expect(totalRehearsalMs(bad)).toBe(0);
  });
});
