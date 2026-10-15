/**
 * chartData —— 单元格矩阵 → 图表数据（Sheet「插入图表」T2.5）。
 *
 * 职责：把从选区读到的二维单元格值，按「直观约定」解析为 `renderChartToPng`
 * 所需的 `labels` + `series`（bar/line/pie 复用同一份数据）。纯函数、零依赖，可单测。
 *
 * 解析约定（首行作表头、首列作标签）：
 *   - 空矩阵 → 空数据。
 *   - 单列：首格若为文本 → 作系列名（其余为数值）；否则整列为数值、系列名「系列1」；
 *           标签统一用行序（1、2、3…）。
 *   - 多列：首列作分类标签；首行的数据列（第 2 列起）若全为文本 → 视为表头（作系列名），
 *           数据自第 2 行开始；否则全部行均视为数据。每个数据列构成一个系列。
 *   - 数值解析：number 原样；数字串（去千分位）转数字；布尔 true/false → 1/0；
 *           无法解析（文本/空）→ 0（图表绘制对无效值另有跳过逻辑，此处统一下沉为 0）。
 */
import type { ChartSeries } from '../lib/chartRenderer';

/** 单元格原始值（对齐 Univer CellValue 的可展示子集） */
export type CellPrimitive = string | number | boolean | null | undefined;

export interface ChartData {
  labels: string[];
  series: ChartSeries[];
}

/** 数值解析：可解析 → number，否则 null */
export function toChartNumber(v: CellPrimitive): number | null {
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

/** 值 → 标签文本（null/undefined → 空串） */
export function toChartLabel(v: CellPrimitive): string {
  return v === null || v === undefined ? '' : String(v);
}

/** 行是否为空行（全为空/空串） */
function isBlankRow(row: CellPrimitive[] | undefined): boolean {
  return !row || row.every((c) => c === null || c === undefined || c === '');
}

/**
 * 二维单元格矩阵 → 图表数据。
 * @param matrix 0 基行列的单元格值矩阵（来自 `FRange.getValues()`）
 */
export function buildChartData(matrix: CellPrimitive[][]): ChartData {
  const rows = (matrix ?? []).filter((r) => Array.isArray(r) && r.length > 0);
  if (!rows.length) return { labels: [], series: [] };

  const colCount = Math.max(...rows.map((r) => r.length));
  const at = (r: number, c: number): CellPrimitive => rows[r]?.[c];

  // 单列：数值列（首格可作系列名）
  if (colCount === 1) {
    const firstText = toChartNumber(at(0, 0)) === null && toChartLabel(at(0, 0)) !== '';
    const start = firstText ? 1 : 0;
    const labels: string[] = [];
    const values: number[] = [];
    for (let r = start; r < rows.length; r++) {
      labels.push(String(r - start + 1));
      values.push(toChartNumber(at(r, 0)) ?? 0);
    }
    const name = firstText ? toChartLabel(at(0, 0)) : '系列1';
    return { labels, series: [{ name, values }] };
  }

  // 多列：首行「数据列」（第 2 列起）全为文本且首行非空 → 视作表头
  let dataColsAllText = true;
  for (let c = 1; c < colCount; c++) {
    if (toChartNumber(at(0, c)) !== null) {
      dataColsAllText = false;
      break;
    }
  }
  const headerIsText = dataColsAllText && !isBlankRow(rows[0]);
  const startRow = headerIsText ? 1 : 0;

  const labels: string[] = [];
  for (let r = startRow; r < rows.length; r++) {
    labels.push(toChartLabel(at(r, 0)) || String(r - startRow + 1));
  }

  const series: ChartSeries[] = [];
  for (let c = 1; c < colCount; c++) {
    const name = headerIsText ? toChartLabel(at(0, c)) || `系列${c}` : `系列${c}`;
    const values: number[] = [];
    for (let r = startRow; r < rows.length; r++) values.push(toChartNumber(at(r, c)) ?? 0);
    series.push({ name, values });
  }
  return { labels, series };
}
