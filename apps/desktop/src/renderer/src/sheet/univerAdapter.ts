/**
 * univerAdapter —— JkWorkbook ↔ Univer 工作簿数据互转（T2.2）。
 *
 * Univer v1.0 preset 数据形状（IWorkbookData/IWorksheetData）：
 *   sheets: { [sheetId]: { name, rowCount, columnCount,
 *             cellData: { [row]: { [col]: { v?, f? } } },
 *             mergeData: IRange[], columnData: { [col]: { width? } },
 *             rowData: { [row]: { height? } } } }
 *
 * 坐标同为 0 基，可直接映射；样式（IStyleData 枚举语义）暂不映射，
 * 属 T2.2 后续迭代（当前保留 JkWorkbook 侧样式，Univer 内编辑样式后
 * 保存仅回传 Univer 能表达的快照字段）。
 */
import type { JkCell, JkMerge, JkSheet, JkWorkbook } from '@jareking/sheet';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 默认网格尺寸（Univer 建议初始即给足，编辑时自动扩展） */
const DEFAULT_ROWS = 100;
const DEFAULT_COLS = 26;

/** JkSheet → Univer IWorksheetData（any 边界，见文件头说明） */
function sheetToUniver(sheet: JkSheet): Record<string, any> {
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
  const sheets: Record<string, any> = {};
  (wb.sheets ?? []).forEach((s, i) => {
    // 关键：sheet 键必须用 Univer 默认命名（sheet-01…），否则权限点注册与实际
    // sheetId 错位，导致所有写入被权限系统静默拦截（弹「范围已保护」对话框）
    sheets[`sheet-${String(i + 1).padStart(2, '0')}`] = sheetToUniver(s);
  });
  if (!Object.keys(sheets).length) {
    sheets['sheet-01'] = sheetToUniver({
      name: 'Sheet1',
      rowCount: DEFAULT_ROWS,
      colCount: DEFAULT_COLS,
      cells: {},
      merges: [],
    });
  }
  // 官方最小形状：id/styles/sheets（locale 由 createUniver 全局配置，不放在工作簿上）
  return { id: 'jareking-sheet', styles: {}, sheets };
}

/** Univer cellData 矩阵 → 稀疏 JkCell 映射 */
function cellDataToJk(cellData: Record<string, Record<string, any>> | undefined): JkSheet['cells'] {
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
      if (has) cells[`${rStr},${cStr}`] = jk;
    }
  }
  return cells;
}

/** Univer 快照单个 sheet → JkSheet */
function univerSheetToJk(id: string, s: Record<string, any>): JkSheet {
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
    cells: cellDataToJk(s.cellData),
    merges,
    colWidths: Object.keys(colWidths).length ? colWidths : undefined,
    rowHeights: Object.keys(rowHeights).length ? rowHeights : undefined,
    hidden: s.hidden ? true : undefined,
  };
}

/** Univer 快照（FWorkbook.save()）→ JkWorkbook */
export function univerSnapshotToJk(snapshot: Record<string, any>): JkWorkbook {
  const sheets: JkSheet[] = [];
  for (const [id, s] of Object.entries(snapshot.sheets ?? {})) {
    sheets.push(univerSheetToJk(id, s as Record<string, any>));
  }
  return {
    sheets: sheets.length
      ? sheets
      : [{ name: 'Sheet1', rowCount: DEFAULT_ROWS, colCount: DEFAULT_COLS, cells: {}, merges: [] }],
    activeSheetIndex: 0,
    fidelity: { level: 'L2', notes: ['样式映射暂未接入 Univer（T2.2 后续迭代）'] },
  };
}
