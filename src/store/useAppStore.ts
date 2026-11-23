import { create } from 'zustand'
import { useDocumentStore } from './useDocumentStore'
import type { ModuleId } from '@/modules/types'

export interface AppState {
  /** 返回起始页 */
  goHome: () => void
  /** 打开指定模块（创建新标签） */
  openModule: (module: ModuleId) => void
  /** 打开文件（创建新标签并加载） */
  openFile: (module: ModuleId, filePath: string) => void
}

export const useAppStore = create<AppState>(() => ({
  goHome: () => {
    useDocumentStore.setState({ tabs: [], activeTabId: null })
  },
  openModule: (module) => {
    useDocumentStore.getState().newTab(module)
  },
  openFile: (module, filePath) => {
    useDocumentStore.getState().newTab(module, filePath)
  },
}))
