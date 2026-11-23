import { useEffect } from 'react'
import { TitleBar } from '@/components/TitleBar'
import { TabBar } from '@/components/TabBar'
import { StartPage } from '@/components/StartPage'
import { ModuleContainer } from '@/components/ModuleContainer'
import { useDocumentStore } from '@/store/useDocumentStore'
import { registerAllModules } from '@/modules'

function App() {
  const tabs = useDocumentStore((s) => s.tabs)
  const activeTabId = useDocumentStore((s) => s.activeTabId)

  // 应用启动时注册所有模块
  useEffect(() => {
    registerAllModules()
  }, [])

  const activeTab = tabs.find((t) => t.id === activeTabId)

  return (
    <div style={styles.app}>
      <TitleBar />
      {tabs.length > 0 && <TabBar />}
      {!activeTab ? (
        <StartPage />
      ) : (
        <ModuleContainer moduleId={activeTab.module} />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    backgroundColor: '#f5f6f8',
  },
}

export default App
