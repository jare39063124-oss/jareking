/**
 * sheetToHtml —— JkWorkbook → 打印用 HTML 表格片段（纯函数）。
 *
 * 用于「导出 PDF」打印管线：把整个工作簿（或仅活动表）渲染为若干 `<table>`，
 * 多表之间插入分页符 `.jk-page-break`，交给 `buildPrintDocument` 包装。
 *
 * 设计要点：
 *  - 列号换算复用 `@jareking/sheet` 的 `colToLetters`/`toA1`（铁律：不另起一套）。
 *  - 尺寸：列宽 `sheet.colWidths[c]`（px，缺省 64）、行高 `sheet.rowHeights[r]`（px，缺省 20）；
 *    px → mm 采用 96dpi 假设（见 pxToMm）。
 *  - 合并单元格：来自 `sheet.merges`（0 基闭区间）→ colspan/rowspan，被覆盖的格跳过。
 *  - 尾部全空行/列裁剪：只渲染到「最后一个有值的行列」，避免空白工作表打印出天文数字页。
 *  - 全部文本经 escapeHtml。
 */
import { toA1 } from '@jareking/sheet';
import type { JkCell, JkCellStyle, JkMerge, JkSheet, JkWorkbook } from '@jareking/sheet';
import { escapeHtml } from '../lib/printHtml';

/** 默认列宽（px）——未在 colWidths 中指定时使用 */
const DEFAULT_COL_WIDTH_PX = 64;
/** 默认行高（px）——未在 rowHeights 中指定时使用 */
const DEFAULT_ROW_HEIGHT_PX = 20;

/**
 * px → mm 字符串（保留两位小数）。
 * 假设 96dpi（CSS 标准 1in = 96px，同时 1in = 25.4mm）→ mm = px * 25.4 / 96。
 */
function pxToMm(px: number): string {
  return ((px * 25.4) / 96).toFixed(2);
}

/** 数字 → 纯十进制字符串（避免 1e21 / 1e-7 之类的科学计数法） */
function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  // 科学计数法：用 toLocaleString 展开为纯十进制（不使用千分位）
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

/**
 * 从数字格式代码里解析「小数位数」：取第一个 `.` 之后的连续数字位数。
 * 例："0.00" → 2；"¥#,##0.00" → 2；"0.0%" → 1；无小数 → 0。
 */
function decimalsOf(numFmt: string): number {
  const m = /\.(\d+)/.exec(numFmt);
  return m ? m[1].length : 0;
}

/**
 * 保守应用数字格式（numFmt）：
 *  - 含 `%` → 百分比，`(v*100).toFixed(位数)%`；
 *  - 含 `E`/`e`（科学计数）→ 不处理，交由 numberToPlainString 展开；
 *  - 日期/时间格式（含 y/m/d/h/s 且无 0/#）→ **不做日期换算**，原样返回 null，
 *    避免把「序列号/既有文本」误改成另一种日期（保守优先，宁可少格式化）。
 *  - 含小数位（如 0.00）→ 按位 toFixed。
 *
 * 返回 null 表示「不改变原值，按纯文本输出」。
 */
function applyNumFmt(value: number, numFmt?: string): string | null {
  if (!numFmt) return null;
  if (numFmt.includes('%')) {
    return `${(value * 100).toFixed(decimalsOf(numFmt))}%`;
  }
  if (/[eE]/.test(numFmt)) return null;
  // 日期/时间格式：不含 0/# 视为日期或时间格式，不做换算
  if (!/[0#]/.test(numFmt)) return null;
  const decimals = decimalsOf(numFmt);
  if (decimals > 0) return value.toFixed(decimals);
  return null;
}

/** 单元格值 → 展示文本（公式有缓存值时优先 value；空值视为空串） */
function cellText(cell: JkCell | undefined): string {
  if (!cell) return '';
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    const fmt = applyNumFmt(v, cell.style?.numFmt);
    return fmt !== null ? fmt : numberToPlainString(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** JkCellStyle → CSS 片段（样式映射；无样式返回空串） */
function cellStyleCss(style?: JkCellStyle): string {
  if (!style) return '';
  const parts: string[] = [];
  if (style.bold) parts.push('font-weight:bold');
  if (style.italic) parts.push('font-style:italic');

  const deco: string[] = [];
  if (style.underline) deco.push('underline');
  if (style.strike) deco.push('line-through');
  if (deco.length) parts.push(`text-decoration:${deco.join(' ')}`);

  if (style.color) parts.push(`color:${style.color}`);
  if (style.bgColor) parts.push(`background-color:${style.bgColor}`);
  if (typeof style.fontSize === 'number') parts.push(`font-size:${style.fontSize}pt`);
  if (style.fontFamily) parts.push(`font-family:${style.fontFamily}`);
  if (style.align && style.align !== 'general') parts.push(`text-align:${style.align}`);
  if (style.valign) parts.push(`vertical-align:${style.valign}`);
  if (style.wrapText) parts.push('white-space:pre-wrap');

  const b = style.borders;
  if (b) {
    if (b.top) parts.push('border-top:1px solid #000');
    if (b.right) parts.push('border-right:1px solid #000');
    if (b.bottom) parts.push('border-bottom:1px solid #000');
    if (b.left) parts.push('border-left:1px solid #000');
  }
  return parts.join(';');
}

/** 单元格是否有可展示内容（有值或有公式） */
function hasValue(cell: JkCell | undefined): boolean {
  if (!cell) return false;
  if (cell.formula) return true;
  const v = cell.value;
  if (v === null || v === undefined) return false;
  return String(v).length > 0;
}

/** 单个工作表的 `<table>`（含列宽/行高/合并/样式） */
function sheetToTable(sheet: JkSheet): string {
  const cells = sheet.cells ?? {};

  // 有效行列范围：数据最大值 与 合并区域右下角 的较大者（尾部全空行/列不渲染）
  let maxRow = -1;
  let maxCol = -1;
  for (const [key, cell] of Object.entries(cells)) {
    if (!hasValue(cell)) continue;
    const comma = key.indexOf(',');
    if (comma < 0) continue;
    const r = Number(key.slice(0, comma));
    const c = Number(key.slice(comma + 1));
    if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  }
  const merges: JkMerge[] = sheet.merges ?? [];
  for (const m of merges) {
    if (m.endRow > maxRow) maxRow = m.endRow;
    if (m.endCol > maxCol) maxCol = m.endCol;
  }

  const rows = maxRow + 1;
  const cols = maxCol + 1;

  // 合并锚点表 & 被覆盖格集合（被覆盖的格跳过渲染）
  const anchor = new Map<string, JkMerge>();
  const covered = new Set<string>();
  for (const m of merges) {
    anchor.set(`${m.startRow},${m.startCol}`, m);
    for (let r = m.startRow; r <= m.endRow; r++) {
      for (let c = m.startCol; c <= m.endCol; c++) {
        if (r === m.startRow && c === m.startCol) continue;
        covered.add(`${r},${c}`);
      }
    }
  }

  const colWidths = sheet.colWidths ?? {};
  const rowHeights = sheet.rowHeights ?? {};

  let colgroup = '<colgroup>';
  for (let c = 0; c < cols; c++) {
    const w = colWidths[c] ?? DEFAULT_COL_WIDTH_PX;
    colgroup += `<col style="width:${pxToMm(w)}mm">`;
  }
  colgroup += '</colgroup>';

  let body = '';
  for (let r = 0; r < rows; r++) {
    const h = rowHeights[r] ?? DEFAULT_ROW_HEIGHT_PX;
    let rowHtml = '';
    for (let c = 0; c < cols; c++) {
      const key = `${r},${c}`;
      if (covered.has(key)) continue;
      const merge = anchor.get(key);
      const cell = cells[key];

      const spanAttrs = merge
        ? ` colspan="${merge.endCol - merge.startCol + 1}" rowspan="${merge.endRow - merge.startRow + 1}"`
        : '';
      const styleCss = cellStyleCss(cell?.style);
      const styleAttr = styleCss ? ` style="${styleCss}"` : '';
      // toA1 提供单元格地址（复用既有列号换算，便于定位/调试）
      rowHtml += `<td data-cell="${toA1(r, c)}"${spanAttrs}${styleAttr}>${escapeHtml(cellText(cell))}</td>`;
    }
    body += `<tr style="height:${pxToMm(h)}mm">${rowHtml}</tr>`;
  }

  return `<table>${colgroup}<tbody>${body}</tbody></table>`;
}

/**
 * JkWorkbook → 打印用正文 HTML。
 *
 * 每个工作表一节：`<h2 class="jk-sheet-title">表名</h2>` + 表格；表与表之间插入
 * `<div class="jk-page-break"></div>` 分页符。
 *
 * @param wb   工作簿
 * @param opts activeOnly=true 时仅渲染活动工作表（缺省渲染全部）
 */
export function workbookToPrintBody(wb: JkWorkbook, opts?: { activeOnly?: boolean }): string {
  const all: JkSheet[] = wb.sheets ?? [];
  const sheets = opts?.activeOnly
    ? [all[wb.activeSheetIndex ?? 0]].filter((s): s is JkSheet => !!s)
    : all;

  // 每个工作表一节（标题 + 表格），仅**表与表之间**插入分页符
  const sections = sheets.map(
    (sheet) => `<h2 class="jk-sheet-title">${escapeHtml(sheet.name ?? '')}</h2>\n${sheetToTable(sheet)}`,
  );
  return sections.join('\n<div class="jk-page-break"></div>\n');
}
