/**
 * Sheet 数据处理工具（WPS 对齐专项——「分列」与「删除重复项」MVP）。
 *
 * 纯函数，仅依赖基础数据类型，可独立单测（不触碰 Univer 实例）。
 *
 * 范式对齐 findReplace / cellStyle / pivot：渲染层从选区读出二维矩阵
 * （`FRange.getValues()`），传入本文件的纯函数，再把结果写回 Univer。
 *
 * 通用约定（与既有纯函数保持口径一致）：
 *  - 越界安全：读取越界列一律视为空值，绝不抛错（行为见各函数注释）。
 *  - 确定性：输出顺序仅由输入顺序决定，无随机、无 locale 相关排序。
 *  - 不改入参：全部产出新数组（逐行浅拷贝 + 归一化）。
 *  - 值归一化（normalizeCell）：number 原样；boolean → 'true' / 'false'；
 *    null / undefined → ''（空串）；string 原样。故输出类型为 (string | number)[][]。
 *    原布尔值不丢失语义（'true'/'false' 可读回），仅类型统一为字符串。
 */

/** 表格可接受的单元格原始值（对齐 Univer CellValue 的可展示子集） */
export type DataCellValue = string | number | boolean | null | undefined;

/** 去重键内部拼接分隔符（选极小概率出现在单元格中的控制字符，避免键碰撞） */
const KEY_SEP = '\u0001';

/**
 * 单值归一化：number 原样；boolean → 'true'/'false'；空 → ''；其余 String()。
 * 输出类型限定为 string | number（与 splitColumn/removeDuplicates 的返回类型一致）。
 */
function normalizeCell(v: DataCellValue): string | number {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** 单元格 → 用于「分列」的源文本：空 → ''，其余一律 String() */
function toSourceText(v: DataCellValue): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * 按分隔符把文本拆成若干段。
 *
 * maxSplit 语义为「最大段数」：拆出的段数超过 maxSplit 时，超出部分用分隔符
 * 拼回最后一段（如 maxSplit=2 时 "a,b,c" → ["a", "b,c"]），保证结果段数 ≤ maxSplit。
 * maxSplit 非有限数 / < 1 → 不限制（拆到尽头）。
 */
function splitParts(text: string, delimiter: string, maxSplit: number): string[] {
  const parts = text.split(delimiter);
  if (!Number.isFinite(maxSplit) || maxSplit < 1 || parts.length <= maxSplit) return parts;
  if (maxSplit === 1) return [parts.join(delimiter)];
  const head = parts.slice(0, maxSplit - 1);
  const tail = parts.slice(maxSplit - 1).join(delimiter);
  return [...head, tail];
}

/**
 * 按分隔符把指定列拆成多列，返回新矩阵（不改入参）。
 *
 * 行为说明：
 *  - 目标列（colIndex）每个数据行单元格按 delimiter 拆成若干段，原地展开为多列；
 *    非目标列原样保留（仅归一化）。
 *  - hasHeader 为真时，首行视为表头「不参与拆分」，原样保留。
 *  - 各行拆出的段数不等，最终统一补齐为等宽矩阵（短行用空串补到最大宽度）。
 *  - 安全兜底（不崩）：矩阵为空、目标列越界（colIndex < 0 或 ≥ 原始列数）、
 *    分隔符为空串 或 colIndex 非整数 → 不做拆分，仅归一化后原样返回。
 *
 * @param matrix    0 基行列的单元格值矩阵（来自 `FRange.getValues()`）
 * @param colIndex  要拆分的列索引（0 基，相对矩阵左端）
 * @param delimiter 分隔符（如 ","、" "、"\t"、"--"）
 * @param opts      hasHeader：首行是否表头；maxSplit：最大拆分段数（默认不限制）
 * @returns 拆分后的新矩阵（等宽，(string | number)[][]）
 */
export function splitColumn(
  matrix: DataCellValue[][],
  colIndex: number,
  delimiter: string,
  opts: { hasHeader?: boolean; maxSplit?: number } = {},
): (string | number)[][] {
  const rows: DataCellValue[][] = Array.isArray(matrix) ? matrix : [];
  if (!rows.length) return [];

  const hasHeader = opts.hasHeader ?? false;
  const maxSplit = opts.maxSplit === undefined ? Number.POSITIVE_INFINITY : Math.floor(opts.maxSplit);
  const delim = typeof delimiter === 'string' ? delimiter : '';

  // 原始列数（各行可能不等长，取最大）
  const origCols = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);

  // 安全兜底：无列 / 目标列越界 / 分隔符为空 → 不拆分，仅归一化原样返回
  if (
    origCols === 0 ||
    !Number.isInteger(colIndex) ||
    colIndex < 0 ||
    colIndex >= origCols ||
    delim === ''
  ) {
    return rows.map((r) => (Array.isArray(r) ? r.map(normalizeCell) : []));
  }

  // 逐行拆分（表头行原样保留，不参与拆分）
  const splitRows: (string | number)[][] = rows.map((row, rowIdx) => {
    const src: DataCellValue[] = Array.isArray(row) ? row : [];
    const isHeaderRow = hasHeader && rowIdx === 0;
    const out: (string | number)[] = [];
    for (let c = 0; c < origCols; c++) {
      if (c === colIndex && !isHeaderRow) {
        out.push(...splitParts(toSourceText(src[c]), delim, maxSplit));
      } else {
        out.push(normalizeCell(src[c]));
      }
    }
    return out;
  });

  // 补齐为等宽（各行拆出的段数不等 → 用空串补到最大宽度）
  const width = splitRows.reduce((m, r) => Math.max(m, r.length), 0);
  return splitRows.map((r) => {
    while (r.length < width) r.push('');
    return r;
  });
}

/**
 * 单个键值 → 去重键片段。
 * 用类型前缀区分：空值（null / undefined / 空串）统一为 'e'；
 * 布尔 'b:0|1'；数字 'd:…'；文本 's:…'。
 * 因此数字 1 与文本 "1" 视为「不同」（与 Excel/WPS 删除重复项口径一致）。
 */
function keyFragment(v: DataCellValue): string {
  if (v === null || v === undefined || v === '') return 'e';
  if (typeof v === 'boolean') return `b:${v ? '1' : '0'}`;
  if (typeof v === 'number') return `d:${String(v)}`;
  return `s:${String(v)}`;
}

/**
 * 按关键列组合去重（保留首次出现），返回新矩阵 + 移除行数（不改入参）。
 *
 * 行为说明：
 *  - 关键列为 keyCols 组合键（拼接后整体比对），仅移除「完全重复」的数据行，保留首次出现顺序。
 *  - hasHeader 为真时，首行视为表头，原样保留且不参与去重、不计入移除数。
 *  - keyCols 为空 → 无法判定重复，全部保留（removed = 0）。
 *  - 安全兜底（不崩）：越界关键列读取视为空值参与比对；非整数 / 负数列索引被过滤。
 *  - 输出统一补齐为等宽矩阵（短行用空串补到最大宽度）。
 *
 * @param matrix 0 基行列的单元格值矩阵（来自 `FRange.getValues()`）
 * @param keyCols 关键列索引数组（0 基，相对矩阵左端；顺序无关，内部去重升序）
 * @param opts hasHeader：首行是否表头
 * @returns rows：去重后的新矩阵；removed：移除的数据行数（不含表头）
 */
export function removeDuplicates(
  matrix: DataCellValue[][],
  keyCols: number[],
  opts: { hasHeader?: boolean } = {},
): { rows: (string | number)[][]; removed: number } {
  const rows: DataCellValue[][] = Array.isArray(matrix) ? matrix : [];
  if (!rows.length) return { rows: [], removed: 0 };

  const hasHeader = opts.hasHeader ?? false;
  // 关键列规整：过滤非整数 / 负数列，去重并升序（顺序不影响结果，但保证键确定性）
  const keys = Array.isArray(keyCols)
    ? [...new Set(keyCols.filter((c) => Number.isInteger(c) && c >= 0))].sort((a, b) => a - b)
    : [];

  const width = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
  /** 归一化并补齐到等宽（返回新数组，不改原行） */
  const pad = (r: DataCellValue[]): (string | number)[] => {
    const out = (Array.isArray(r) ? r : []).map(normalizeCell);
    while (out.length < width) out.push('');
    return out;
  };

  const outRows: (string | number)[][] = [];
  const seen = new Set<string>();
  let removed = 0;

  rows.forEach((row, rowIdx) => {
    const isHeaderRow = hasHeader && rowIdx === 0;
    // 表头行 / 无关键列：原样保留
    if (isHeaderRow || !keys.length) {
      outRows.push(pad(row));
      return;
    }
    const key = keys
      .map((c) => keyFragment(Array.isArray(row) ? row[c] : undefined))
      .join(KEY_SEP);
    if (seen.has(key)) {
      removed++;
      return;
    }
    seen.add(key);
    outRows.push(pad(row));
  });

  return { rows: outRows, removed };
}
