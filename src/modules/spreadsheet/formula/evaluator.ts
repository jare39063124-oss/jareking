import type { ASTNode } from './ast'
import type { WorksheetModel } from '../model/WorksheetModel'
import type { CellValue } from '../model/types'
import { parseFormula } from './parser'

/** 公式错误类型 */
export type FormulaError = '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#N/A'

/** 求值结果：值或错误 */
export type EvalResult = CellValue | FormulaError

/** 判断是否为错误值 */
export function isError(v: EvalResult): v is FormulaError {
  return typeof v === 'string' && v.startsWith('#')
}

interface EvalContext {
  worksheet: WorksheetModel
  /** 当前正在求值的单元格，用于循环引用检测 */
  visiting: Set<string>
}

/**
 * 求值 AST
 */
export function evaluateAST(node: ASTNode, ctx: EvalContext): EvalResult {
  switch (node.type) {
    case 'number':
      return node.value

    case 'string':
      return node.value

    case 'boolean':
      return node.value

    case 'cellRef': {
      const key = `${node.row}:${node.col}`
      if (ctx.visiting.has(key)) {
        return '#REF!' // 循环引用
      }
      ctx.visiting.add(key)
      const cell = ctx.worksheet.getCell(node.row, node.col)
      let result: EvalResult
      if (cell.formula) {
        // 递归求值公式单元格
        try {
          const ast = parseFormula(cell.formula)
          result = evaluateAST(ast, ctx)
        } catch {
          result = '#VALUE!'
        }
      } else {
        result = cell.value
      }
      ctx.visiting.delete(key)
      return result
    }

    case 'rangeRef': {
      // 范围在函数上下文中处理，单独使用返回错误
      return '#VALUE!'
    }

    case 'unaryOp': {
      const val = evaluateAST(node.operand, ctx)
      if (isError(val)) return val
      if (typeof val !== 'number') return '#VALUE!'
      return node.op === '-' ? -val : val
    }

    case 'binaryOp': {
      return evalBinaryOp(node, ctx)
    }

    case 'function': {
      return evalFunction(node, ctx)
    }
  }
}

function evalBinaryOp(node: Extract<ASTNode, { type: 'binaryOp' }>, ctx: EvalContext): EvalResult {
  const left = evaluateAST(node.left, ctx)
  if (isError(left)) return left
  const right = evaluateAST(node.right, ctx)
  if (isError(right)) return right

  // 比较运算符
  if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
    const cmp = compareValues(left, right)
    switch (node.op) {
      case '=': return cmp === 0
      case '<>': return cmp !== 0
      case '<': return cmp < 0
      case '>': return cmp > 0
      case '<=': return cmp <= 0
      case '>=': return cmp >= 0
    }
  }

  // 算术运算符要求数字
  if (typeof left !== 'number' || typeof right !== 'number') {
    return '#VALUE!'
  }

  switch (node.op) {
    case '+': return left + right
    case '-': return left - right
    case '*': return left * right
    case '/': return right === 0 ? '#DIV/0!' : left / right
    case '^': return Math.pow(left, right)
    default: return '#VALUE!'
  }
}

function compareValues(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b)
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0)
  return String(a).localeCompare(String(b))
}

/** 收集参数中的所有数字（展开范围引用） */
function collectNumbers(node: ASTNode, ctx: EvalContext): number[] {
  const nums: number[] = []
  collectValues(node, ctx, (v) => {
    if (typeof v === 'number') nums.push(v)
  })
  return nums
}

/** 收集参数中的所有值（展开范围引用） */
function collectValues(node: ASTNode, ctx: EvalContext, cb: (v: CellValue) => void): void {
  if (node.type === 'rangeRef') {
    for (let r = node.startRow; r <= node.endRow; r++) {
      for (let c = node.startCol; c <= node.endCol; c++) {
        const v = ctx.worksheet.getValue(r, c)
        if (v !== null && v !== undefined && v !== '') cb(v)
      }
    }
  } else {
    const v = evaluateAST(node, ctx)
    if (!isError(v) && v !== null && v !== undefined && v !== '') cb(v as CellValue)
  }
}

function evalFunction(node: Extract<ASTNode, { type: 'function' }>, ctx: EvalContext): EvalResult {
  const name = node.name

  switch (name) {
    case 'SUM': {
      const nums = node.args.flatMap((a) => collectNumbers(a, ctx))
      return nums.reduce((s, n) => s + n, 0)
    }

    case 'AVERAGE': {
      const nums = node.args.flatMap((a) => collectNumbers(a, ctx))
      if (nums.length === 0) return '#DIV/0!'
      return nums.reduce((s, n) => s + n, 0) / nums.length
    }

    case 'MIN': {
      const nums = node.args.flatMap((a) => collectNumbers(a, ctx))
      if (nums.length === 0) return '#N/A'
      return Math.min(...nums)
    }

    case 'MAX': {
      const nums = node.args.flatMap((a) => collectNumbers(a, ctx))
      if (nums.length === 0) return '#N/A'
      return Math.max(...nums)
    }

    case 'COUNT': {
      const nums = node.args.flatMap((a) => collectNumbers(a, ctx))
      return nums.length
    }

    case 'ROUND': {
      if (node.args.length < 1) return '#VALUE!'
      const num = evaluateAST(node.args[0], ctx)
      const digits = node.args[1] ? evaluateAST(node.args[1], ctx) : 0
      if (isError(num) || isError(digits)) return '#VALUE!'
      if (typeof num !== 'number' || typeof digits !== 'number') return '#VALUE!'
      const factor = Math.pow(10, digits)
      return Math.round(num * factor) / factor
    }

    case 'ABS': {
      if (node.args.length < 1) return '#VALUE!'
      const v = evaluateAST(node.args[0], ctx)
      if (isError(v)) return v
      if (typeof v !== 'number') return '#VALUE!'
      return Math.abs(v)
    }

    case 'IF': {
      if (node.args.length < 2) return '#VALUE!'
      const cond = evaluateAST(node.args[0], ctx)
      if (isError(cond)) return cond
      const isTrue = typeof cond === 'boolean' ? cond : !!cond
      if (isTrue) {
        return evaluateAST(node.args[1], ctx)
      }
      return node.args[2] ? evaluateAST(node.args[2], ctx) : false
    }

    default:
      return '#NAME?'
  }
}
