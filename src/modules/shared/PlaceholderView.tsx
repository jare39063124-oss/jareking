interface PlaceholderViewProps {
  icon: string
  name: string
}

/** 非表格模块的占位视图，显示"开发中" */
export function PlaceholderView({ icon, name }: PlaceholderViewProps) {
  return (
    <div style={styles.container}>
      <div style={styles.placeholder}>
        <div style={styles.icon}>{icon}</div>
        <h2 style={styles.title}>{name}</h2>
        <p style={styles.desc}>该模块正在开发中，敬请期待</p>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  placeholder: {
    textAlign: 'center',
    color: '#909399',
  },
  icon: {
    fontSize: 64,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    color: '#303133',
    marginBottom: 8,
  },
  desc: {
    fontSize: 14,
  },
}
