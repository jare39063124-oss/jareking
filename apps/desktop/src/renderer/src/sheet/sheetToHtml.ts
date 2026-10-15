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
import type { PrintRange, RowRange } from './printSettings';

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

/** 单表渲染的可选打印布局（仅活动表传入；缺省 = 整表，输出与历史版本逐字节一致） */
interface SheetTableLayout {
  /** 打印区域（0 基闭区间）；null / 缺省 = 整表 */
  printArea?: PrintRange | null;
  /** 重复标题行（0 基闭区间）；null / 缺省 = 不重复 */
  repeatRows?: RowRange | null;
}

/**
 * 单个工作表的 `<table>`（含列宽/行高/合并/样式）。
 *
 * @param layout 打印布局（仅活动表传入）。缺省时输出与历史版本**完全一致**（零回归）。
 *  - 打印区域：只渲染区域内的行列；列宽/行高仍取原绝对索引（sheet.colWidths[c] / rowHeights[r]）。
 *  - 合并单元格：与区域相交则裁剪到区域内；锚点落在区域外则整块跳过（绝不输出越界 colspan）。
 *  - 重复标题行：渲染为 `<thead>`（基础 CSS thead{display:table-header-group} → 跨页重复）。
 */
function sheetToTable(sheet: JkSheet, layout?: SheetTableLayout): string {
  const cells = sheet.cells ?? {};

  // 有效行列范围：数据最大值 与 合并区域右下角 的较大者（尾部全空行/列不渲染）
  let dataMaxRow = -1;
  let dataMaxCol = -1;
  for (const [key, cell] of Object.entries(cells)) {
    if (!hasValue(cell)) continue;
    const comma = key.indexOf(',');
    if (comma < 0) continue;
    const r = Number(key.slice(0, comma));
    const c = Number(key.slice(comma + 1));
    if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
    if (r > dataMaxRow) dataMaxRow = r;
    if (c > dataMaxCol) dataMaxCol = c;
  }
  const merges: JkMerge[] = sheet.merges ?? [];
  for (const m of merges) {
    if (m.endRow > dataMaxRow) dataMaxRow = m.endRow;
    if (m.endCol > dataMaxCol) dataMaxCol = m.endCol;
  }

  // 渲染行列范围：整表 = [0, dataMax]；有打印区域则与区域取交集（只渲染区域内的行列）
  let rowStart = 0;
  let colStart = 0;
  let rowEnd = dataMaxRow;
  let colEnd = dataMaxCol;
  const area = layout?.printArea;
  if (area) {
    rowStart = Math.max(0, area.startRow);
    colStart = Math.max(0, area.startCol);
    rowEnd = Math.min(dataMaxRow, area.endRow);
    colEnd = Math.min(dataMaxCol, area.endCol);
  }

  // 重复标题行：与渲染行范围取交集（超界静默收敛；空交集视为不重复）
  let theadRange: RowRange | null = null;
  const repeat = layout?.repeatRows;
  if (repeat) {
    const s = Math.max(repeat.startRow, rowStart);
    const e = Math.min(repeat.endRow, rowEnd);
    if (s <= e) theadRange = { startRow: s, endRow: e };
  }

  // 合并锚点表 & 被覆盖格集合（被覆盖的格跳过渲染）
  const anchor = new Map<string, JkMerge>();
  const covered = new Set<string>();
  for (const m of merges) {
    // 锚点必须落在渲染区域内，否则整块合并跳过（避免越界 colspan 导致错列）
    if (m.startRow < rowStart || m.startRow > rowEnd) continue;
    if (m.startCol < colStart || m.startCol > colEnd) continue;
    // 行方向跨段裁剪：不得跨出所在表段（thead / tbody），避免表格结构错乱
    let sectionMaxRow = rowEnd;
    if (theadRange) {
      if (m.startRow >= theadRange.startRow && m.startRow <= theadRange.endRow) {
        sectionMaxRow = theadRange.endRow; // 表头段：不跨入正文
      } else if (m.startRow < theadRange.startRow) {
        sectionMaxRow = theadRange.startRow - 1; // 表头之前的正文段
      }
    }
    // 裁剪到区域内（clamp 后仍输出正确的 colspan/rowspan）
    const endRow = Math.min(m.endRow, rowEnd, sectionMaxRow);
    const endCol = Math.min(m.endCol, colEnd);
    if (endRow < m.startRow || endCol < m.startCol) continue; // 收敛为空（理论不可达，兜底）
    const norm: JkMerge = { startRow: m.startRow, startCol: m.startCol, endRow, endCol };
    anchor.set(`${m.startRow},${m.startCol}`, norm);
    for (let r = m.startRow; r <= endRow; r++) {
      for (let c = m.startCol; c <= endCol; c++) {
        if (r === m.startRow && c === m.startCol) continue;
        covered.add(`${r},${c}`);
      }
    }
  }

  const colWidths = sheet.colWidths ?? {};
  const rowHeights = sheet.rowHeights ?? {};

  let colgroup = '<colgroup>';
  for (let c = colStart; c <= colEnd; c++) {
    const w = colWidths[c] ?? DEFAULT_COL_WIDTH_PX;
    colgroup += `<col style="width:${pxToMm(w)}mm">`;
  }
  colgroup += '</colgroup>';

  /** 渲染第 r 行为 `<tr>…</tr>`（列范围 [colStart, colEnd]，被覆盖格跳过） */
  const renderRow = (r: number): string => {
    const h = rowHeights[r] ?? DEFAULT_ROW_HEIGHT_PX;
    let rowHtml = '';
    for (let c = colStart; c <= colEnd; c++) {
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
    return `<tr style="height:${pxToMm(h)}mm">${rowHtml}</tr>`;
  };

  // 重复行 → <thead>；其余 → <tbody>（无重复行时全部进 tbody，结构与历史一致）
  let theadHtml = '';
  let tbodyHtml = '';
  for (let r = rowStart; r <= rowEnd; r++) {
    if (theadRange && r >= theadRange.startRow && r <= theadRange.endRow) {
      theadHtml += renderRow(r);
    } else {
      tbodyHtml += renderRow(r);
    }
  }

  if (theadRange) {
    return `<table>${colgroup}<thead>${theadHtml}</thead><tbody>${tbodyHtml}</tbody></table>`;
  }
  return `<table>${colgroup}<tbody>${tbodyHtml}</tbody></table>`;
}

/** `workbookToPrintBody` 的可选打印行为（缺省时输出与历史版本完全一致） */
export interface WorkbookPrintOptions {
  /** 仅渲染活动工作表（缺省渲染全部） */
  activeOnly?: boolean;
  /** 打印区域：**仅作用于活动工作表**，其余工作表仍整表输出 */
  printArea?: PrintRange | null;
  /** 重复标题行：**仅作用于活动工作表**，渲染为 <thead>（跨页重复） */
  repeatRows?: RowRange | null;
}

/**
 * JkWorkbook → 打印用正文 HTML。
 *
 * 每个工作表一节：`<h2 class="jk-sheet-title">表名</h2>` + 表格；表与表之间插入
 * `<div class="jk-page-break"></div>` 分页符。
 *
 * @param wb   工作簿
 * @param opts 可选打印行为：
 *  - `activeOnly`：仅渲染活动工作表；
 *  - `printArea` / `repeatRows`：**仅作用于活动工作表**（其余工作表整表输出）。
 *  不传 opts（或全空）时输出与历史版本完全一致（零回归）。
 */
export function workbookToPrintBody(wb: JkWorkbook, opts?: WorkbookPrintOptions): string {
  const all: JkSheet[] = wb.sheets ?? [];
  const activeIndex = wb.activeSheetIndex ?? 0;
  // 是否对活动表应用「打印区域 / 重复标题行」（其余表不生效）
  const applyLayout = !!(opts?.printArea || opts?.repeatRows);

  // 需渲染的工作表下标：activeOnly → 仅活动表；否则全部（保持原顺序）
  const indices = (opts?.activeOnly ? [activeIndex] : all.map((_, i) => i)).filter(
    (i) => i >= 0 && i < all.length,
  );

  const sections = indices.map((i) => {
    const sheet = all[i];
    const table =
      applyLayout && i === activeIndex
        ? sheetToTable(sheet, {
            printArea: opts?.printArea ?? null,
            repeatRows: opts?.repeatRows ?? null,
          })
        : sheetToTable(sheet);
    return `<h2 class="jk-sheet-title">${escapeHtml(sheet.name ?? '')}</h2>\n${table}`;
  });
  return sections.join('\n<div class="jk-page-break"></div>\n');
}
