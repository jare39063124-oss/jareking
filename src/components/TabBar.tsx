import { useDocumentStore } from '@/store/useDocumentStore'

export function TabBar() {
  const tabs = useDocumentStore((s) => s.tabs)
  const activeTabId = useDocumentStore((s) => s.activeTabId)
  const setActiveTab = useDocumentStore((s) => s.setActiveTab)
  const closeTab = useDocumentStore((s) => s.closeTab)
  const goHome = useAppStore((s) => s.goHome)

  return (
    <div style={styles.tabBar}>
      <div style={styles.homeBtn} onClick={goHome} title="返回起始页">
        🏠
      </div>
      <div style={styles.tabs}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              style={{ ...styles.tab, ...(isActive ? styles.tabActive : {}) }}
              onClick={() => setActiveTab(tab.id)}
            >
              <span style={styles.tabTitle}>
                {tab.isDirty && <span style={styles.dirtyDot}>●</span>}
                {tab.title}
              </span>
              <button
                style={styles.closeBtn}
                onClick={(e) => {
                  e.stopPropagation()
                  if (tab.isDirty) {
                    const ok = window.confirm(`"${tab.title}" 有未保存的更改，是否关闭？`)
                    if (!ok) return
                  }
                  closeTab(tab.id)
                }}
                title="关闭标签"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 延迟引用避免循环依赖
import { useAppStore } from '@/store/useAppStore'

const styles: Record<string, React.CSSProperties> = {
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    height: 34,
    backgroundColor: '#f5f6f8',
    borderBottom: '1px solid #e4e7ed',
    paddingLeft: 8,
    flexShrink: 0,
  },
  homeBtn: {
    width: 32,
    height: 26,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    borderRadius: 4,
    marginRight: 4,
    fontSize: 16,
  },
  tabs: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    flex: 1,
    overflow: 'hidden',
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 12px',
    height: 28,
    backgroundColor: '#e8eaed',
    borderRadius: '4px 4px 0 0',
    cursor: 'pointer',
    minWidth: 120,
    maxWidth: 200,
    border: '1px solid transparent',
  },
  tabActive: {
    backgroundColor: '#fff',
    borderColor: '#dcdfe6',
    borderBottomColor: '#fff',
  },
  tabTitle: {
    fontSize: 13,
    color: '#303133',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  dirtyDot: {
    fontSize: 10,
    color: '#2b7fff',
  },
  closeBtn: {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 12,
    color: '#909399',
    padding: '0 2px',
    lineHeight: 1,
  },
}
