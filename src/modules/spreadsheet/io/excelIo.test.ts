import { describe, it, expect } from 'vitest'
import { WorkbookModel } from '../model/WorkbookModel'
import { exportToXlsx, importFromXlsx } from './excelIo'

describe('.xlsx 导入导出', () => {
  it('保存为 .xlsx 后重新打开，单元格值一致', async () => {
    const wb = new WorkbookModel()
    const sheet = wb.activeSheet
    sheet.setValue(0, 0, 'Hello')
    sheet.setValue(1, 0, 42)
    sheet.setValue(2, 0, true)

    const buffer = await exportToXlsx(wb)
    const imported = await importFromXlsx(buffer)

    expect(imported.activeSheet.getValue(0, 0)).toBe('Hello')
    expect(imported.activeSheet.getValue(1, 0)).toBe(42)
    expect(imported.activeSheet.getValue(2, 0)).toBe(true)
  })

  it('公式结果在重新打开后正确', async () => {
    const wb = new WorkbookModel()
    const sheet = wb.activeSheet
    sheet.setValue(0, 0, 10)
    sheet.setValue(1, 0, 20)
    sheet.setFormula(2, 0, '=A1+A2')

    const buffer = await exportToXlsx(wb)
    const imported = await importFromXlsx(buffer)

    // 导入后公式应保留
    expect(imported.activeSheet.getFormula(2, 0)).toBe('=A1+A2')
    // 重算后结果正确
    const { FormulaEngine } = await import('../formula/FormulaEngine')
    const engine = new FormulaEngine(imported.activeSheet)
    engine.recalculateAll()
    expect(imported.activeSheet.getValue(2, 0)).toBe(30)
  })

  it('基础格式（字体/颜色/对齐）往返一致', async () => {
    const wb = new WorkbookModel()
    const sheet = wb.activeSheet
    sheet.setValue(0, 0, 'styled')
    sheet.setStyle(0, 0, { bold: true, color: '#ff0000', hAlign: 'center' })

    const buffer = await exportToXlsx(wb)
    const imported = await importFromXlsx(buffer)

    const style = imported.activeSheet.getStyle(0, 0)
    expect(style.bold).toBe(true)
    expect(style.color?.toLowerCase()).toBe('#ff0000')
    expect(style.hAlign).toBe('center')
  })
})
