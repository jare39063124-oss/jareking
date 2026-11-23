import { moduleRegistry } from './registry'
import { spreadsheetModule } from './spreadsheet'
import { writerModule } from './writer'
import { presentationModule } from './presentation'
import { pdfModule } from './pdf'

/** 应用启动时注册所有模块 */
export function registerAllModules(): void {
  moduleRegistry.register(spreadsheetModule)
  moduleRegistry.register(writerModule)
  moduleRegistry.register(presentationModule)
  moduleRegistry.register(pdfModule)
}
