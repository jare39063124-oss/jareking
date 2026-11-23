import { parseFormula } from './parser'
import { evaluateAST, isError, type EvalResult } from './evaluator'
import type { ASTNode } from './ast'
import type { WorksheetModel } from '../model/WorksheetModel'
import type { CellAddress } from '../model/types'
import { cellKey } from '../model/address'

/**
 * 公式引擎
 * 负责公式解析、求值、依赖分析与重算
 */
export class FormulaEngine {
  private worksheet: WorksheetModel
  /** 缓存解析后的 AST */
  private astCache = new Map<string, ASTNode>()

  constructor(worksheet: WorksheetModel) {
    this.worksheet = worksheet
  }

  /** 解析公式（带缓存） */
  private parse(formula: string, key: string): ASTNode {
    let ast = this.astCache.get(key)
    if (!ast) {
      ast = parseFormula(formula)
      this.astCache.set(key, ast)
    }
    return ast
  }

  /** 失效缓存（单元格内容变化时调用） */
  invalidateCache(key?: string): void {
    if (key) {
      this.astCache.delete(key)
    } else {
      this.astCache.clear()
    }
  }

  /** 求值单个单元格的公式 */
  evaluateCell(row: number, col: number): EvalResult {
    const cell = this.worksheet.getCell(row, col)
    if (!cell.formula) return cell.value
    const key = cellKey(row, col)
    try {
      const ast = this.parse(cell.formula, key)
      return evaluateAST(ast, { worksheet: this.worksheet, visiting: new Set() })
    } catch {
      return '#VALUE!'
    }
  }

  /** 求值公式字符串 */
  evaluate(formula: string): EvalResult {
    try {
      const ast = parseFormula(formula)
      return evaluateAST(ast, { worksheet: this.worksheet, visiting: new Set() })
    } catch {
      return '#VALUE!'
    }
  }

  /**
   * 获取公式引用的所有单元格地址（依赖分析）
   */
  getDependencies(formula: string): CellAddress[] {
    try {
      const ast = parseFormula(formula)
      const deps: CellAddress[] = []
      this.collectRefs(ast, deps)
      return deps
    } catch {
      return []
    }
  }

  private collectRefs(node: ASTNode, deps: CellAddress[]): void {
    switch (node.type) {
      case 'cellRef':
        deps.push({ row: node.row, col: node.col })
        break
      case 'rangeRef':
        for (let r = node.startRow; r <= node.endRow; r++) {
          for (let c = node.startCol; c <= node.endCol; c++) {
            deps.push({ row: r, col: c })
          }
        }
        break
      case 'function':
        node.args.forEach((a) => this.collectRefs(a, deps))
        break
      case 'binaryOp':
        this.collectRefs(node.left, deps)
        this.collectRefs(node.right, deps)
        break
      case 'unaryOp':
        this.collectRefs(node.operand, deps)
        break
    }
  }

  /**
   * 重算整个工作表中所有公式单元格
   * 按依赖顺序求值
   */
  recalculateAll(): void {
    // 收集所有公式单元格
    const formulaCells: { row: number; col: number; formula: string }[] = []
    for (const [addr, cell] of this.worksheet.iterateCells()) {
      if (cell.formula) {
        formulaCells.push({ row: addr.row, col: addr.col, formula: cell.formula })
      }
    }

    // 简单拓扑排序：多次遍历直到全部计算完成或检测到循环
    const calculated = new Set<string>()
    let changed = true
    let iterations = 0
    const maxIterations = formulaCells.length + 1

    while (changed && iterations < maxIterations) {
      changed = false
      iterations++
      for (const fc of formulaCells) {
        const key = cellKey(fc.row, fc.col)
        if (calculated.has(key)) continue
        // 检查依赖是否都已计算
        const deps = this.getDependencies(fc.formula)
        const ready = deps.every((d) => {
          const dCell = this.worksheet.getCell(d.row, d.col)
          return !dCell.formula || calculated.has(cellKey(d.row, d.col))
        })
        if (ready) {
          const result = this.evaluateCell(fc.row, fc.col)
          // 将结果写入 value（保留 formula）
          this.worksheet.getCell(fc.row, fc.col).value = isError(result) ? result : result
          calculated.add(key)
          changed = true
        }
      }
    }

    // 剩余未计算的（循环引用）标记错误
    for (const fc of formulaCells) {
      const key = cellKey(fc.row, fc.col)
      if (!calculated.has(key)) {
        this.worksheet.getCell(fc.row, fc.col).value = '#REF!'
      }
    }
  }

  /**
   * 重算依赖指定单元格的所有公式
   */
  recalculateDependents(changedRow: number, changedCol: number): void {
    const changedKey = cellKey(changedRow, changedCol)
    const affected = new Set<string>()
    affected.add(changedKey)

    // 找出所有依赖 changedKey 的公式单元格
    let added = true
    while (added) {
      added = false
      for (const [addr, cell] of this.worksheet.iterateCells()) {
        if (!cell.formula) continue
        const key = cellKey(addr.row, addr.col)
        if (affected.has(key)) continue
        const deps = this.getDependencies(cell.formula)
        if (deps.some((d) => affected.has(cellKey(d.row, d.col)))) {
          affected.add(key)
          added = true
        }
      }
    }

    // 重算受影响的公式单元格
    for (const key of affected) {
      if (key === changedKey) continue
      const [row, col] = key.split(':').map(Number)
      const result = this.evaluateCell(row, col)
      this.worksheet.getCell(row, col).value = isError(result) ? result : result
    }
  }
}
