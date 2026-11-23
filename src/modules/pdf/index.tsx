import type { OfficeModule, RibbonConfig } from '../types'
import { PlaceholderView } from '../shared/PlaceholderView'

const ribbonConfig: RibbonConfig = {
  tabs: [
    { id: 'view', label: '查看', groups: [] },
    { id: 'annotate', label: '标注', groups: [] },
  ],
}

export const pdfModule: OfficeModule = {
  id: 'pdf',
  name: 'PDF',
  icon: '📄',
  color: '#ef4444',
  createView: () => () => <PlaceholderView icon="📄" name="PDF" />,
  ribbonConfig,
}
