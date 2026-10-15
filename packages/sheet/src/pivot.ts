/**
 * Sheet 数据透视表聚合引擎（WPS 对齐专项——数据透视表 MVP）。
 *
 * 纯函数，仅依赖基础数据类型，可独立单测（不触碰 Univer 实例）。
 *
 * 职责：把从选区读到的二维单元格矩阵，按「行字段」分组、可选按「列字段」横向展开，
 * 并对「值字段」按指定聚合方式（sum/count/avg/max/min）汇总，产出可直接写入工作表的
 * `header` + `rows` 结构。
 *
 * 设计要点：
 *  - 面向 MVP：不做透视缓存/刷新，输入输出均为一次性纯数据。
 *  - 确定性：分组键与列字段取值均按字典序（locale 无关的码点序）稳定排序，
 *    多次运行结果完全一致，便于单测与回归。
 *  - 数值解析：number 原样；布尔 true/false → 1/0；数字串（去千分位、去空白）转数字；
 *    其余（文本/空）对 sum/avg/max/min 一律跳过；对 count 计入「非空」单元格。
 *  - 空值：null / undefined / 空串视为空。
 */
import { colToLetters } from './model/index.js';

/** 聚合方式 */
export type PivotAgg = 'sum' | 'count' | 'avg' | 'max' | 'min';

/** 透视表可接受的单元格原始值（对齐 Univer CellValue 的可展示子集） */
export type PivotCellValue = string | number | boolean | null | undefined;

/** 透视表配置 */
export interface PivotConfig {
  /** 行字段列索引（0 基，可多个=多级分组） */
  rowFields: number[];
  /** 列字段列索引（可选，用于横向展开） */
  colField?: number;
  /** 值字段列索引 + 聚合方式 */
  values: { field: number; agg: PivotAgg }[];
  /** 首行是否表头 */
  hasHeader?: boolean;
}

/** 透视表结果 */
export interface PivotResult {
  /** 表头行（列字段展开后的值字段标题，如 "Q1 求和"） */
  header: string[];
  /** 数据行（行字段值 + 各聚合值） */
  rows: (string | number)[][];
}

/** 聚合方式 → 中文标签（用于表头，如 "金额 求和"） */
const AGG_LABEL: Record<PivotAgg, string> = {
  sum: '求和',
  count: '计数',
  avg: '平均值',
  max: '最大值',
  min: '最小值',
};

/** 分组键 / 列值去重的分隔符（选极小概率出现在单元格中的控制字符，避免键碰撞） */
const KEY_SEP = '\u0001';

/** 空值判定：null / undefined / 空串 */
function isEmpty(v: PivotCellValue): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * 数值解析：可解析 → number，否则 null（非数字将被 sum/avg/max/min 跳过）。
 *  - number：有限数返回本身，否则 null
 *  - boolean：true → 1，false → 0
 *  - string：去空白、去千分位逗号后 Number()，非有限 → null
 *  对外导出，供渲染层判定「首行是否表头」复用，保证口径一致。
 */
export function pivotToNumber(v: PivotCellValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '');
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 值 → 分组键/去重键的字符串形式（null/undefined → 空串） */
function keyOf(v: PivotCellValue): string {
  return v === null || v === undefined ? '' : String(v);
}

/** 值 → 输出单元格（保留数字；其余转字符串；空 → 空串） */
function toDisplay(v: PivotCellValue): string | number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (isEmpty(v)) return '';
  return String(v);
}

/** 列字段取值 → 展开表头前缀（空值显示为 "(空白)"） */
function colLabel(v: PivotCellValue): string {
  return isEmpty(v) ? '(空白)' : String(v);
}

/** 对一组单元格按聚合方式求值（无有效数值时返回 0） */
function aggregate(cells: PivotCellValue[], agg: PivotAgg): number {
  // count：统计「非空」单元格（含文本）
  if (agg === 'count') return cells.filter((c) => !isEmpty(c)).length;

  // sum/avg/max/min：仅统计可解析为数字的单元格（非数字跳过）
  const nums: number[] = [];
  for (const c of cells) {
    const n = pivotToNumber(c);
    if (n !== null) nums.push(n);
  }
  if (!nums.length) return 0;

  let acc = nums[0];
  switch (agg) {
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'max':
      for (let i = 1; i < nums.length; i++) if (nums[i] > acc) acc = nums[i];
      return acc;
    case 'min':
      for (let i = 1; i < nums.length; i++) if (nums[i] < acc) acc = nums[i];
      return acc;
    default:
      return acc;
  }
}

/** 整行是否为空（无任何非空单元格） */
function isBlankRow(row: PivotCellValue[]): boolean {
  return row.length === 0 || row.every((c) => isEmpty(c));
}

/** 取字段显示名：有表头则用首行文本，否则回退「列A」记法 */
function fieldName(index: number, headerRow: PivotCellValue[], hasHeader: boolean): string {
  if (hasHeader) {
    const v = headerRow[index];
    if (!isEmpty(v)) return String(v);
  }
  return `列${colToLetters(index)}`;
}

/**
 * 由二维单元格矩阵构建数据透视表。
 *
 * @param matrix 0 基行列的单元格值矩阵（来自 `FRange.getValues()`）
 * @param config 透视配置（行字段 / 列字段 / 值字段与聚合方式 / 是否含表头）
 * @returns 表头与数据行；输入无效（空矩阵 / 无行字段 / 无值字段）时返回空结果
 */
export function buildPivot(
  matrix: (string | number | boolean | null | undefined)[][],
  config: PivotConfig,
): PivotResult {
  const rows: PivotCellValue[][] = Array.isArray(matrix) ? matrix.filter((r) => Array.isArray(r)) : [];
  const rowFields = config?.rowFields ?? [];
  const colField = config?.colField;
  const valueDefs = config?.values ?? [];
  const hasHeader = config?.hasHeader ?? false;

  // 前置校验：无数据 / 无行字段 / 无值字段 → 空结果（避免下游误写空表）
  if (!rows.length || !rowFields.length || !valueDefs.length) {
    return { header: [], rows: [] };
  }

  const headerRow: PivotCellValue[] = hasHeader ? rows[0] : [];
  // 数据区：含表头时跳过首行
  const dataRows = (hasHeader ? rows.slice(1) : rows).filter((r) => !isBlankRow(r));

  // 字段显示名（一次算好，供表头复用）
  const rowFieldNames = rowFields.map((f) => fieldName(f, headerRow, hasHeader));
  const valueFieldNames = valueDefs.map((v) => fieldName(v.field, headerRow, hasHeader));

  // 1) 按行字段分组（分组键为各字段 keyOf 拼接）
  const groupRows = new Map<string, PivotCellValue[][]>();
  const groupKeyVals = new Map<string, PivotCellValue[]>();
  for (const r of dataRows) {
    const keyVals = rowFields.map((f) => r[f]);
    const key = keyVals.map(keyOf).join(KEY_SEP);
    let bucket = groupRows.get(key);
    if (!bucket) {
      bucket = [];
      groupRows.set(key, bucket);
      groupKeyVals.set(key, keyVals);
    }
    bucket.push(r);
  }

  // 2) 字典序稳定排序分组键，保证确定性
  const sortedKeys = [...groupRows.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // 3) 列字段：收集去重后的取值，同样字典序稳定排序
  let colValues: PivotCellValue[] = [];
  if (colField !== undefined) {
    const uniq = new Map<string, PivotCellValue>();
    for (const r of dataRows) {
      const cv = r[colField];
      const ck = keyOf(cv);
      if (!uniq.has(ck)) uniq.set(ck, cv);
    }
    colValues = [...uniq.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map((e) => e[1]);
  }

  // 4) 构建表头：行字段名 + 值字段列标题
  const header: string[] = [...rowFieldNames];
  if (colField === undefined) {
    for (let i = 0; i < valueDefs.length; i++) {
      header.push(`${valueFieldNames[i]} ${AGG_LABEL[valueDefs[i].agg]}`);
    }
  } else {
    for (const cv of colValues) {
      const prefix = colLabel(cv);
      for (let i = 0; i < valueDefs.length; i++) {
        // 单值字段 → "Q1 求和"；多值字段 → "Q1 金额 求和"（避免列标题歧义）
        header.push(
          valueDefs.length === 1
            ? `${prefix} ${AGG_LABEL[valueDefs[i].agg]}`
            : `${prefix} ${valueFieldNames[i]} ${AGG_LABEL[valueDefs[i].agg]}`,
        );
      }
    }
  }

  // 5) 构建数据行：行字段值 + 各聚合值
  const outRows: (string | number)[][] = [];
  for (const key of sortedKeys) {
    const keyVals = groupKeyVals.get(key) ?? [];
    const bucket = groupRows.get(key) ?? [];
    const row: (string | number)[] = keyVals.map(toDisplay);

    if (colField === undefined) {
      for (const v of valueDefs) {
        row.push(aggregate(bucket.map((r) => r[v.field]), v.agg));
      }
    } else {
      for (const cv of colValues) {
        const ck = keyOf(cv);
        // 仅取该行组内列字段等于当前展开值的子集（无数据 → 聚合返回 0）
        const subset = bucket.filter((r) => keyOf(r[colField]) === ck);
        for (const v of valueDefs) {
          row.push(aggregate(subset.map((r) => r[v.field]), v.agg));
        }
      }
    }
    outRows.push(row);
  }

  return { header, rows: outRows };
}
