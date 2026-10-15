/**
 * presentationToHtml —— JkPresentation → 逐页打印 HTML 片段（纯函数）。
 *
 * 用于「导出 PDF」打印管线：每一页幻灯片渲染为 `<section class="jk-slide">`，
 * 形状以绝对定位（EMU → mm）摆放；页间强制分页（最后一页除外）。
 *
 * 约束：
 *  - 纯函数，不依赖 DOM/Blob；图片字节由调用方预先转成 data URL，经 `mediaMap`
 *    （键 `${slideIndex}:${relId}`）传入。
 *  - 形状定位/`.jk-slide` 底等额外 CSS 由本模块导出常量 `SLIDE_PRINT_CSS`，
 *    调用方作为 `buildPrintDocument` 的 `extraCss` 传入。
 *  - 全部文本经 escapeHtml。
 */
import {
  escapeHtml,
} from '../lib/printHtml';
import type {
  JkAutoShape,
  JkImageShape,
  JkPresentation,
  JkShape,
  JkTableShape,
  JkTextShape,
  TextParagraph,
  TextRun,
} from '@jareking/presentation';

/** 1 英寸的 EMU 数（OOXML 约定） */
const EMU_PER_INCH = 914400;
/** 1 英寸的毫米数 */
const MM_PER_INCH = 25.4;

/** EMU → 毫米 */
function emuToMm(emu: number): number {
  return (emu / EMU_PER_INCH) * MM_PER_INCH;
}

/** 毫米数值 → CSS 字符串（四舍五入到两位小数，去掉多余尾零） */
function fmtMm(mm: number): string {
  return String(Math.round(mm * 100) / 100);
}

/** 形状公共定位样式（绝对定位 + 旋转） */
function positionStyle(shape: JkShape): string {
  const parts = [
    `left:${fmtMm(emuToMm(shape.x))}mm`,
    `top:${fmtMm(emuToMm(shape.y))}mm`,
    `width:${fmtMm(emuToMm(shape.w))}mm`,
    `height:${fmtMm(emuToMm(shape.h))}mm`,
  ];
  if (shape.rotation) parts.push(`transform:rotate(${shape.rotation}deg)`);
  return parts.join(';');
}

/** 单个 run → HTML（bold/italic/underline/字号/颜色/字体映射） */
function renderRun(run: TextRun): string {
  let html = escapeHtml(run.text);
  const styles: string[] = [];
  if (typeof run.fontSize === 'number') styles.push(`font-size:${run.fontSize}pt`);
  if (run.color) styles.push(`color:${run.color}`);
  if (run.fontFamily) styles.push(`font-family:${run.fontFamily}`);
  if (styles.length) html = `<span style="${styles.join(';')}">${html}</span>`;
  if (run.underline) html = `<u>${html}</u>`;
  if (run.italic) html = `<em>${html}</em>`;
  if (run.bold) html = `<strong>${html}</strong>`;
  return html;
}

/** 段落 → HTML（对齐 / 大纲缩进 / 项目符号） */
function renderParagraph(p: TextParagraph): string {
  const styles: string[] = [];
  if (p.align) styles.push(`text-align:${p.align}`);
  if (p.level && p.level > 0) styles.push(`padding-left:${p.level * 1.5}em`);
  const bullet = p.bullet ? '<span class="jk-bullet">\u2022 </span>' : '';
  const runs = (p.runs ?? []).map(renderRun).join('');
  return `<p style="${styles.join(';')}">${bullet}${runs}</p>`;
}

/** 段落数组 → HTML */
function renderParagraphs(paragraphs?: TextParagraph[]): string {
  return (paragraphs ?? []).map(renderParagraph).join('');
}

/** 若形状带超链接，则把内容包一层 `<a>` */
function wrapHyperlink(inner: string, shape: JkShape): string {
  if (!shape.hyperlink) return inner;
  return `<a href="${escapeHtml(shape.hyperlink)}" target="_blank" rel="noreferrer" style="text-decoration:none;color:inherit;">${inner}</a>`;
}

/** 文本形状 */
function renderTextShape(shape: JkTextShape): string {
  const inner = wrapHyperlink(renderParagraphs(shape.paragraphs), shape);
  return `<div class="jk-shape jk-shape-text" style="${positionStyle(shape)}">${inner}</div>`;
}

/** 预设几何形状（rect / roundRect / ellipse；其余按 rect 兜底） */
function renderAutoShape(shape: JkAutoShape): string {
  const styleParts = [positionStyle(shape)];
  if (shape.fill) styleParts.push(`background-color:${shape.fill}`);
  if (shape.geom === 'ellipse') styleParts.push('border-radius:50%');
  else if (shape.geom === 'roundRect') styleParts.push('border-radius:8px');
  const inner = wrapHyperlink(renderParagraphs(shape.paragraphs), shape);
  return `<div class="jk-shape jk-shape-auto" style="${styleParts.join(';')}">${inner}</div>`;
}

/**
 * 图片形状。
 * 取不到字节（mediaMap 无对应项）时渲染虚线占位框 + `[图片]`，**不抛错**。
 */
function renderImageShape(
  shape: JkImageShape,
  slideIndex: number,
  mediaMap?: Map<string, string>,
): string {
  const src = mediaMap?.get(`${slideIndex}:${shape.relId}`);
  if (src) {
    const inner = `<img src="${escapeHtml(src)}" style="width:100%;height:100%;object-fit:contain;" alt="">`;
    return `<div class="jk-shape jk-shape-image" style="${positionStyle(shape)}">${wrapHyperlink(inner, shape)}</div>`;
  }
  const inner = '<div class="jk-image-missing" style="width:100%;height:100%;">[图片]</div>';
  return `<div class="jk-shape jk-shape-image" style="${positionStyle(shape)}">${wrapHyperlink(inner, shape)}</div>`;
}

/** 表格单元格 */
function renderTableCell(cell: {
  text: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
}): string {
  const styles = ['border:1px solid #9CA3AF'];
  if (typeof cell.fontSize === 'number') styles.push(`font-size:${cell.fontSize}pt`);
  if (cell.color) styles.push(`color:${cell.color}`);
  if (cell.bold) styles.push('font-weight:bold');
  if (cell.align) styles.push(`text-align:${cell.align}`);
  const text = escapeHtml(cell.text ?? '').replace(/\r?\n/g, '<br>');
  return `<td style="${styles.join(';')}">${text}</td>`;
}

/** 表格形状（按 colWidths 与 rows/cells 渲染） */
function renderTableShape(shape: JkTableShape): string {
  const colgroup = `<colgroup>${shape.colWidths
    .map((w) => `<col style="width:${fmtMm(emuToMm(w))}mm">`)
    .join('')}</colgroup>`;
  const body = (shape.rows ?? [])
    .map((row) => `<tr>${(row.cells ?? []).map(renderTableCell).join('')}</tr>`)
    .join('');
  const inner = `<table style="width:100%;height:100%;table-layout:fixed;border-collapse:collapse;">${colgroup}<tbody>${body}</tbody></table>`;
  return `<div class="jk-shape jk-shape-table" style="${positionStyle(shape)}">${wrapHyperlink(inner, shape)}</div>`;
}

/** 单个形状 → HTML（按 type 分派） */
function renderShape(
  shape: JkShape,
  slideIndex: number,
  mediaMap?: Map<string, string>,
): string {
  switch (shape.type) {
    case 'text':
      return renderTextShape(shape);
    case 'shape':
      return renderAutoShape(shape);
    case 'image':
      return renderImageShape(shape, slideIndex, mediaMap);
    case 'table':
      return renderTableShape(shape);
    default:
      return '';
  }
}

/**
 * 页面附加 CSS（形状定位 / `.jk-slide` 底 / 图片占位）。
 * 调用方作为 `buildPrintDocument({ extraCss: SLIDE_PRINT_CSS })` 传入。
 */
export const SLIDE_PRINT_CSS = `*{box-sizing:border-box;}
.jk-slide{position:relative;overflow:hidden;background:#fff;}
.jk-shape{position:absolute;overflow:hidden;}
.jk-shape-text p,.jk-shape-auto p{margin:0 0 0.2em 0;}
.jk-shape-auto{display:flex;flex-direction:column;align-items:center;justify-content:center;}
.jk-shape-table td{padding:2px 4px;vertical-align:middle;}
.jk-image-missing{display:flex;align-items:center;justify-content:center;color:#888;font-size:12pt;background:#f5f5f5;border:1px dashed #9CA3AF;}`;

/**
 * JkPresentation → 打印用正文 HTML（逐页 `<section class="jk-slide">`）。
 *
 * @param pres     演示文稿
 * @param mediaMap 键 `${slideIndex}:${relId}` → 图片 data URL（可选）
 */
export function presentationToPrintBody(
  pres: JkPresentation,
  mediaMap?: Map<string, string>,
): string {
  const widthMm = fmtMm(emuToMm(pres.slideWidth));
  const heightMm = fmtMm(emuToMm(pres.slideHeight));
  const slides = pres.slides ?? [];

  return slides
    .map((slide, si) => {
      const shapes = (slide.shapes ?? [])
        .map((shape) => renderShape(shape, si, mediaMap))
        .join('');
      // 最后一页不分页
      const breakStyle = si < slides.length - 1 ? 'page-break-after:always;' : '';
      return `<section class="jk-slide" style="width:${widthMm}mm;height:${heightMm}mm;${breakStyle}">${shapes}</section>`;
    })
    .join('\n');
}
