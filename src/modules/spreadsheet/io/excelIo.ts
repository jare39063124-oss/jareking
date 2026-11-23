import ExcelJS from 'exceljs'
import { WorkbookModel } from '../model/WorkbookModel'
import type { CellStyle, HorizontalAlign, VerticalAlign, CellValue } from '../model/types'

/**
 * 将 WorkbookModel 导出为 .xlsx ArrayBuffer
 */
export async function exportToXlsx(workbook: WorkbookModel): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'jareking'

  for (const sheet of workbook.sheets) {
    const ws = wb.addWorksheet(sheet.name)

    // 遍历所有已设置的单元格
    for (const [addr, cell] of sheet.iterateCells()) {
      const excelCell = ws.getCell(addr.row + 1, addr.col + 1)
      if (cell.formula) {
        excelCell.value = { formula: cell.formula.slice(1) } // 去掉开头的 =
      } else if (cell.value !== null) {
        excelCell.value = cell.value
      }
      // 写入样式
      applyStyleToExcel(excelCell, cell.style)
    }

    // 列宽
    for (let c = 0; c < sheet.colCount; c++) {
      const w = sheet.getColWidth(c)
      if (w !== 80) {
        ws.getColumn(c + 1).width = w / 7 // ExcelJS 宽度单位约为字符宽度
      }
    }
  }

  const buffer = await wb.xlsx.writeBuffer()
  return buffer as ArrayBuffer
}

/**
 * 从 .xlsx ArrayBuffer 导入为 WorkbookModel
 */
export async function importFromXlsx(buffer: ArrayBuffer): Promise<WorkbookModel> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)

  const workbook = new WorkbookModel()
  workbook.sheets = []

  wb.eachSheet((excelWs) => {
    const sheet = workbook.addSheet(excelWs.name)

    excelWs.eachRow((row, rowNumber) => {
      row.eachCell((cell, colNumber) => {
        const r = rowNumber - 1
        const c = colNumber - 1
        const ourCell = sheet.getCell(r, c)

        // 值
        const value = cell.value
        if (value && typeof value === 'object' && 'formula' in value) {
          ourCell.formula = '=' + (value as { formula: string }).formula
          const result = (value as { result?: CellValue }).result
          ourCell.value = result ?? null
        } else if (value !== null && value !== undefined) {
          ourCell.value = value as string | number | boolean
        }

        // 样式
        ourCell.style = readStyleFromExcel(cell)

        // 必须显式存储（getCell 返回的默认单元格不在 Map 中）
        sheet.setCell(r, c, ourCell)
      })
    })
  })

  return workbook
}

function applyStyleToExcel(cell: ExcelJS.Cell, style: CellStyle): void {
  cell.font = {
    name: style.fontFamily || 'Microsoft YaHei',
    size: style.fontSize || 12,
    bold: style.bold || false,
    italic: style.italic || false,
    underline: style.underline ? true : undefined,
    color: style.color ? { argb: style.color.replace('#', 'FF') } : undefined,
  }
  if (style.bgColor && style.bgColor !== '#ffffff') {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: style.bgColor.replace('#', 'FF') },
    }
  }
  if (style.hAlign || style.vAlign) {
    cell.alignment = {
      horizontal: style.hAlign as HorizontalAlign,
      vertical: style.vAlign as VerticalAlign,
    }
  }
}

function readStyleFromExcel(cell: ExcelJS.Cell): CellStyle {
  const style: CellStyle = {}
  if (cell.font) {
    if (cell.font.name) style.fontFamily = cell.font.name
    if (cell.font.size) style.fontSize = cell.font.size
    if (cell.font.bold !== undefined) style.bold = cell.font.bold
    if (cell.font.italic !== undefined) style.italic = cell.font.italic
    if (cell.font.underline) style.underline = true
    if (cell.font.color?.argb) style.color = '#' + cell.font.color.argb.slice(2)
  }
  if (cell.fill && cell.fill.type === 'pattern' && cell.fill.fgColor?.argb) {
    style.bgColor = '#' + cell.fill.fgColor.argb.slice(2)
  }
  if (cell.alignment) {
    if (cell.alignment.horizontal) style.hAlign = cell.alignment.horizontal as HorizontalAlign
    if (cell.alignment.vertical) style.vAlign = cell.alignment.vertical as VerticalAlign
  }
  return style
}
