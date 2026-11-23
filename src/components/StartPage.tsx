import { useEffect, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import type { ModuleId } from '@/modules/types'

const modules: { type: ModuleId; name: string; desc: string; icon: string; color: string }[] = [
  { type: 'spreadsheet', name: '表格', desc: '电子表格编辑与公式计算', icon: '▦', color: '#10b981' },
  { type: 'writer', name: '文字', desc: '文档编辑与排版', icon: '✎', color: '#2b7fff' },
  { type: 'presentation', name: '演示', desc: '幻灯片制作与演示', icon: '▤', color: '#f59e0b' },
  { type: 'pdf', name: 'PDF', desc: 'PDF 阅读与标注', icon: '📄', color: '#ef4444' },
]

interface RecentFile {
  path: string
  name: string
}

export function StartPage() {
  const openModule = useAppStore((s) => s.openModule)
  const openFile = useAppStore((s) => s.openFile)
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([])

  useEffect(() => {
    window.jarekingAPI.recentFiles.get().then(setRecentFiles).catch(() => setRecentFiles([]))
  }, [])

  const handleOpenRecent = (file: RecentFile) => {
    // 根据扩展名判断模块
    const ext = file.name.split('.').pop()?.toLowerCase()
    const module: ModuleId = ext === 'xlsx' ? 'spreadsheet' : 'spreadsheet'
    openFile(module, file.path)
  }

  return (
    <div style={styles.page}>
      <div style={styles.sidebar}>
        <div style={styles.sidebarHeader}>开始</div>
        <div style={styles.sidebarItem}>最近</div>
      </div>

      <div style={styles.content}>
        <div style={styles.sectionTitle}>新建</div>
        <div style={styles.cards}>
          {modules.map((m) => (
            <div
              key={m.type}
              className="module-card"
              style={styles.card}
              onClick={() => openModule(m.type)}
            >
              <div style={{ ...styles.cardIcon, backgroundColor: m.color }}>{m.icon}</div>
              <div style={styles.cardName}>{m.name}</div>
              <div style={styles.cardDesc}>{m.desc}</div>
            </div>
          ))}
        </div>

        <div style={{ ...styles.sectionTitle, marginTop: 32 }}>最近文件</div>
        {recentFiles.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>📂</div>
            <div style={styles.emptyText}>暂无最近文件</div>
            <div style={styles.emptyHint}>点击上方模块新建文档</div>
          </div>
        ) : (
          <div style={styles.recentList}>
            {recentFiles.map((f) => (
              <div
                key={f.path}
                style={styles.recentItem}
                onClick={() => handleOpenRecent(f)}
              >
                <div style={styles.recentIcon}>▦</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.recentName}>{f.name}</div>
                  <div style={styles.recentPath}>{f.path}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex',
    flex: 1,
    height: '100%',
    backgroundColor: '#f5f6f8',
  },
  sidebar: {
    width: 180,
    backgroundColor: '#fff',
    borderRight: '1px solid #e4e7ed',
    padding: '16px 0',
  },
  sidebarHeader: {
    fontSize: 16,
    fontWeight: 600,
    color: '#303133',
    padding: '0 20px 12px',
    borderBottom: '1px solid #ebeef5',
    marginBottom: 8,
  },
  sidebarItem: {
    padding: '8px 20px',
    fontSize: 14,
    color: '#606266',
    cursor: 'pointer',
  },
  content: {
    flex: 1,
    padding: '28px 40px',
    overflow: 'auto',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: 600,
    color: '#303133',
    marginBottom: 16,
  },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: 16,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    border: '1px solid #e4e7ed',
    padding: '24px 20px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
  },
  cardIcon: {
    width: 56,
    height: 56,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 26,
    color: '#fff',
    marginBottom: 14,
  },
  cardName: {
    fontSize: 16,
    fontWeight: 600,
    color: '#303133',
    marginBottom: 6,
  },
  cardDesc: {
    fontSize: 12,
    color: '#909399',
  },
  emptyState: {
    backgroundColor: '#fff',
    borderRadius: 8,
    border: '1px dashed #dcdfe6',
    padding: '48px 20px',
    textAlign: 'center',
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 12,
    opacity: 0.5,
  },
  emptyText: {
    fontSize: 14,
    color: '#909399',
    marginBottom: 4,
  },
  emptyHint: {
    fontSize: 12,
    color: '#c0c4cc',
  },
  recentList: {
    backgroundColor: '#fff',
    borderRadius: 8,
    border: '1px solid #e4e7ed',
    overflow: 'hidden',
  },
  recentItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 16px',
    borderBottom: '1px solid #f2f6fc',
    cursor: 'pointer',
  },
  recentIcon: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: '#10b981',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
  },
  recentName: {
    fontSize: 14,
    color: '#303133',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  recentPath: {
    fontSize: 12,
    color: '#909399',
    marginTop: 2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
}
