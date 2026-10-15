/**
 * pdfPrint —— 「导出 PDF」打印管线共用的纸张规格与 printToPDF 选项组装（纯函数）。
 *
 * 放置于 `src/shared` 的原因：主进程（构建 printToPDF 选项）与渲染进程（生成 @page CSS）
 * 两侧都要用，且必须共用同一份纸张规格「单一事实源」（铁律 1.1，禁止各写一份）。
 * 本文件**不依赖 electron / DOM**，可被单测直接引用（`src/shared/**\/*.test.ts` 已被 vitest 收录）。
 *
 * 数据流：编辑器 → 纯函数生成打印 HTML → 渲染层 invoke IPC(pdf:export-html)
 *   → 主进程写临时 .html + 隐藏 BrowserWindow.loadFile + webContents.printToPDF
 *   → 返回 PDF 字节 → 渲染层 downloadBlob(bytes,'导出.pdf','application/pdf')。
 */

/** 支持的纸张规格名（与 WPS「页面布局 → 纸张大小」常用项对齐） */
export type PrintPageSizeName = 'A4' | 'A3' | 'B5' | 'Letter' | 'Legal';

/**
 * 纸张规格（毫米，纵向）；**单一事实源**——渲染层 `@page` 与主进程 printToPDF 都从这里取。
 * 数值取自 ISO 216（A 系列 / B5）与美制标准（Letter / Legal）。
 */
export const PAGE_SIZE_MM: Record<PrintPageSizeName, { widthMm: number; heightMm: number }> = {
  A4: { widthMm: 210, heightMm: 297 },
  A3: { widthMm: 297, heightMm: 420 },
  B5: { widthMm: 182, heightMm: 257 },
  Letter: { widthMm: 215.9, heightMm: 279.4 },
  Legal: { widthMm: 215.9, heightMm: 355.6 },
};

/** 默认页边距（毫米）——非法/缺省时的回落值 */
export const DEFAULT_MARGIN_MM = 15;

/** 页边距允许区间（毫米）：过小会裁切内容，过大则正文区过窄 */
const MIN_MARGIN_MM = 0;
const MAX_MARGIN_MM = 50;

/**
 * 规整页边距（毫米）：非有限数或负数 → 回落默认 15；再钳制到 [0, 50]。
 * 主/渲染两侧共用，避免各写一份默认值/clamp 逻辑（铁律 1.1）。
 */
export function normalizeMarginMm(marginMm?: number): number {
  if (typeof marginMm !== 'number' || !Number.isFinite(marginMm) || marginMm < 0) {
    return DEFAULT_MARGIN_MM;
  }
  return Math.min(MAX_MARGIN_MM, Math.max(MIN_MARGIN_MM, marginMm));
}

/** 按横向/纵向换算实际页面尺寸（横向 = 宽高互换，毫米） */
export function resolvePageSizeMm(
  name: PrintPageSizeName,
  landscape: boolean,
): { widthMm: number; heightMm: number } {
  const spec = PAGE_SIZE_MM[name] ?? PAGE_SIZE_MM.A4;
  return landscape
    ? { widthMm: spec.heightMm, heightMm: spec.widthMm }
    : { widthMm: spec.widthMm, heightMm: spec.heightMm };
}

/**
 * 毫米 → 微米（四舍五入取整）。
 *
 * 注意：`printToPDF` 的 `pageSize` 对象单位是**英寸**（见下方 buildPrintToPdfOptions），
 * 并非微米；本函数仅作通用单位工具保留（含单测），**不再用于打印选项组装**。
 */
export function mmToMicrons(mm: number): number {
  return Math.round(mm * 1000);
}

/** 毫米 → 英寸（printToPDF 的 pageSize / margins 单位均为英寸） */
export function mmToInches(mm: number): number {
  return mm / 25.4;
}

/** 渲染层发来的导出请求（经 IPC 传给主进程） */
export interface HtmlPdfRequest {
  html: string;
  /** 纸张规格，缺省 'A4' */
  pageSize?: PrintPageSizeName;
  /** 是否横向，缺省 false（纵向） */
  landscape?: boolean;
  /** 页边距（毫米），缺省 15 */
  marginMm?: number;
  /** 仅用于主进程日志/调试，不落盘 */
  fileName?: string;
}

/**
 * printToPDF 选项（本地 interface 声明，避免 import electron 类型——
 * 保持本文件对 electron 零依赖，便于渲染层/单测复用）。
 */
export interface PrintToPdfOptionsLike {
  landscape: boolean;
  printBackground: true;
  /** 优先采用 CSS `@page` 尺寸（各模块由 PAGE_SIZE_MM 驱动，含横向互换） */
  preferCSSPageSize: true;
  /** 页面尺寸（**英寸**） */
  pageSize: { width: number; height: number };
  /** 页边距（英寸） */
  margins: { top: number; bottom: number; left: number; right: number };
}

/**
 * 组装 `webContents.printToPDF` 选项（Electron 44）。
 *
 * 单位/朝向依据（代码注释留痕——上一版把 pageSize 判成微米，导致真实 Electron 100% 失败，
 * 已按实测与 d.ts 更正）：
 *  - `pageSize`：d.ts 的 `PrintToPDFOptions`（PrintToPDFOptions 结构体）明确
 *    「an Object containing `height` and `width` **in inches**」→ 用 mmToInches。
 *    （d.ts 里 `webContents.print()` 的「353 microns」是**打印机**接口注释，不适用于 printToPDF。）
 *    实测：`{width:210000,height:297000}`（微米）→ 抛「Failed to generate PDF」；
 *    `{width:8.2677,height:11.6929}`（英寸）→ 正常，MediaBox 595.92×841.92（A4）。
 *  - `margins`：同结构体「in inches」→ 用 mmToInches。
 *  - `preferCSSPageSize: true`：Electron 44 的 `landscape` 选项基本无效（实测 MediaBox
 *    始终被规范成纵向、无 /Rotate）。故改为「CSS 优先」——各模块的 `@page`
 *    （由 buildPrintDocument 依据 PAGE_SIZE_MM + landscape 写入，横向时已互换宽高）
 *    决定最终纸张尺寸与朝向。`landscape` 仍按请求透传（保留接口语义，实际由 CSS 决定）。
 *  - `printBackground` 置 true 以保留底色/底纹；`displayHeaderFooter` 默认 false。
 */
export function buildPrintToPdfOptions(req: HtmlPdfRequest): PrintToPdfOptionsLike {
  const pageSizeName: PrintPageSizeName = req.pageSize ?? 'A4';
  const landscape = req.landscape ?? false;
  const marginMm = normalizeMarginMm(req.marginMm);
  const { widthMm, heightMm } = resolvePageSizeMm(pageSizeName, landscape);
  const marginIn = mmToInches(marginMm);

  return {
    landscape,
    printBackground: true,
    // CSS @page 优先：朝向/尺寸以 buildPrintDocument 写入的 @page 为准（单一事实源 PAGE_SIZE_MM）
    preferCSSPageSize: true,
    pageSize: {
      width: mmToInches(widthMm),
      height: mmToInches(heightMm),
    },
    margins: {
      top: marginIn,
      bottom: marginIn,
      left: marginIn,
      right: marginIn,
    },
  };
}
