import { WorksheetModel } from './WorksheetModel'

/**
 * 工作簿数据模型
 * 包含多个工作表
 */
export class WorkbookModel {
  sheets: WorksheetModel[]
  activeSheetIndex: number

  constructor() {
    this.sheets = [new WorksheetModel('Sheet1')]
    this.activeSheetIndex = 0
  }

  /** 获取活动工作表 */
  get activeSheet(): WorksheetModel {
    return this.sheets[this.activeSheetIndex]
  }

  /** 添加工作表 */
  addSheet(name?: string): WorksheetModel {
    const sheet = new WorksheetModel(name ?? `Sheet${this.sheets.length + 1}`)
    this.sheets.push(sheet)
    this.activeSheetIndex = this.sheets.length - 1
    return sheet
  }

  /** 删除工作表 */
  removeSheet(index: number): void {
    if (this.sheets.length <= 1) return
    this.sheets.splice(index, 1)
    if (this.activeSheetIndex >= this.sheets.length) {
      this.activeSheetIndex = this.sheets.length - 1
    }
  }

  /** 切换活动工作表 */
  setActiveSheet(index: number): void {
    if (index >= 0 && index < this.sheets.length) {
      this.activeSheetIndex = index
    }
  }
}
