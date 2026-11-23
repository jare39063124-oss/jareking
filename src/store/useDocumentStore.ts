import { create } from 'zustand'
import type { ModuleId } from '@/modules/types'

let tabIdCounter = 0

export interface DocumentTab {
  id: string
  module: ModuleId
  title: string
  filePath: string | null
  isDirty: boolean
  data: unknown
}

interface DocumentState {
  tabs: DocumentTab[]
  activeTabId: string | null
  newTab: (module: ModuleId, filePath?: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  setTabDirty: (id: string, dirty: boolean) => void
  setTabData: (id: string, data: unknown) => void
  setTabFilePath: (id: string, filePath: string) => void
}

function createTab(module: ModuleId, filePath?: string): DocumentTab {
  tabIdCounter += 1
  const names: Record<ModuleId, string> = {
    spreadsheet: '表格',
    writer: '文字',
    presentation: '演示',
    pdf: 'PDF',
  }
  return {
    id: `tab-${Date.now()}-${tabIdCounter}`,
    module,
    title: filePath ? filePath.split(/[\\/]/).pop() || `新建${names[module]}` : `新建${names[module]}`,
    filePath: filePath ?? null,
    isDirty: false,
    data: null,
  }
}

export const useDocumentStore = create<DocumentState>((set) => ({
  tabs: [],
  activeTabId: null,

  newTab: (module, filePath) => {
    const tab = createTab(module, filePath)
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id,
    }))
  },

  closeTab: (id) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id)
      if (idx === -1) return state

      const newTabs = state.tabs.filter((t) => t.id !== id)
      let newActive = state.activeTabId

      if (state.activeTabId === id) {
        if (newTabs.length === 0) {
          newActive = null
        } else {
          // 切换到相邻标签
          const neighborIdx = Math.min(idx, newTabs.length - 1)
          newActive = newTabs[neighborIdx].id
        }
      }

      return { tabs: newTabs, activeTabId: newActive }
    })
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  setTabDirty: (id, dirty) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, isDirty: dirty } : t)),
    })),

  setTabData: (id, data) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, data } : t)),
    })),

  setTabFilePath: (id, filePath) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id
          ? { ...t, filePath, title: filePath.split(/[\\/]/).pop() || t.title }
          : t,
      ),
    })),
}))
