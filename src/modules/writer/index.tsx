import type { OfficeModule, RibbonConfig } from '../types'
import { PlaceholderView } from '../shared/PlaceholderView'

const ribbonConfig: RibbonConfig = {
  tabs: [
    { id: 'home', label: '开始', groups: [] },
    { id: 'insert', label: '插入', groups: [] },
    { id: 'layout', label: '页面布局', groups: [] },
  ],
}

export const writerModule: OfficeModule = {
  id: 'writer',
  name: '文字',
  icon: '✎',
  color: '#2b7fff',
  createView: () => () => <PlaceholderView icon="✎" name="文字" />,
  ribbonConfig,
}
