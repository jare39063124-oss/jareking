/**
 * jareking Sheet 表格数据模型（T2.1 接口契约）。
 *
 * 对应 .xlsx（SpreadsheetML）核心结构，面向 v1 保真 L2：
 * 多 sheet / 值与公式 / 合并单元格 / 行列尺寸 / 冻结 / 基础单元格样式。
 *
 * 坐标约定：全部 0 基（row、col 从 0 开始），与 Univer 一致；
 * 与 Excel A1 记法的互转仅存在于解析/导出边界。
 * 尺寸约定：列宽与行高统一用像素（px）；与 Excel 内部单位
 * （列宽字符数、行高点数）的换算仅在 xlsx 读写边界发生。
 */

/* =========================================================================
 * 单元格
 * ========================================================================= */

/** 单元格样式（xlsx 基础子集） */
export interface JkCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 字体颜色 #RRGGBB */
  color?: string;
  /** 背景填充 #RRGGBB（纯色） */
  bgColor?: string;
  /** 字号（磅） */
  fontSize?: number;
  fontFamily?: string;
  align?: 'general' | 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  wrapText?: boolean;
  /** 数字格式代码（如 "0.00"、"yyyy-mm-dd"） */
  numFmt?: string;
  /** 四边框（v1 只记录有无细线） */
  borders?: {
    top?: boolean;
    right?: boolean;
    bottom?: boolean;
    left?: boolean;
  };
}

/** 单元格：静态值或公式（二者可并存，公式优先展示计算结果） */
export interface JkCell {
  /** 字面值；空单元格无此字段 */
  value?: string | number | boolean | null;
  /** 公式（不带 "="），如 "SUM(A1:A2)" */
  formula?: string;
  style?: JkCellStyle;
}

/* =========================================================================
 * 工作表
 * ========================================================================= */

/** 合并区域（0 基闭区间） */
export interface JkMerge {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** 冻结窗格（冻结前 N 行 / 前 N 列） */
export interface JkFreeze {
  row?: number;
  col?: number;
}

/** 工作表 */
export interface JkSheet {
  name: string;
  /** 声明的总行数（含空行，用于初始化网格） */
  rowCount: number;
  /** 声明的总列数 */
  colCount: number;
  /** 稀疏单元格存储：键 "r,c"（0 基），如 cells['0,1'] */
  cells: Record<string, JkCell>;
  merges: JkMerge[];
  /** 列宽（px），键为列号；未列出的用默认宽 */
  colWidths?: Record<number, number>;
  /** 行高（px），键为行号；未列出的用默认高 */
  rowHeights?: Record<number, number>;
  freeze?: JkFreeze;
  hidden?: boolean;
}

/* =========================================================================
 * 工作簿
 * ========================================================================= */

export interface JkWorkbook {
  sheets: JkSheet[];
  /** 活动工作表下标（默认 0） */
  activeSheetIndex?: number;
  creator?: string;
  createdAt?: string;
  /** v1 预留：无法完整还原的特性清单（对齐 writer 的 fidelity 思路） */
  fidelity?: {
    level: 'L1' | 'L2' | 'L3';
    notes: string[];
  };
}

/* =========================================================================
 * A1 记法工具（解析/导出边界用）
 * ========================================================================= */

/** 列号 → 字母（0 → A，25 → Z，26 → AA） */
export function colToLetters(col: number): string {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 字母 → 列号（A → 0） */
export function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** 0 基 (row,col) → A1 记法 */
export function toA1(row: number, col: number): string {
  return `${colToLetters(col)}${row + 1}`;
}

/** A1 区域记法 → JkMerge（支持 "A1" 或 "A1:B2"） */
export function parseA1Range(ref: string): JkMerge | null {
  const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(ref.trim());
  if (!m) return null;
  const startCol = lettersToCol(m[1]);
  const startRow = Number(m[2]) - 1;
  const endCol = m[3] ? lettersToCol(m[3]) : startCol;
  const endRow = m[4] ? Number(m[4]) - 1 : startRow;
  return { startRow, startCol, endRow, endCol };
}
