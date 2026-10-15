/**
 * Sheet 查找 / 替换（WPS 对齐专项——批3续）。
 *
 * 纯函数，仅依赖 JkWorkbook 数据模型，可独立单测（不触碰 Univer 实例）。
 *
 * 匹配规则：
 *  - 单元格 value 转为字符串后匹配；数字按 String(num) 比对。
 *  - wholeCell 为真 → 整体相等（大小写按 matchCase 决定）。
 *  - wholeCell 为假 → 包含匹配（matchCase 控制是否忽略大小写）。
 *  - 公式单元格（formula 字段）也纳入「查找」匹配（按公式串匹配）；
 *    但「替换」只作用于纯 value 单元格，命中 formula 单元格一律跳过——
 *    避免破坏公式结构（v1 行为，后续迭代再支持公式内局部替换）。
 */
import type { JkCell, JkSheet, JkWorkbook } from './model/index.js';

/** 查找选项 */
export interface FindOpts {
  /** 区分大小写（默认 false：不区分） */
  matchCase?: boolean;
  /** 全字（整单元格）匹配（默认 false：包含匹配） */
  wholeCell?: boolean;
}

/** 查找结果单元 */
export interface FindResult {
  /** 工作表下标（0 基） */
  sheetIndex: number;
  /** 工作表名 */
  sheetName: string;
  /** 行号（0 基） */
  row: number;
  /** 列号（0 基） */
  col: number;
  /** 命中时的可匹配文本（value 或 formula 的字符串形式） */
  value: string;
}

/** 取单元格「可匹配文本」：公式优先（按公式串匹配），其次为 value 字符串 */
function matchableText(cell: JkCell | undefined): string {
  if (!cell) return '';
  if (cell.formula !== undefined && cell.formula !== null && cell.formula !== '') {
    return String(cell.formula);
  }
  if (cell.value === undefined || cell.value === null) return '';
  return String(cell.value);
}

/** 取单元格「回写值」字符串（用于替换回写比对） */
function cellValueStr(value: JkCell['value']): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

/** 大小写安全的正则替换（保留原文本大小写，仅替换命中片段） */
function replaceCareful(text: string, search: string, replacement: string, matchCase: boolean): string {
  if (!search) return text;
  if (matchCase) {
    // 直接用 split/join 做字面替换
    return text.split(search).join(replacement);
  }
  // 不区分大小写：转义后走正则，保留原大小写
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), replacement);
}

/**
 * 在 JkWorkbook 全部工作表中查找匹配单元格。
 * @returns 匹配位置与命中值（按 工作表顺序 → 行 → 列 遍历）
 */
export function findCells(wb: JkWorkbook, query: string, opts: FindOpts = {}): FindResult[] {
  const results: FindResult[] = [];
  if (!query) return results;
  const matchCase = opts.matchCase ?? false;
  const wholeCell = opts.wholeCell ?? false;
  const needle = matchCase ? query : query.toLowerCase();

  (wb.sheets ?? []).forEach((sheet: JkSheet, sheetIndex: number) => {
    for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
      const text = matchableText(cell);
      if (!text) continue;
      const hay = matchCase ? text : text.toLowerCase();
      const matched = wholeCell ? hay === needle : hay.includes(needle);
      if (!matched) continue;
      const [rStr, cStr] = key.split(',');
      results.push({
        sheetIndex,
        sheetName: sheet.name,
        row: Number(rStr),
        col: Number(cStr),
        value: text,
      });
    }
  });
  return results;
}

/**
 * 全部替换，返回新工作簿与替换计数（不修改入参）。
 *
 * 不可变策略：只深拷贝「发生变化的页」的 cells，未改动页直接复用原对象，
 * 既保证入参不被修改，又避免大表整体深拷贝开销。
 */
export function replaceCells(
  wb: JkWorkbook,
  query: string,
  replacement: string,
  opts: FindOpts = {},
): { wb: JkWorkbook; count: number } {
  const matchCase = opts.matchCase ?? false;
  const wholeCell = opts.wholeCell ?? false;
  const needle = matchCase ? query : query.toLowerCase();
  let count = 0;

  const newSheets: JkSheet[] = (wb.sheets ?? []).map((sheet: JkSheet) => {
    let sheetChanged = false;
    const newCells: Record<string, JkCell> = {};

    for (const [key, cell] of Object.entries(sheet.cells ?? {})) {
      // v1：公式单元格跳过替换，原样保留（避免破坏公式结构）
      if (cell.formula !== undefined && cell.formula !== null && cell.formula !== '') {
        newCells[key] = cell;
        continue;
      }
      // 纯 value 单元格
      const raw = cell.value;
      if (raw === undefined || raw === null) {
        newCells[key] = cell;
        continue;
      }
      const text = String(raw);
      let newText: string;
      if (wholeCell) {
        const hay = matchCase ? text : text.toLowerCase();
        newText = hay === needle ? replacement : text;
      } else {
        newText = replaceCareful(text, query, replacement, matchCase);
      }
      if (newText !== text) {
        count++;
        sheetChanged = true;
        // 回写为字符串（替换可能改变原类型，v1 统一以字符串落地，公式单元格不受影响）
        newCells[key] = { ...cell, value: newText };
      } else {
        newCells[key] = cell;
      }
    }

    if (!sheetChanged) return sheet; // 未改动页：直接复用，零拷贝
    return { ...sheet, cells: newCells };
  });

  const newWb: JkWorkbook = { ...wb, sheets: newSheets };
  return { wb: newWb, count };
}

// 供 TS 使用（避免未使用导入告警——cellValueStr 在编辑器回写比对时复用）
export { cellValueStr };
