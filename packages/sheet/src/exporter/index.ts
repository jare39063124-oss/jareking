/**
 * T2.1 xlsx 导出器：JkWorkbook → exceljs → xlsx 字节流。
 *
 * 与解析器（parser/xlsxParser.ts）精确互逆：
 * 列宽 px → 字符数 ((px-5)/7)，行高 px → 点数 (px*3/4)，
 * 颜色 #RRGGBB → ARGB（补 FF 前缀），合并区域 → A1 记法。
 */
import ExcelJS from 'exceljs';
import type { JkCell, JkCellStyle, JkSheet, JkWorkbook } from '../model/index.js';
import { colToLetters } from '../model/index.js';

/** #RRGGBB → ARGB（exceljs 需要完整 8 位） */
function hexToArgb(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  const h = hex.replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(h) ? `FF${h}` : undefined;
}

function applyStyle(cell: ExcelJS.Cell, s: JkCellStyle): void {
  const font: Partial<ExcelJS.Font> = {};
  if (s.bold) font.bold = true;
  if (s.italic) font.italic = true;
  if (s.underline) font.underline = true;
  if (s.strike) font.strike = true;
  if (s.fontSize) font.size = s.fontSize;
  if (s.fontFamily) font.name = s.fontFamily;
  const fontColor = hexToArgb(s.color);
  if (fontColor) font.color = { argb: fontColor };
  if (Object.keys(font).length) cell.font = font as ExcelJS.Font;

  const bg = hexToArgb(s.bgColor);
  if (bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };

  if (s.align || s.valign || s.wrapText) {
    cell.alignment = {
      horizontal: s.align as ExcelJS.Alignment['horizontal'],
      vertical: (s.valign === 'middle' ? 'middle' : s.valign) as ExcelJS.Alignment['vertical'],
      wrapText: s.wrapText,
    };
  }

  if (s.borders) {
    const border: Partial<ExcelJS.Borders> = {};
    const thin = { style: 'thin' as const };
    if (s.borders.top) border.top = thin;
    if (s.borders.right) border.right = thin;
    if (s.borders.bottom) border.bottom = thin;
    if (s.borders.left) border.left = thin;
    if (Object.keys(border).length) cell.border = border;
  }

  if (s.numFmt) cell.numFmt = s.numFmt;
}

function fillSheet(wb: ExcelJS.Workbook, sheet: JkSheet): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(sheet.name, {
    state: sheet.hidden ? 'hidden' : 'visible',
    views:
      sheet.freeze && (sheet.freeze.row || sheet.freeze.col)
        ? [
            {
              state: 'frozen',
              xSplit: sheet.freeze.col ?? 0,
              ySplit: sheet.freeze.row ?? 0,
            } as ExcelJS.WorksheetView,
          ]
        : undefined,
  });

  // 单元格（值 / 公式 / 样式）
  for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
    const [rStr, cStr] = key.split(',');
    const row = Number(rStr);
    const col = Number(cStr);
    if (!Number.isFinite(row) || !Number.isFinite(col)) continue;
    const target = ws.getCell(row + 1, col + 1);
    const jk = cell as JkCell;
    if (jk.formula) {
      // 公式交给 Excel/WPS 打开时重算；jareking 内由公式引擎/T2.3 计算
      target.value = { formula: jk.formula };
    } else if (jk.value !== undefined && jk.value !== null) {
      target.value = jk.value as ExcelJS.CellValue;
    }
    if (jk.style) applyStyle(target, jk.style);
  }

  // 合并区域
  for (const m of sheet.merges ?? []) {
    const ref = `${colToLetters(m.startCol)}${m.startRow + 1}:${colToLetters(m.endCol)}${m.endRow + 1}`;
    ws.mergeCells(ref);
  }

  // 列宽（px → 字符数）
  for (const [idxStr, px] of Object.entries(sheet.colWidths ?? {})) {
    const col = ws.getColumn(Number(idxStr) + 1);
    if (col) col.width = Math.max(1, (px - 5) / 7);
  }

  // 行高（px → 点数）
  for (const [idxStr, px] of Object.entries(sheet.rowHeights ?? {})) {
    const row = ws.getRow(Number(idxStr) + 1);
    if (row) row.height = (px * 3) / 4;
  }

  // 声明的网格尺寸（exceljs 按内容自动扩展，这里保证空表也有最小尺寸）
  const minRows = Math.max(sheet.rowCount, ws.rowCount, 1);
  const minCols = Math.max(sheet.colCount, ws.columnCount, 1);
  if (ws.rowCount < minRows) ws.getRow(minRows);
  if (ws.columnCount < minCols) ws.getColumn(minCols);

  return ws;
}

/** 把 JkWorkbook 导出为 xlsx 字节流 */
export async function exportXlsx(wb: JkWorkbook): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  book.creator = wb.creator ?? 'jareking';
  if (wb.createdAt) book.created = new Date(wb.createdAt);
  for (const sheet of wb.sheets ?? []) fillSheet(book, sheet);
  if (!book.worksheets.length) book.addWorksheet('Sheet1');

  const view = book.views[0] as { activeTab?: number } | undefined;
  if (view) view.activeTab = wb.activeSheetIndex ?? 0;

  const buf = await book.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

/** 导出并写入本地 .xlsx 文件（Node / Electron 主进程） */
export async function exportXlsxToFile(wb: JkWorkbook, path: string): Promise<void> {
  const buf = await exportXlsx(wb);
  const fs = (await import('node:fs/promises')) as { writeFile: (p: string, d: Buffer) => Promise<void> };
  await fs.writeFile(path, Buffer.from(buf));
}
