/** 单元格值类型 */
export type CellValue = string | number | boolean | null

/** 水平对齐 */
export type HorizontalAlign = 'left' | 'center' | 'right'
/** 垂直对齐 */
export type VerticalAlign = 'top' | 'middle' | 'bottom'

/** 单元格样式 */
export interface CellStyle {
  fontFamily?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  bgColor?: string
  hAlign?: HorizontalAlign
  vAlign?: VerticalAlign
}

/** 单元格模型 */
export interface CellModel {
  /** 原始值（用户输入或公式计算结果） */
  value: CellValue
  /** 公式字符串（如 "=SUM(A1:A3)"），无公式时为 null */
  formula: string | null
  /** 样式 */
  style: CellStyle
}

/** 单元格地址（0-indexed） */
export interface CellAddress {
  row: number
  col: number
}

/** 单元格范围 */
export interface CellRange {
  start: CellAddress
  end: CellAddress
}

/** 默认样式 */
export const DEFAULT_STYLE: CellStyle = {
  fontFamily: 'Microsoft YaHei',
  fontSize: 12,
  bold: false,
  italic: false,
  underline: false,
  color: '#000000',
  bgColor: '#ffffff',
  hAlign: 'left',
  vAlign: 'middle',
}

/** 创建默认单元格 */
export function createCell(value: CellValue = null): CellModel {
  return { value, formula: null, style: { ...DEFAULT_STYLE } }
}
