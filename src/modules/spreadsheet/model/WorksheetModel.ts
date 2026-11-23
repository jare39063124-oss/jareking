import {
  type CellModel,
  type CellValue,
  type CellStyle,
  type CellAddress,
  type CellRange,
  createCell,
  DEFAULT_STYLE,
} from './types'
import { cellKey, iterateRange } from './address'

/**
 * 工作表数据模型
 * 单元格存储为 Map<"row:col", CellModel>，稀疏存储
 */
export class WorksheetModel {
  name: string
  private cells = new Map<string, CellModel>()
  rowCount: number
  colCount: number
  private colWidths = new Map<number, number>()
  private rowHeights = new Map<number, number>()
  // 撤销/重做历史栈
  private history: Array<Map<string, CellModel>> = []
  private future: Array<Map<string, CellModel>> = []
  private maxHistory = 50

  constructor(name = 'Sheet1', rowCount = 1000, colCount = 100) {
    this.name = name
    this.rowCount = rowCount
    this.colCount = colCount
  }

  /** 深拷贝当前 cells 快照 */
  private snapshot(): Map<string, CellModel> {
    const copy = new Map<string, CellModel>()
    for (const [k, v] of this.cells) {
      copy.set(k, { ...v, style: { ...v.style } })
    }
    return copy
  }

  /** 在修改前推入历史栈 */
  private pushHistory(): void {
    this.history.push(this.snapshot())
    if (this.history.length > this.maxHistory) this.history.shift()
    this.future = []
  }

  /** 撤销 */
  undo(): boolean {
    if (this.history.length === 0) return false
    this.future.push(this.snapshot())
    this.cells = this.history.pop()!
    return true
  }

  /** 重做 */
  redo(): boolean {
    if (this.future.length === 0) return false
    this.history.push(this.snapshot())
    this.cells = this.future.pop()!
    return true
  }

  canUndo(): boolean {
    return this.history.length > 0
  }

  canRedo(): boolean {
    return this.future.length > 0
  }

  /** 获取列宽（默认 80） */
  getColWidth(col: number): number {
    return this.colWidths.get(col) ?? 80
  }

  /** 设置列宽 */
  setColWidth(col: number, width: number): void {
    this.colWidths.set(col, Math.max(20, width))
  }

  /** 获取行高（默认 24） */
  getRowHeight(row: number): number {
    return this.rowHeights.get(row) ?? 24
  }

  /** 设置行高 */
  setRowHeight(row: number, height: number): void {
    this.rowHeights.set(row, Math.max(15, height))
  }

  /** 获取单元格（不存在则返回默认空单元格） */
  getCell(row: number, col: number): CellModel {
    const cell = this.cells.get(cellKey(row, col))
    return cell ?? createCell()
  }

  /** 设置单元格 */
  setCell(row: number, col: number, cell: CellModel): void {
    this.cells.set(cellKey(row, col), cell)
  }

  /** 获取单元格值 */
  getValue(row: number, col: number): CellValue {
    return this.getCell(row, col).value
  }

  /** 设置单元格值 */
  setValue(row: number, col: number, value: CellValue): void {
    this.pushHistory()
    const cell = this.getCell(row, col)
    cell.value = value
    cell.formula = null
    this.setCell(row, col, cell)
  }

  /** 设置单元格公式 */
  setFormula(row: number, col: number, formula: string): void {
    this.pushHistory()
    const cell = this.getCell(row, col)
    cell.formula = formula
    this.setCell(row, col, cell)
  }

  /** 获取单元格公式 */
  getFormula(row: number, col: number): string | null {
    return this.getCell(row, col).formula
  }

  /** 设置单元格样式（合并到现有样式） */
  setStyle(row: number, col: number, style: Partial<CellStyle>): void {
    this.pushHistory()
    const cell = this.getCell(row, col)
    cell.style = { ...cell.style, ...style }
    this.setCell(row, col, cell)
  }

  /** 获取单元格样式 */
  getStyle(row: number, col: number): CellStyle {
    return { ...DEFAULT_STYLE, ...this.getCell(row, col).style }
  }

  /** 获取范围内所有单元格的值 */
  getRangeValues(range: CellRange): CellValue[][] {
    const values: CellValue[][] = []
    for (let r = range.start.row; r <= range.end.row; r++) {
      const row: CellValue[] = []
      for (let c = range.start.col; c <= range.end.col; c++) {
        row.push(this.getValue(r, c))
      }
      values.push(row)
    }
    return values
  }

  /** 获取范围内所有已设置的单元格（用于公式依赖分析等） */
  *iterateCells(): Generator<[CellAddress, CellModel]> {
    for (const [key, cell] of this.cells) {
      const [row, col] = key.split(':').map(Number)
      yield [{ row, col }, cell]
    }
  }

  /** 清空单元格 */
  clearCell(row: number, col: number): void {
    this.pushHistory()
    this.cells.delete(cellKey(row, col))
  }

  /** 清空范围内所有单元格 */
  clearRange(range: CellRange): void {
    this.pushHistory()
    for (const addr of iterateRange(range)) {
      this.cells.delete(cellKey(addr.row, addr.col))
    }
  }
}
