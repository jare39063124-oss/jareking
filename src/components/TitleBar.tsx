import { useState } from 'react'

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)

  const handleMinimize = () => window.jarekingAPI.window.minimize()
  const handleMaximize = async () => {
    const result = await window.jarekingAPI.window.maximize()
    setIsMaximized(result)
  }
  const handleClose = () => window.jarekingAPI.window.close()

  return (
    <div style={styles.titleBar}>
      <div className="title-bar-drag" style={styles.dragRegion}>
        <span className="title-bar-no-drag" style={styles.logo}>J</span>
        <span style={styles.title}>jareking</span>
      </div>
      <div style={styles.controls}>
        <button className="title-bar-btn title-bar-no-drag" style={styles.controlBtn} onClick={handleMinimize} title="最小化">
          —
        </button>
        <button className="title-bar-btn title-bar-no-drag" style={styles.controlBtn} onClick={handleMaximize} title="最大化">
          {isMaximized ? '❐' : '☐'}
        </button>
        <button className="title-bar-btn close title-bar-no-drag" style={styles.controlBtn} onClick={handleClose} title="关闭">
          ✕
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  titleBar: {
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
    borderBottom: '1px solid #e4e7ed',
    userSelect: 'none',
    flexShrink: 0,
  },
  dragRegion: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    flex: 1,
    height: '100%',
  },
  logo: {
    width: 22,
    height: 22,
    borderRadius: 5,
    backgroundColor: '#2b7fff',
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 13,
    color: '#606266',
  },
  controls: {
    display: 'flex',
    height: '100%',
  },
  controlBtn: {
    width: 46,
    height: '100%',
    border: 'none',
    background: 'transparent',
    fontSize: 13,
    color: '#606266',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
}
