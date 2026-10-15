/**
 * printHtml —— 「导出 PDF」打印 HTML 包装（纯函数，无 DOM 依赖）。
 *
 * 职责：把各模块（Writer/Sheet/Slide）生成的「正文 HTML」包装为一份完整、可打印的
 * HTML 文档（含 `@page` 纸张尺寸/页边距、`<meta charset="utf-8">`、打印友好排版 CSS）。
 * 渲染层各模块只负责产出 body 片段 + 模块自定义 CSS，纸张与基础排版在此统一收敛。
 *
 * 与 `src/shared/pdfPrint.ts` 共用同一份纸张规格（PAGE_SIZE_MM / resolvePageSizeMm），
 * 保证 `@page` 尺寸与主进程 `printToPDF(pageSize)` 完全一致（铁律 1.1 单一事实源）。
 */
import {
  normalizeMarginMm,
  resolvePageSizeMm,
  type PrintPageSizeName,
} from '../../../shared/pdfPrint';

/**
 * HTML 文本节点转义（& < > " '）。
 * 新打印管线统一用它（不要改 writer/jkToHtml 内的私有实现）。
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 打印文档基础 CSS（`@page` 纸张尺寸/页边距 + 打印友好排版）。
 *
 * 说明：
 *  - 末行的 `@page` 为**默认值**（A4 纵向 / 15mm）；`buildPrintDocument` 会按实际
 *    纸张再追加一条 `@page`（位于本基础 CSS 之后），同优先级下后者生效，从而覆盖默认。
 *  - `thead{display:table-header-group}` 让长表格跨页时表头重复。
 *  - `.jk-page-break` 供 Sheet 多工作表 / Slide 多页分隔使用。
 *  - 中文字体依赖**本机系统字体**（Chromium 打印管线自动嵌入所用字体），此处仅给出
 *    常见中文字体栈作为回退。
 */
export const PRINT_BASE_CSS = `@page { size: 210mm 297mm; margin: 15mm; }
html,body{margin:0;padding:0;background:#fff;color:#000;}
body{font-family:"宋体",SimSun,"Microsoft YaHei",serif;font-size:10.5pt;line-height:1.5;}
img{max-width:100%;}
table{border-collapse:collapse;}
thead{display:table-header-group;}
tr,img{page-break-inside:avoid;}
h1,h2,h3,h4,h5,h6{page-break-after:avoid;}
.jk-page-break{page-break-after:always;}
.jk-sheet-title{font-size:12pt;font-weight:bold;margin:0 0 6px 0;page-break-after:avoid;}
`;

/** 打印文档封装参数 */
export interface PrintDocumentOptions {
  /** 进 `<title>` */
  title: string;
  bodyHtml: string;
  /** 纸张规格，缺省 'A4' */
  pageSize?: PrintPageSizeName;
  /** 是否横向，缺省 false */
  landscape?: boolean;
  /** 页边距（毫米），缺省 15 */
  marginMm?: number;
  /** 模块自定义 CSS，追加在基础 CSS（及纸张 @page）之后 */
  extraCss?: string;
}

/** 毫米数值 → CSS 数字字符串（整数不带小数位，小数最多两位） */
function cssMm(mm: number): string {
  return String(Math.round(mm * 100) / 100);
}

/** 包装为完整可打印 HTML（含 `<meta charset="utf-8">`） */
export function buildPrintDocument(opts: PrintDocumentOptions): string {
  const pageSize: PrintPageSizeName = opts.pageSize ?? 'A4';
  const landscape = opts.landscape ?? false;
  const marginMm = normalizeMarginMm(opts.marginMm);
  const { widthMm, heightMm } = resolvePageSizeMm(pageSize, landscape);

  // 实际纸张 @page：覆盖基础 CSS 里的默认；再追加模块自定义 CSS。
  const pageCss = `@page { size: ${cssMm(widthMm)}mm ${cssMm(heightMm)}mm; margin: ${cssMm(marginMm)}mm; }`;
  const extra = opts.extraCss ? `\n${opts.extraCss}` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<style>
${PRINT_BASE_CSS}${pageCss}${extra}
</style>
</head>
<body>
${opts.bodyHtml}
</body>
</html>`;
}
