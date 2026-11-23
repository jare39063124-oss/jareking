/** 公式 AST 节点类型 */
export type ASTNode =
  | NumberNode
  | StringNode
  | BooleanNode
  | CellRefNode
  | RangeRefNode
  | FunctionNode
  | BinaryOpNode
  | UnaryOpNode

export interface NumberNode {
  type: 'number'
  value: number
}

export interface StringNode {
  type: 'string'
  value: string
}

export interface BooleanNode {
  type: 'boolean'
  value: boolean
}

/** 单元格引用，如 A1 */
export interface CellRefNode {
  type: 'cellRef'
  row: number
  col: number
}

/** 范围引用，如 A1:B3 */
export interface RangeRefNode {
  type: 'rangeRef'
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

/** 函数调用，如 SUM(A1:A3) */
export interface FunctionNode {
  type: 'function'
  name: string
  args: ASTNode[]
}

/** 二元运算，如 A1+B1 */
export interface BinaryOpNode {
  type: 'binaryOp'
  op: string
  left: ASTNode
  right: ASTNode
}

/** 一元运算，如 -A1 */
export interface UnaryOpNode {
  type: 'unaryOp'
  op: string
  operand: ASTNode
}
