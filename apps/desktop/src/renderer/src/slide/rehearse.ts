/**
 * rehearse.ts —— 演示「排练计时」纯函数层（对标 WPS：幻灯片放映 → 排练计时）。
 *
 * 职责（全部为无副作用的纯函数，便于单测与复用）：
 *  - 时间格式化（formatClock）
 *  - 排练记录（RehearsalRecord）的创建 / 逐页累加 / 汇总
 *  - 将排练时间写回 / 清除演示文稿的 advanceAfterMs（自动换片时间，毫秒）
 *
 * 数据模型约定：`JkSlide.advanceAfterMs` 对应 OOXML `<p:transition advTm="毫秒">`，
 * 合法值须为有限数且 > 0；低于 MIN_ADVANCE_MS 视为「点击换片」不写该字段。
 *
 * 本文件不依赖 React / DOM，可在渲染进程与测试环境直接调用。
 */
import type { JkPresentation, JkSlide } from '@jareking/presentation';

/**
 * 自动换片时间下界（毫秒）：低于此值视为「点击换片」，不写 advTm。
 * 取 500ms 以过滤排练时的误触（几乎瞬间切换）而非真实停留。
 */
export const MIN_ADVANCE_MS = 500;

/** 自动换片时间上界（毫秒）：600000ms = 10 分钟，超出则钳制（防误录超长停留）。 */
export const MAX_ADVANCE_MS = 600000;

/** 一次排练的计时记录：每页停留时长（毫秒）+ 总用时（毫秒，等于各页之和） */
export interface RehearsalRecord {
  /** 各页用时（毫秒），下标与幻灯片页序一致 */
  slideMs: number[];
  /** 总用时（毫秒） */
  totalMs: number;
}

/**
 * 毫秒 → 时钟文本。
 *  - 0:05 / 1:23 / 12:03（不足 1 小时：M:SS，秒补零）
 *  - 1:02:03（1 小时及以上：H:MM:SS，分秒补零）
 * 负数 / 非有限数一律按 0 处理；毫秒向下取整到秒。
 */
export function formatClock(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSec = Math.floor(safe / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/** 创建一份空排练记录（页数 = slideCount；非法页数按 0 处理）。 */
export function createRehearsal(slideCount: number): RehearsalRecord {
  const count = Number.isFinite(slideCount) && slideCount > 0 ? Math.floor(slideCount) : 0;
  return { slideMs: new Array<number>(count).fill(0), totalMs: 0 };
}

/**
 * 记录某一页的停留时长，返回**新**记录（不修改入参）。
 *  - ms 非有限数 / 负数 → 按 0 处理
 *  - index 越界（<0 / >= 页数）→ 忽略该次记录（其余保持，totalMs 重算）
 */
export function recordSlideTime(
  rec: RehearsalRecord,
  index: number,
  ms: number,
): RehearsalRecord {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const slideMs = rec.slideMs.slice();
  if (Number.isInteger(index) && index >= 0 && index < slideMs.length) {
    slideMs[index] = value;
  }
  const totalMs = slideMs.reduce((sum, v) => sum + v, 0);
  return { slideMs, totalMs };
}

/**
 * 结算排练：把**未访问**的页标记为「无记录」（NaN），已访问页保留实际用时。
 * 返回**新**记录（不修改入参 `rec` / `visited`），`slideMs.length` 与入参一致。
 *
 * 语义（与 P2-1「无记录 → 保持该页既有值」呼应）：
 *  - `visited[i] !== true`（未访问 / 下标越界 / 非布尔真值）→ `slideMs[i] = NaN`
 *    （NaN 在 {@link applyRehearsalTimings} 中天然落入「非有限数」分支 = 无记录 → 保持既有值）；
 *  - `visited[i] === true`（已访问）→ 保留该页实际用时（非有限数兜底为 0）；
 *  - `totalMs` 只累计**已访问且有限**的页（NaN 不参与求和，避免污染总数）。
 *
 * 用途：排练中途按 Esc 结束时，后面**从未访问**的页不应被当作「本次排练刻意点击换片」，
 * 从而避免误删这些页既有的自动换片时间（静默丢配置）。
 */
export function finalizeRehearsal(rec: RehearsalRecord, visited: boolean[]): RehearsalRecord {
  const slideMs = rec.slideMs.map((ms, i) => {
    // 未访问 → 无记录（NaN，保持既有值）；已访问 → 保留实际用时（非有限数兜底 0）
    if (visited[i] !== true) return Number.NaN;
    return Number.isFinite(ms) ? ms : 0;
  });
  const totalMs = slideMs.reduce((sum, v) => (Number.isFinite(v) ? sum + v : sum), 0);
  return { slideMs, totalMs };
}

/** 排练汇总结果（文本化，便于直接渲染） */
export interface RehearsalSummary {
  /** 总用时文本 */
  totalText: string;
  /** 每页用时文本（下标与页序一致） */
  slideTexts: string[];
  /** 平均每页用时文本（页数为 0 时为 0:00，避免除零） */
  averageText: string;
}

/**
 * 生成排练汇总（总用时 / 每页用时 / 平均用时）。
 * 页数为 0 时平均用时按 0 处理，不做除零。
 * NaN 页（未访问 / 无记录）无需特殊处理：`formatClock(NaN)` 已按 0 处理，
 * 因此其文本显示为 `0:00`（若需区分「未排练」，请直接判定 `Number.isNaN(rec.slideMs[i])`）。
 */
export function rehearsalSummary(rec: RehearsalRecord): RehearsalSummary {
  const count = rec.slideMs.length;
  return {
    totalText: formatClock(rec.totalMs),
    slideTexts: rec.slideMs.map((v) => formatClock(v)),
    averageText: count > 0 ? formatClock(rec.totalMs / count) : formatClock(0),
  };
}

/** applyRehearsalTimings 可选项 */
export interface ApplyRehearsalOptions {
  /** 低于该值视为「点击换片」不写 advTm（默认 MIN_ADVANCE_MS） */
  minAdvanceMs?: number;
  /** 上限钳制（默认 MAX_ADVANCE_MS） */
  maxAdvanceMs?: number;
}

/**
 * 把排练记录写回演示文稿，返回**新** pres（不修改入参）。
 *
 * 逐页语义（对标 WPS：本次排练未涉及的页应保留既有自动换片时间）：
 *  - **无记录**（`undefined` / 非有限数，含 `NaN` = 未访问）→ **保持该页既有 `advanceAfterMs` 不变**（不删、不改）；
 *  - 有明确记录且 `>= min` → 设为 `clamp(ms, min, max)`；
 *  - 有明确记录且 `< min`（含 0）→ **删除**该字段（本次排练中该页为「点击换片」）。
 *  - 记录中多出的页（超出 pres.slides）忽略。
 */
export function applyRehearsalTimings(
  pres: JkPresentation,
  rec: RehearsalRecord,
  opts?: ApplyRehearsalOptions,
): JkPresentation {
  const min = opts?.minAdvanceMs ?? MIN_ADVANCE_MS;
  const max = opts?.maxAdvanceMs ?? MAX_ADVANCE_MS;
  const slides: JkSlide[] = pres.slides.map((slide, i) => {
    const raw = rec.slideMs[i];
    // 无记录（undefined / 非有限数）：本次排练未涉及该页 → 保持既有值不变
    if (raw === undefined || !Number.isFinite(raw)) {
      return { ...slide };
    }
    const next: JkSlide = { ...slide };
    if (raw < min) {
      // 有明确记录但低于下限：本次排练该页为「点击换片」→ 删除既有值
      delete next.advanceAfterMs;
      return next;
    }
    next.advanceAfterMs = Math.min(Math.max(raw, min), max);
    return next;
  });
  return { ...pres, slides };
}

/** 清除全部页的 advanceAfterMs，返回**新** pres（不修改入参）。 */
export function clearRehearsalTimings(pres: JkPresentation): JkPresentation {
  const slides: JkSlide[] = pres.slides.map((slide) => {
    if (slide.advanceAfterMs === undefined) return slide;
    const next: JkSlide = { ...slide };
    delete next.advanceAfterMs;
    return next;
  });
  return { ...pres, slides };
}

/** 是否存在任一页设置了合法 advTm（有限数且 > 0）。 */
export function hasRehearsalTimings(pres: JkPresentation): boolean {
  return pres.slides.some(
    (s) => typeof s.advanceAfterMs === 'number' && Number.isFinite(s.advanceAfterMs) && s.advanceAfterMs > 0,
  );
}

/** 全部页 advTm 之和（毫秒）；仅统计合法值。 */
export function totalRehearsalMs(pres: JkPresentation): number {
  return pres.slides.reduce((sum, s) => {
    const v = s.advanceAfterMs;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? sum + v : sum;
  }, 0);
}
