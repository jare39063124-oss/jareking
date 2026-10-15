/**
 * pdfView —— PDF 阅读器纯逻辑辅助（无 DOM / 无 pdf.js 依赖，便于单测）。
 *
 * 只放「缩放计算 / 页码解析 / 搜索匹配 / 可见页判定」等确定性函数；
 * 真正的渲染（canvas / 文本层）在 PdfReader.tsx，避免把 pdf.js 牵进单测。
 */

/** PDF 阅读缩放允许区间（对页面 scale=1 基准的相对缩放）。 */
export const PDF_ZOOM_MIN = 0.5;
export const PDF_ZOOM_MAX = 3;

/** 连续模式页数告警阈值：超过则提示内存占用（懒加载仍生效，仅提醒）。 */
export const PDF_CONTINUOUS_WARN_PAGES = 200;

/** 缩进步长（与 WPS 的 ±10% 观感一致）。 */
export const PDF_ZOOM_STEP = 0.1;

/** 页面 / 容器的二维尺寸（CSS 像素）。 */
export interface Size {
  width: number;
  height: number;
}

/**
 * 把缩放值钳制到合法区间并保留两位小数。
 * 非有限值（NaN / Infinity）回退为 1（100%）。
 */
export function clampPdfZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  const clamped = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, zoom));
  // 保留两位小数，避免 0.1 累加出现 1.2000000000000002 之类误差
  return Math.round(clamped * 100) / 100;
}

/**
 * 计算「适应宽度 / 适应页面」的 scale。
 *
 * @param page 页面在 scale=1 下的基准尺寸
 * @param container 可用容器尺寸（已扣除内边距）
 * @param mode 'width'=适应宽度（仅按宽）、'page'=适应页面（宽高取小）
 * @returns 钳制到 [PDF_ZOOM_MIN, PDF_ZOOM_MAX] 的 scale；输入非法时回退 1
 */
export function fitScale(page: Size, container: Size, mode: 'width' | 'page'): number {
  if (!(page.width > 0) || !(page.height > 0) || !(container.width > 0)) return 1;
  const byWidth = container.width / page.width;
  if (mode === 'width') return clampPdfZoom(byWidth);
  if (!(container.height > 0)) return clampPdfZoom(byWidth);
  const byHeight = container.height / page.height;
  return clampPdfZoom(Math.min(byWidth, byHeight));
}

/**
 * 解析「跳转到第 x 页」的输入。
 * 仅接受正整数；非整数 / 非正数 / 空串返回 null；超出总页数时钳制到末页。
 *
 * @param input 用户在页码框输入的内容
 * @param pageCount 文档总页数
 */
export function parsePageInput(input: string, pageCount: number): number | null {
  if (pageCount <= 0) return null;
  const text = input.trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, pageCount);
}

/**
 * 统计文本中 query 出现的次数（大小写不敏感、不重叠）。
 * query 为空（或纯空白）返回 0。
 */
export function countMatches(text: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/**
 * 为一次命中生成上下文摘要（居中截取，两端按需加省略号，折叠空白）。
 *
 * @param text 命中所在页的完整文本
 * @param index 命中起始下标
 * @param queryLen 命中的关键词长度
 * @param radius 命中两侧各保留的字符数
 */
export function makeSnippet(text: string, index: number, queryLen: number, radius = 24): string {
  const safeIndex = Math.max(0, Math.min(index, text.length));
  const start = Math.max(0, safeIndex - radius);
  const end = Math.min(text.length, safeIndex + Math.max(0, queryLen) + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${prefix}${body}${suffix}`;
}

/**
 * 连续模式下判定「当前可见页」：给出各页顶部相对容器顶部的偏移量，
 * 返回距离容器顶部最近的那一页（1 基）。
 *
 * @param pageTops 各页 wrapper 顶部相对容器顶部的偏移（与页序一致）
 * @param containerTop 容器顶部参考值（通常为 0）
 */
export function resolveVisiblePage(pageTops: number[], containerTop = 0): number {
  if (pageTops.length === 0) return 1;
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  pageTops.forEach((top, i) => {
    const dist = Math.abs(top - containerTop);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best + 1;
}

/** 连续模式是否需要页数告警（页数过大时提示内存占用）。 */
export function shouldWarnContinuous(pageCount: number): boolean {
  return pageCount > PDF_CONTINUOUS_WARN_PAGES;
}
