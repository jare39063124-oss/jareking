import type { OfficeModule, RibbonConfig } from '../types'
import { SpreadsheetView } from './SpreadsheetView'

const ribbonConfig: RibbonConfig = {
  tabs: [
    {
      id: 'home',
      label: '开始',
      groups: [
        {
          id: 'clipboard',
          label: '剪贴板',
          buttons: [
            { id: 'paste', label: '粘贴' },
            { id: 'copy', label: '复制' },
            { id: 'cut', label: '剪切' },
          ],
        },
        {
          id: 'font',
          label: '字体',
          buttons: [
            { id: 'bold', label: 'B' },
            { id: 'italic', label: 'I' },
            { id: 'underline', label: 'U' },
          ],
        },
        {
          id: 'alignment',
          label: '对齐',
          buttons: [
            { id: 'align-left', label: '左' },
            { id: 'align-center', label: '中' },
            { id: 'align-right', label: '右' },
          ],
        },
      ],
    },
    { id: 'insert', label: '插入', groups: [] },
    { id: 'layout', label: '页面布局', groups: [] },
  ],
}

export const spreadsheetModule: OfficeModule = {
  id: 'spreadsheet',
  name: '表格',
  icon: '▦',
  color: '#10b981',
  createView: () => SpreadsheetView,
  ribbonConfig,
}
