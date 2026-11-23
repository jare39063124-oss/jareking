import { describe, it, expect } from 'vitest'
import { WorksheetModel } from '../model/WorksheetModel'
import { FormulaEngine } from './FormulaEngine'

describe('公式引擎', () => {
  it('=SUM(A1:A3) 对 A1=10,A2=20,A3=30 返回 60', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 10) // A1
    sheet.setValue(1, 0, 20) // A2
    sheet.setValue(2, 0, 30) // A3
    const engine = new FormulaEngine(sheet)
    const result = engine.evaluate('=SUM(A1:A3)')
    expect(result).toBe(60)
  })

  it('=AVERAGE(A1:A3) 返回 20', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 10)
    sheet.setValue(1, 0, 20)
    sheet.setValue(2, 0, 30)
    const engine = new FormulaEngine(sheet)
    expect(engine.evaluate('=AVERAGE(A1:A3)')).toBe(20)
  })

  it('=MIN(A1:A3) 和 =MAX(A1:A3)', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 10)
    sheet.setValue(1, 0, 20)
    sheet.setValue(2, 0, 30)
    const engine = new FormulaEngine(sheet)
    expect(engine.evaluate('=MIN(A1:A3)')).toBe(10)
    expect(engine.evaluate('=MAX(A1:A3)')).toBe(30)
  })

  it('=IF(A1>10,"大","小") 对 A1=15 返回 "大"', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 15)
    const engine = new FormulaEngine(sheet)
    expect(engine.evaluate('=IF(A1>10,"大","小")')).toBe('大')
  })

  it('=IF(A1>10,"大","小") 对 A1=5 返回 "小"', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 5)
    const engine = new FormulaEngine(sheet)
    expect(engine.evaluate('=IF(A1>10,"大","小")')).toBe('小')
  })

  it('=1/0 返回 #DIV/0!', () => {
    const sheet = new WorksheetModel()
    const engine = new FormulaEngine(sheet)
    expect(engine.evaluate('=1/0')).toBe('#DIV/0!')
  })

  it('算术运算 + - * / ^', () => {
    const sheet = new WorksheetModel()
    const engine = new FormulaEngine(sheet)
    expect(engine.evaluate('=2+3')).toBe(5)
    expect(engine.evaluate('=10-4')).toBe(6)
    expect(engine.evaluate('=3*4')).toBe(12)
    expect(engine.evaluate('=10/4')).toBe(2.5)
    expect(engine.evaluate('=2^3')).toBe(8)
  })

  it('比较运算', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 10)
    const engine = new FormulaEngine(sheet)
    expect(engine.evaluate('=A1=10')).toBe(true)
    expect(engine.evaluate('=A1>5')).toBe(true)
    expect(engine.evaluate('=A1<5')).toBe(false)
  })

  it('修改 A1 后引用 A1 的公式自动重算', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 10) // A1
    sheet.setValue(1, 0, 20) // A2
    sheet.setFormula(2, 0, '=A1+A2') // A3 = A1+A2
    const engine = new FormulaEngine(sheet)
    engine.recalculateAll()
    expect(sheet.getValue(2, 0)).toBe(30)

    // 修改 A1
    sheet.setValue(0, 0, 5)
    engine.recalculateDependents(0, 0)
    expect(sheet.getValue(2, 0)).toBe(25)
  })

  it('ROUND 和 ABS', () => {
    const sheet = new WorksheetModel()
    const engine = new FormulaEngine(sheet)
    expect(engine.evaluate('=ROUND(3.14159,2)')).toBe(3.14)
    expect(engine.evaluate('=ABS(-5)')).toBe(5)
  })

  it('未知函数返回 #NAME?', () => {
    const sheet = new WorksheetModel()
    const engine = new FormulaEngine(sheet)
    expect(engine.evaluate('=FOO(1)')).toBe('#NAME?')
  })
})
