import { describe, it, expect } from 'vitest'
import { WorksheetModel } from './WorksheetModel'

describe('WorksheetModel', () => {
  it('设置/获取单元格值正确', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 'Hello')
    sheet.setValue(1, 0, 42)
    sheet.setValue(2, 0, true)

    expect(sheet.getValue(0, 0)).toBe('Hello')
    expect(sheet.getValue(1, 0)).toBe(42)
    expect(sheet.getValue(2, 0)).toBe(true)
  })

  it('未设置的单元格返回 null', () => {
    const sheet = new WorksheetModel()
    expect(sheet.getValue(5, 5)).toBeNull()
  })

  it('设置公式', () => {
    const sheet = new WorksheetModel()
    sheet.setFormula(0, 0, '=SUM(A1:A3)')
    expect(sheet.getFormula(0, 0)).toBe('=SUM(A1:A3)')
  })

  it('设置样式合并到现有样式', () => {
    const sheet = new WorksheetModel()
    sheet.setStyle(0, 0, { bold: true, color: '#ff0000' })
    const style = sheet.getStyle(0, 0)
    expect(style.bold).toBe(true)
    expect(style.color).toBe('#ff0000')
    // 默认值保留
    expect(style.fontSize).toBe(12)
    expect(style.fontFamily).toBe('Microsoft YaHei')
  })

  it('获取范围值', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 1)
    sheet.setValue(0, 1, 2)
    sheet.setValue(1, 0, 3)
    sheet.setValue(1, 1, 4)

    const values = sheet.getRangeValues({
      start: { row: 0, col: 0 },
      end: { row: 1, col: 1 },
    })
    expect(values).toEqual([
      [1, 2],
      [3, 4],
    ])
  })

  it('清空单元格', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 'data')
    sheet.clearCell(0, 0)
    expect(sheet.getValue(0, 0)).toBeNull()
  })
})

describe('WorkbookModel', () => {
  it('默认有一个 Sheet1 工作表', async () => {
    const { WorkbookModel } = await import('./WorkbookModel')
    const wb = new WorkbookModel()
    expect(wb.sheets).toHaveLength(1)
    expect(wb.sheets[0].name).toBe('Sheet1')
    expect(wb.activeSheet).toBe(wb.sheets[0])
  })

  it('添加工作表并切换活动表', async () => {
    const { WorkbookModel } = await import('./WorkbookModel')
    const wb = new WorkbookModel()
    const sheet2 = wb.addSheet('Sheet2')
    expect(wb.sheets).toHaveLength(2)
    expect(wb.activeSheet).toBe(sheet2)

    wb.setActiveSheet(0)
    expect(wb.activeSheet).toBe(wb.sheets[0])
  })

  it('撤销重做恢复单元格值', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 'original')
    sheet.setValue(0, 0, 'modified')
    expect(sheet.getValue(0, 0)).toBe('modified')

    expect(sheet.canUndo()).toBe(true)
    sheet.undo()
    expect(sheet.getValue(0, 0)).toBe('original')

    expect(sheet.canRedo()).toBe(true)
    sheet.redo()
    expect(sheet.getValue(0, 0)).toBe('modified')
  })

  it('多次撤销依次回退', () => {
    const sheet = new WorksheetModel()
    sheet.setValue(0, 0, 'v1')
    sheet.setValue(0, 0, 'v2')
    sheet.setValue(0, 0, 'v3')

    sheet.undo()
    expect(sheet.getValue(0, 0)).toBe('v2')
    sheet.undo()
    expect(sheet.getValue(0, 0)).toBe('v1')
    sheet.undo()
    expect(sheet.getValue(0, 0)).toBeNull()
  })
})
