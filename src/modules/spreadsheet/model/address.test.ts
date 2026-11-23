import { describe, it, expect } from 'vitest'
import { colToIndex, indexToCol, parseCellRef, parseRange, iterateRange } from './address'

describe('地址解析', () => {
  it('A1 解析为 {row:0, col:0}', () => {
    expect(parseCellRef('A1')).toEqual({ row: 0, col: 0 })
  })

  it('B2 解析为 {row:1, col:1}', () => {
    expect(parseCellRef('B2')).toEqual({ row: 1, col: 1 })
  })

  it('Z1 解析为 {row:0, col:25}', () => {
    expect(parseCellRef('Z1')).toEqual({ row: 0, col: 25 })
  })

  it('AA1 解析为 {row:0, col:26}', () => {
    expect(parseCellRef('AA1')).toEqual({ row: 0, col: 26 })
  })

  it('列标与索引互转', () => {
    expect(colToIndex('A')).toBe(0)
    expect(indexToCol(0)).toBe('A')
    expect(colToIndex('Z')).toBe(25)
    expect(indexToCol(25)).toBe('Z')
    expect(colToIndex('AA')).toBe(26)
    expect(indexToCol(26)).toBe('AA')
    expect(colToIndex('AB')).toBe(27)
    expect(indexToCol(27)).toBe('AB')
  })

  it('范围 A1:B3 解析为 6 个单元格集合', () => {
    const range = parseRange('A1:B3')
    const cells = Array.from(iterateRange(range))
    expect(cells).toHaveLength(6)
    expect(cells).toEqual([
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 2, col: 0 },
      { row: 2, col: 1 },
    ])
  })

  it('反向范围 B3:A1 规范化', () => {
    const range = parseRange('B3:A1')
    expect(range.start).toEqual({ row: 0, col: 0 })
    expect(range.end).toEqual({ row: 2, col: 1 })
  })
})
