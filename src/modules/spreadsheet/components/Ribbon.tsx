import { useState } from 'react'
import type { WorksheetModel } from '../model/WorksheetModel'
import type { CellRange, CellStyle, HorizontalAlign } from '../model/types'
import { iterateRange } from '../model/address'

interface RibbonProps {
  worksheet: WorksheetModel
  selectedRange: CellRange | null
  onStyleChange: () => void
  formatBrushActive: boolean
  onStartFormatBrush: () => void
  onCancelFormatBrush: () => void
}

/**
 * 电子表格 Ribbon 工具栏
 */
export function Ribbon({
  worksheet,
  selectedRange,
  onStyleChange,
  formatBrushActive,
  onStartFormatBrush,
  onCancelFormatBrush,
}: RibbonProps) {
  const [activeTab, setActiveTab] = useState('home')

  const applyStyle = (style: Partial<CellStyle>) => {
    if (!selectedRange) return
    for (const addr of iterateRange(selectedRange)) {
      worksheet.setStyle(addr.row, addr.col, style)
    }
    onStyleChange()
  }

  const toggleBold = () => {
    if (!selectedRange) return
    const cell = worksheet.getCell(selectedRange.start.row, selectedRange.start.col)
    applyStyle({ bold: !cell.style.bold })
  }

  const toggleItalic = () => {
    if (!selectedRange) return
    const cell = worksheet.getCell(selectedRange.start.row, selectedRange.start.col)
    applyStyle({ italic: !cell.style.italic })
  }

  const toggleUnderline = () => {
    if (!selectedRange) return
    const cell = worksheet.getCell(selectedRange.start.row, selectedRange.start.col)
    applyStyle({ underline: !cell.style.underline })
  }

  const setAlign = (hAlign: HorizontalAlign) => applyStyle({ hAlign })
  const setTextColor = (color: string) => applyStyle({ color })
  const setBgColor = (color: string) => applyStyle({ bgColor: color })

  const tabs = [
    { id: 'home', label: '开始' },
    { id: 'insert', label: '插入' },
    { id: 'layout', label: '页面布局' },
  ]

  return (
    <div style={styles.ribbon}>
      {/* 选项卡 */}
      <div style={styles.tabs}>
        {tabs.map((t) => (
          <div
            key={t.id}
            style={{ ...styles.tab, ...(activeTab === t.id ? styles.tabActive : {}) }}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </div>
        ))}
      </div>

      {/* 功能区 */}
      <div style={styles.content}>
        {activeTab === 'home' && (
          <>
            {/* 剪贴板组 */}
            <div style={styles.group}>
              <div style={styles.groupLabel}>剪贴板</div>
              <div style={styles.groupBtns}>
                <button
                  style={btnStyle(formatBrushActive)}
                  onClick={formatBrushActive ? onCancelFormatBrush : onStartFormatBrush}
                  title={formatBrushActive ? '取消格式刷' : '格式刷'}
                >
                  🖌
                </button>
              </div>
            </div>

            {/* 字体组 */}
            <div style={styles.group}>
              <div style={styles.groupLabel}>字体</div>
              <div style={styles.groupBtns}>
                <button style={btnStyle(false)} onClick={toggleBold} title="粗体">
                  <b>B</b>
                </button>
                <button style={btnStyle(false)} onClick={toggleItalic} title="斜体">
                  <i>I</i>
                </button>
                <button style={btnStyle(false)} onClick={toggleUnderline} title="下划线">
                  <u>U</u>
                </button>
                <ColorPicker label="A" title="文字颜色" onPick={setTextColor} defaultColor="#000000" />
                <ColorPicker label="▦" title="填充色" onPick={setBgColor} defaultColor="#ffff00" />
              </div>
            </div>

            {/* 对齐组 */}
            <div style={styles.group}>
              <div style={styles.groupLabel}>对齐</div>
              <div style={styles.groupBtns}>
                <button style={btnStyle(false)} onClick={() => setAlign('left')} title="左对齐">
                  ⬅
                </button>
                <button style={btnStyle(false)} onClick={() => setAlign('center')} title="居中">
                  ⬌
                </button>
                <button style={btnStyle(false)} onClick={() => setAlign('right')} title="右对齐">
                  ➡
                </button>
              </div>
            </div>
          </>
        )}

        {activeTab === 'insert' && (
          <div style={styles.group}>
            <div style={styles.groupLabel}>插入</div>
            <div style={styles.groupBtns}>
              <span style={styles.disabled}>图表（开发中）</span>
            </div>
          </div>
        )}

        {activeTab === 'layout' && (
          <div style={styles.group}>
            <div style={styles.groupLabel}>页面布局</div>
            <div style={styles.groupBtns}>
              <span style={styles.disabled}>（开发中）</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 颜色选择器（简化版，提供几个预设颜色） */
function ColorPicker({
  label,
  title,
  onPick,
  defaultColor,
}: {
  label: string
  title: string
  onPick: (color: string) => void
  defaultColor: string
}) {
  const colors = ['#000000', '#ff0000', '#00b050', '#0070c0', '#ffff00', '#ff00ff', '#7f7f7f', '#ffffff']
  const [open, setOpen] = useState(false)

  return (
    <div style={{ position: 'relative' }}>
      <button style={btnStyle(false)} title={title} onClick={() => setOpen((o) => !o)}>
        <span style={{ borderBottom: `3px solid ${defaultColor}`, paddingBottom: 2 }}>{label}</span>
      </button>
      {open && (
        <div style={styles.colorPanel}>
          {colors.map((c) => (
            <div
              key={c}
              style={{ ...styles.colorSwatch, backgroundColor: c }}
              onClick={() => {
                onPick(c)
                setOpen(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const btnStyle = (active: boolean): React.CSSProperties => ({
  width: 28,
  height: 26,
  border: '1px solid #dcdfe6',
  background: active ? '#e8f0fe' : '#fff',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 13,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
})

const styles: Record<string, React.CSSProperties> = {
  ribbon: {
    backgroundColor: '#fff',
    borderBottom: '1px solid #e4e7ed',
    flexShrink: 0,
  },
  tabs: {
    display: 'flex',
    height: 30,
    borderBottom: '1px solid #e4e7ed',
    padding: '0 8px',
  },
  tab: {
    padding: '0 16px',
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
    fontSize: 13,
    color: '#606266',
    borderBottom: '2px solid transparent',
  },
  tabActive: {
    color: '#2b7fff',
    borderBottomColor: '#2b7fff',
  },
  content: {
    display: 'flex',
    padding: '6px 12px',
    gap: 16,
    minHeight: 62,
    alignItems: 'flex-start',
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid #ebeef5',
    paddingRight: 16,
  },
  groupLabel: {
    fontSize: 11,
    color: '#909399',
    marginTop: 4,
    textAlign: 'center',
  },
  groupBtns: {
    display: 'flex',
    gap: 2,
    alignItems: 'center',
    height: 36,
  },
  disabled: {
    fontSize: 12,
    color: '#c0c4cc',
  },
  colorPanel: {
    position: 'absolute',
    top: '100%',
    left: 0,
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 18px)',
    gap: 2,
    padding: 4,
    background: '#fff',
    border: '1px solid #dcdfe6',
    borderRadius: 4,
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
    zIndex: 100,
  },
  colorSwatch: {
    width: 18,
    height: 18,
    borderRadius: 2,
    cursor: 'pointer',
    border: '1px solid #dcdfe6',
  },
}
