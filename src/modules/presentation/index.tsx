import type { OfficeModule, RibbonConfig } from '../types'
import { PlaceholderView } from '../shared/PlaceholderView'

const ribbonConfig: RibbonConfig = {
  tabs: [
    { id: 'home', label: '开始', groups: [] },
    { id: 'insert', label: '插入', groups: [] },
    { id: 'design', label: '设计', groups: [] },
  ],
}

export const presentationModule: OfficeModule = {
  id: 'presentation',
  name: '演示',
  icon: '▤',
  color: '#f59e0b',
  createView: () => () => <PlaceholderView icon="▤" name="演示" />,
  ribbonConfig,
}
