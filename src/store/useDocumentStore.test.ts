import { describe, it, expect, beforeEach } from 'vitest'
import { useDocumentStore } from './useDocumentStore'

describe('多标签文档管理', () => {
  beforeEach(() => {
    useDocumentStore.setState({ tabs: [], activeTabId: null })
  })

  it('可同时打开多个文档标签并切换', () => {
    const { newTab, setActiveTab } = useDocumentStore.getState()
    newTab('spreadsheet')
    newTab('writer')
    newTab('presentation')

    let state = useDocumentStore.getState()
    expect(state.tabs).toHaveLength(3)
    // 最后一个打开的是活动标签
    expect(state.activeTabId).toBe(state.tabs[2].id)

    // 切换到第一个标签
    setActiveTab(state.tabs[0].id)
    state = useDocumentStore.getState()
    expect(state.activeTabId).toBe(state.tabs[0].id)
  })

  it('每个标签的文档状态独立', () => {
    const { newTab, setTabDirty, setTabData } = useDocumentStore.getState()
    newTab('spreadsheet')
    newTab('writer')

    const [tab1, tab2] = useDocumentStore.getState().tabs

    setTabDirty(tab1.id, true)
    setTabData(tab1.id, { value: '表格数据' })
    setTabData(tab2.id, { value: '文字数据' })

    const state = useDocumentStore.getState()
    expect(state.tabs[0].isDirty).toBe(true)
    expect(state.tabs[1].isDirty).toBe(false)
    expect(state.tabs[0].data).toEqual({ value: '表格数据' })
    expect(state.tabs[1].data).toEqual({ value: '文字数据' })
  })

  it('关闭活动标签后切换到相邻标签', () => {
    const { newTab, closeTab } = useDocumentStore.getState()
    newTab('spreadsheet')
    newTab('writer')
    newTab('pdf')

    let state = useDocumentStore.getState()
    const middleId = state.tabs[1].id
    closeTab(middleId)

    state = useDocumentStore.getState()
    expect(state.tabs).toHaveLength(2)
    // 活动标签应切换到剩余标签之一
    expect(state.activeTabId).not.toBeNull()
    expect(state.tabs.find((t) => t.id === state.activeTabId)).toBeDefined()
  })

  it('关闭所有标签后 activeTabId 为 null', () => {
    const { newTab, closeTab } = useDocumentStore.getState()
    newTab('spreadsheet')
    const state = useDocumentStore.getState()
    closeTab(state.tabs[0].id)

    expect(useDocumentStore.getState().tabs).toHaveLength(0)
    expect(useDocumentStore.getState().activeTabId).toBeNull()
  })

  it('新建标签时可关联文件路径，标题为文件名', () => {
    const { newTab } = useDocumentStore.getState()
    newTab('spreadsheet', 'C:/docs/budget.xlsx')

    const tab = useDocumentStore.getState().tabs[0]
    expect(tab.filePath).toBe('C:/docs/budget.xlsx')
    expect(tab.title).toBe('budget.xlsx')
  })

  it('setTabFilePath 更新文件路径和标题', () => {
    const { newTab, setTabFilePath } = useDocumentStore.getState()
    newTab('spreadsheet')
    const tab = useDocumentStore.getState().tabs[0]

    setTabFilePath(tab.id, 'D:/work/report.xlsx')

    const updated = useDocumentStore.getState().tabs[0]
    expect(updated.filePath).toBe('D:/work/report.xlsx')
    expect(updated.title).toBe('report.xlsx')
  })
})
