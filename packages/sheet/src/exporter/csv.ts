/**
 * T2.6 CSV 导出：JkSheet → CSV 字符串（UTF-8，RFC 4180 引号规则）。
 *
 * 说明：CSV 无公式与样式概念——公式单元格写出其缓存值（若有），
 * 否则写出公式文本；样式/合并/多表均不保留。
 * PDF 导出属 Phase 5 打印管线（T5.3），不在本文件。
 */
import type { JkSheet } from '../model/index.js';

/** 转义单个字段：含 逗号/引号/换行 时用双引号包裹并把内部引号翻倍 */
function csvEscape(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/** 单元格取显示值：公式优先缓存值，否则公式文本 */
function cellDisplayText(cell: { value?: unknown; formula?: string } | undefined): string {
  if (!cell) return '';
  if (cell.value !== undefined && cell.value !== null) return String(cell.value);
  if (cell.formula) return `=${cell.formula}`;
  return '';
}

/**
 * 把工作表导出为 CSV 字符串。
 * 范围：0..rowCount-1 / 0..colCount-1（稀疏格子缺失处为空字段）。
 */
export function sheetToCsv(sheet: JkSheet): string {
  const rows = Math.max(sheet.rowCount, 1);
  const cols = Math.max(sheet.colCount, 1);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const fields: string[] = [];
    for (let c = 0; c < cols; c++) {
      fields.push(csvEscape(cellDisplayText(sheet.cells?.[`${r},${c}`])));
    }
    lines.push(fields.join(','));
  }
  // 去掉末尾连续空行，减少无意义体积
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\r\n')}\r\n`;
}
