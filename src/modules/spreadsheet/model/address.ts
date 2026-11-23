import type { CellAddress, CellRange } from './types'

/**
 * 列标转列索引（0-indexed）
 * A -> 0, B -> 1, ..., Z -> 25, AA -> 26
 */
export function colToIndex(col: string): number {
  let result = 0
  for (let i = 0; i < col.length; i++) {
    const code = col.charCodeAt(i) - 64 // 'A' = 65 -> 1
    if (code < 1 || code > 26) {
      throw new Error(`Invalid column letter: ${col}`)
    }
    result = result * 26 + code
  }
  return result - 1
}

/**
 * 列索引转列标
 * 0 -> A, 1 -> B, ..., 25 -> Z, 26 -> AA
 */
export function indexToCol(idx: number): string {
  if (idx < 0) throw new Error(`Invalid column index: ${idx}`)
  let result = ''
  let n = idx
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result
    n = Math.floor(n / 26) - 1
  }
  return result
}

/**
 * 解析单元格引用，返回 0-indexed 地址
 * "A1" -> { row: 0, col: 0 }
 * "B2" -> { row: 1, col: 1 }
 */
export function parseCellRef(ref: string): CellAddress {
  const match = ref.match(/^([A-Za-z]+)(\d+)$/)
  if (!match) {
    throw new Error(`Invalid cell reference: ${ref}`)
  }
  const col = colToIndex(match[1].toUpperCase())
  const row = parseInt(match[2], 10) - 1
  return { row, col }
}

/**
 * 解析范围引用
 * "A1:B3" -> { start: {row:0,col:0}, end: {row:2,col:1} }
 */
export function parseRange(ref: string): CellRange {
  const parts = ref.split(':')
  if (parts.length !== 2) {
    throw new Error(`Invalid range reference: ${ref}`)
  }
  const start = parseCellRef(parts[0].trim())
  const end = parseCellRef(parts[1].trim())
  // 规范化：确保 start 在左上，end 在右下
  return {
    start: {
      row: Math.min(start.row, end.row),
      col: Math.min(start.col, end.col),
    },
    end: {
      row: Math.max(start.row, end.row),
      col: Math.max(start.col, end.col),
    },
  }
}

/** 生成单元格存储键 */
export function cellKey(row: number, col: number): string {
  return `${row}:${col}`
}

/** 地址转引用字符串 */
export function addressToRef(addr: CellAddress): string {
  return `${indexToCol(addr.col)}${addr.row + 1}`
}

/** 遍历范围内所有单元格地址 */
export function* iterateRange(range: CellRange): Generator<CellAddress> {
  for (let r = range.start.row; r <= range.end.row; r++) {
    for (let c = range.start.col; c <= range.end.col; c++) {
      yield { row: r, col: c }
    }
  }
}
