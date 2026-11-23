import { tokenize, type Token } from './tokenizer'
import { colToIndex } from '../model/address'
import type { ASTNode } from './ast'

/**
 * 递归下降解析器
 * 优先级（低到高）：比较(=,<>,<,>,<=,>=) -> 加减 -> 乘除 -> 幂 -> 一元 -> 原子
 */
export function parseFormula(formula: string): ASTNode {
  const tokens = tokenize(formula)
  let pos = 0

  const peek = (): Token => tokens[pos]
  const next = (): Token => tokens[pos++]

  const parseExpression = (): ASTNode => parseComparison()

  const parseComparison = (): ASTNode => {
    let left = parseAddSub()
    while (peek().type === 'operator' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().value)) {
      const op = next().value
      const right = parseAddSub()
      left = { type: 'binaryOp', op, left, right }
    }
    return left
  }

  const parseAddSub = (): ASTNode => {
    let left = parseMulDiv()
    while (peek().type === 'operator' && (peek().value === '+' || peek().value === '-')) {
      const op = next().value
      const right = parseMulDiv()
      left = { type: 'binaryOp', op, left, right }
    }
    return left
  }

  const parseMulDiv = (): ASTNode => {
    let left = parsePower()
    while (peek().type === 'operator' && (peek().value === '*' || peek().value === '/')) {
      const op = next().value
      const right = parsePower()
      left = { type: 'binaryOp', op, left, right }
    }
    return left
  }

  const parsePower = (): ASTNode => {
    let left = parseUnary()
    while (peek().type === 'operator' && peek().value === '^') {
      next()
      const right = parseUnary()
      left = { type: 'binaryOp', op: '^', left, right }
    }
    return left
  }

  const parseUnary = (): ASTNode => {
    if (peek().type === 'operator' && (peek().value === '-' || peek().value === '+')) {
      const op = next().value
      const operand = parseUnary()
      return { type: 'unaryOp', op, operand }
    }
    return parsePrimary()
  }

  const parsePrimary = (): ASTNode => {
    const tok = peek()

    if (tok.type === 'number') {
      next()
      return { type: 'number', value: parseFloat(tok.value) }
    }

    if (tok.type === 'string') {
      next()
      return { type: 'string', value: tok.value }
    }

    if (tok.type === 'identifier') {
      next()
      if (tok.value.toUpperCase() === 'TRUE') return { type: 'boolean', value: true }
      if (tok.value.toUpperCase() === 'FALSE') return { type: 'boolean', value: false }
      // 函数调用
      if (peek().type === 'paren' && peek().value === '(') {
        next() // (
        const args: ASTNode[] = []
        if (peek().type !== 'paren' || peek().value !== ')') {
          args.push(parseExpression())
          while (peek().type === 'comma') {
            next()
            args.push(parseExpression())
          }
        }
        if (peek().type !== 'paren' || peek().value !== ')') {
          throw new Error('Expected )')
        }
        next() // )
        return { type: 'function', name: tok.value.toUpperCase(), args }
      }
      throw new Error(`Unexpected identifier: ${tok.value}`)
    }

    if (tok.type === 'cellRef') {
      next()
      const match = tok.value.match(/^([A-Za-z]+)(\d+)$/)!
      return {
        type: 'cellRef',
        col: colToIndex(match[1].toUpperCase()),
        row: parseInt(match[2], 10) - 1,
      }
    }

    if (tok.type === 'rangeRef') {
      next()
      const [start, end] = tok.value.split(':')
      const sm = start.match(/^([A-Za-z]+)(\d+)$/)!
      const em = end.match(/^([A-Za-z]+)(\d+)$/)!
      return {
        type: 'rangeRef',
        startCol: colToIndex(sm[1].toUpperCase()),
        startRow: parseInt(sm[2], 10) - 1,
        endCol: colToIndex(em[1].toUpperCase()),
        endRow: parseInt(em[2], 10) - 1,
      }
    }

    if (tok.type === 'paren' && tok.value === '(') {
      next()
      const expr = parseExpression()
      if (peek().type !== 'paren' || peek().value !== ')') {
        throw new Error('Expected )')
      }
      next()
      return expr
    }

    throw new Error(`Unexpected token: ${tok.value}`)
  }

  const ast = parseExpression()
  if (peek().type !== 'eof') {
    throw new Error(`Unexpected trailing token: ${peek().value}`)
  }
  return ast
}
