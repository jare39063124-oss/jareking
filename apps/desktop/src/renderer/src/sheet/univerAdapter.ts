/**
 * univerAdapter —— JkWorkbook ↔ Univer 工作簿数据互转（T2.2）。
 *
 * Univer v1.0.4 preset 数据形状（IWorkbookData/IWorksheetData）：
 *   sheets: { [sheetId]: { name, rowCount, columnCount,
 *             cellData: { [row]: { [col]: { v?, f?, s? } } },
 *             mergeData: IRange[], columnData: { [col]: { width? } },
 *             rowData: { [row]: { height? } } } }
 *   styles: { [styleId]: IStyleData }   ← 单元格样式表，cellData[r][c].s 引用其 id
 *
 * 坐标同为 0 基，可直接映射。
 *
 * 样式映射（本文件核心职责，T2.2 迭代补齐）：
 *   JkCellStyle ↔ Univer IStyleData 双向互转；打开时把 JkCell.style 登记进
 *   workbook.styles 并让单元格 s 引用，保存时回读 snapshot.styles[s] → JkCell.style，
 *   从而「在 Univer 内编辑/保留的样式」不会在存盘时丢失（修复原「样式暂不映射」的数据损坏）。
 */
import type { JkCell, JkCellStyle, JkMerge, JkSheet, JkWorkbook } from '@jareking/sheet';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 默认网格尺寸（Univer 建议初始即给足，编辑时自动扩展） */
const DEFAULT_ROWS = 100;
const DEFAULT_COLS = 26;

/** #RRGGBB / #RRGGBBAA / rgb(r,g,b) → #RRGGBB（大写，无 alpha）；非法返回 undefined */
function toHex(input: string): string | undefined {
  if (!input) return undefined;
  const s = input.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1).toUpperCase();
    if (/^[0-9A-F]{6}$/.test(h)) return `#${h}`;
    if (/^[0-9A-F]{8}$/.test(h)) return `#${h.slice(0, 6)}`;
    return undefined;
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) {
    const to2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
    return `#${to2(Number(m[1]))}${to2(Number(m[2]))}${to2(Number(m[3]))}`;
  }
  return undefined;
}

/** JkCellStyle → Univer IStyleData（仅写入存在字段） */
function jkStyleToUniver(style: JkCellStyle): Record<string, any> {
  const u: Record<string, any> = {};
  if (style.bold) u.bl = 1; // BooleanNumber.TRUE
  if (style.italic) u.it = 1;
  if (style.underline) u.ul = { s: 1 }; // ITextDecoration：跟随字体色
  if (style.strike) u.st = { s: 1 };
  const cl = toHex(style.color ?? '');
  if (cl) u.cl = { rgb: cl };
  const bg = toHex(style.bgColor ?? '');
  if (bg) u.bg = { rgb: bg };
  if (style.fontSize) u.fs = style.fontSize;
  if (style.fontFamily) u.ff = style.fontFamily;
  if (style.align && style.align !== 'general') u.ht = style.align;
  if (style.valign) u.vt = style.valign;
  if (style.wrapText) u.tb = 'wrap'; // WrapStrategy
  if (style.numFmt) u.n = { pattern: style.numFmt };
  if (style.borders) {
    const thinSide = (present: boolean) =>
      present ? { s: 1, cl: { rgb: '#000000' } } : undefined; // BorderStyleTypes.THIN = 1
    const bd: Record<string, any> = {};
    if (style.borders.top) bd.t = thinSide(true);
    if (style.borders.right) bd.r = thinSide(true);
    if (style.borders.bottom) bd.b = thinSide(true);
    if (style.borders.left) bd.l = thinSide(true);
    if (Object.keys(bd).length) u.bd = bd;
  }
  return u;
}

/** Univer IStyleData → JkCellStyle（仅读取已知字段；s 为 id 或内联对象皆可） */
function univerStyleToJk(s: Record<string, any> | undefined): JkCellStyle | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const out: JkCellStyle = {};
  if (s.bl === 1) out.bold = true;
  if (s.it === 1) out.italic = true;
  if (s.ul && s.ul.s === 1) out.underline = true;
  if (s.st && s.st.s === 1) out.strike = true;
  const fg = toHex(typeof s.cl?.rgb === 'string' ? s.cl.rgb : '');
  if (fg) out.color = fg;
  const bg = toHex(typeof s.bg?.rgb === 'string' ? s.bg.rgb : '');
  if (bg) out.bgColor = bg;
  if (typeof s.fs === 'number') out.fontSize = s.fs;
  if (typeof s.ff === 'string') out.fontFamily = s.ff;
  if (typeof s.ht === 'string') out.align = s.ht as JkCellStyle['align'];
  if (typeof s.vt === 'string') out.valign = s.vt as JkCellStyle['valign'];
  if (s.tb === 'wrap') out.wrapText = true;
  if (s.n && typeof s.n.pattern === 'string') out.numFmt = s.n.pattern;
  const b = s.bd;
  if (b && typeof b === 'object') {
    const borders: NonNullable<JkCellStyle['borders']> = {};
    if (b.t) borders.top = true;
    if (b.r) borders.right = true;
    if (b.b) borders.bottom = true;
    if (b.l) borders.left = true;
    if (Object.values(borders).some(Boolean)) out.borders = borders;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 样式登记器：内容去重，相同样式复用同一 id（避免大表 styles 表爆炸） */
interface StyleRegistry {
  styles: Record<string, any>;
  index: Record<string, string>;
}
function ensureStyleId(reg: StyleRegistry, style: JkCellStyle | undefined): string | undefined {
  if (!style || typeof style !== 'object') return undefined;
  const key = JSON.stringify(style);
  if (reg.index[key]) return reg.index[key];
  const id = `jk-${Object.keys(reg.styles).length}`;
  reg.styles[id] = jkStyleToUniver(style);
  reg.index[key] = id;
  return id;
}

/** JkSheet → Univer IWorksheetData（any 边界，见文件头说明） */
function sheetToUniver(sheet: JkSheet, reg: StyleRegistry): Record<string, any> {
  const cellData: Record<number, Record<number, any>> = {};
  for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
    const [rStr, cStr] = key.split(',');
    const row = Number(rStr);
    const col = Number(cStr);
    if (!Number.isFinite(row) || !Number.isFinite(col)) continue;
    const jk = cell as JkCell;
    const u: Record<string, any> = {};
    if (jk.formula) {
      u.f = jk.formula;
      if (jk.value !== undefined && jk.value !== null) u.v = jk.value;
    } else if (jk.value !== undefined && jk.value !== null) {
      u.v = jk.value;
    }
    const sid = ensureStyleId(reg, jk.style);
    if (sid) u.s = sid;
    if (!Object.keys(u).length) continue;
    cellData[row] = cellData[row] ?? {};
    cellData[row][col] = u;
  }

  const mergeData = (sheet.merges ?? []).map(
    (m: JkMerge): Record<string, number> => ({
      startRow: m.startRow,
      startColumn: m.startCol,
      endRow: m.endRow,
      endColumn: m.endCol,
    }),
  );

  const columnData: Record<number, Record<string, number>> = {};
  for (const [idx, px] of Object.entries(sheet.colWidths ?? {})) {
    columnData[Number(idx)] = { width: px };
  }
  const rowData: Record<number, Record<string, number>> = {};
  for (const [idx, px] of Object.entries(sheet.rowHeights ?? {})) {
    rowData[Number(idx)] = { height: px };
  }

  return {
    name: sheet.name,
    rowCount: Math.max(sheet.rowCount || DEFAULT_ROWS, DEFAULT_ROWS),
    columnCount: Math.max(sheet.colCount || DEFAULT_COLS, DEFAULT_COLS),
    cellData,
    mergeData,
    columnData,
    rowData,
    hidden: sheet.hidden ? 1 : undefined,
  };
}

/** JkWorkbook → Univer createWorkbook 数据 */
export function jkToUniverData(wb: JkWorkbook): Record<string, any> {
  const reg: StyleRegistry = { styles: {}, index: {} };
  const sheets: Record<string, any> = {};
  (wb.sheets ?? []).forEach((s, i) => {
    // 关键：sheet 键必须用 Univer 默认命名（sheet-01…），否则权限点注册与实际
    // sheetId 错位，导致所有写入被权限系统静默拦截（弹「范围已保护」对话框）
    sheets[`sheet-${String(i + 1).padStart(2, '0')}`] = sheetToUniver(s, reg);
  });
  if (!Object.keys(sheets).length) {
    sheets['sheet-01'] = sheetToUniver(
      {
        name: 'Sheet1',
        rowCount: DEFAULT_ROWS,
        colCount: DEFAULT_COLS,
        cells: {},
        merges: [],
      },
      reg,
    );
  }
  // 官方最小形状：id/styles/sheets（locale 由 createUniver 全局配置，不放在工作簿上）
  // styles 现承载单元格样式表（T2.2 补齐）
  return { id: 'jareking-sheet', styles: reg.styles, sheets };
}

/** Univer cellData 矩阵 → 稀疏 JkCell 映射（回读样式） */
function cellDataToJk(
  cellData: Record<string, Record<string, any>> | undefined,
  styles: Record<string, any> | undefined,
): JkSheet['cells'] {
  const cells: JkSheet['cells'] = {};
  for (const [rStr, rowObj] of Object.entries(cellData ?? {})) {
    for (const [cStr, u] of Object.entries(rowObj ?? {})) {
      if (!u || typeof u !== 'object') continue;
      const jk: JkCell = {};
      let has = false;
      if (typeof u.f === 'string' && u.f) {
        jk.formula = u.f.replace(/^=/, '');
        has = true;
      }
      if (u.v !== undefined && u.v !== null) {
        if (typeof u.v === 'string' || typeof u.v === 'number' || typeof u.v === 'boolean') {
          jk.value = u.v;
        } else {
          jk.value = String(u.v);
        }
        has = true;
      }
      // 样式回读：s 可能是 styleId 字符串，也可能是内联 IStyleData 对象
      let uStyle: Record<string, any> | undefined;
      if (typeof u.s === 'string') uStyle = styles?.[u.s];
      else if (u.s && typeof u.s === 'object') uStyle = u.s;
      const jkStyle = univerStyleToJk(uStyle);
      if (jkStyle) {
        jk.style = jkStyle;
        has = true;
      }
      if (has) cells[`${rStr},${cStr}`] = jk;
    }
  }
  return cells;
}

/** Univer 快照单个 sheet → JkSheet */
function univerSheetToJk(
  id: string,
  s: Record<string, any>,
  styles: Record<string, any> | undefined,
): JkSheet {
  const merges: JkMerge[] = (s.mergeData ?? []).map((m: Record<string, number>) => ({
    startRow: m.startRow,
    startCol: m.startColumn,
    endRow: m.endRow,
    endCol: m.endColumn,
  }));
  const colWidths: Record<number, number> = {};
  for (const [idx, c] of Object.entries(s.columnData ?? {})) {
    const w = (c as Record<string, number>)?.width;
    if (w) colWidths[Number(idx)] = Math.round(w);
  }
  const rowHeights: Record<number, number> = {};
  for (const [idx, r] of Object.entries(s.rowData ?? {})) {
    const h = (r as Record<string, number>)?.height;
    if (h) rowHeights[Number(idx)] = Math.round(h);
  }
  return {
    name: s.name ?? id,
    rowCount: s.rowCount ?? DEFAULT_ROWS,
    colCount: s.columnCount ?? DEFAULT_COLS,
    cells: cellDataToJk(s.cellData, styles),
    merges,
    colWidths: Object.keys(colWidths).length ? colWidths : undefined,
    rowHeights: Object.keys(rowHeights).length ? rowHeights : undefined,
    hidden: s.hidden ? true : undefined,
  };
}

/** Univer 快照（FWorkbook.save()）→ JkWorkbook */
export function univerSnapshotToJk(snapshot: Record<string, any>): JkWorkbook {
  const styles = (snapshot.styles ?? {}) as Record<string, any>;
  const sheets: JkSheet[] = [];
  for (const [id, s] of Object.entries(snapshot.sheets ?? {})) {
    sheets.push(univerSheetToJk(id, s as Record<string, any>, styles));
  }
  return {
    sheets: sheets.length
      ? sheets
      : [{ name: 'Sheet1', rowCount: DEFAULT_ROWS, colCount: DEFAULT_COLS, cells: {}, merges: [] }],
    activeSheetIndex: 0,
    fidelity: { level: 'L2', notes: ['样式已双向映射', '主题色/渐变填充/富文本片段未完整还原（v1 L2）'] },
  };
}
