import { useState, useCallback, useRef, useEffect } from 'react'
import { WorkbookModel } from './model/WorkbookModel'
import { SpreadsheetGrid } from './components/SpreadsheetGrid'
import { Ribbon } from './components/Ribbon'
import { FormulaEngine } from './formula/FormulaEngine'
import { exportToXlsx, importFromXlsx } from './io/excelIo'
import { useDocumentStore } from '@/store/useDocumentStore'
import type { CellAddress, CellRange, CellStyle, CellValue } from './model/types'
import { iterateRange } from './model/address'

export function SpreadsheetView() {
  const [workbook, setWorkbook] = useState(() => new WorkbookModel())
  const worksheet = workbook.activeSheet
  const engineRef = useRef(new FormulaEngine(worksheet))
  const [selectedCell, setSelectedCell] = useState<CellAddress | null>(null)
  const [selectedRange, setSelectedRange] = useState<CellRange | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [, setVersion] = useState(0)
  const rerender = useCallback(() => setVersion((v) => v + 1), [])
  const [formatBrush, setFormatBrush] = useState<CellStyle | null>(null)
  // 剪贴板（内部复制粘贴）
  const clipboardRef = useRef<{ value: CellValue; formula: string | null }[][] | null>(null)

  const activeTabId = useDocumentStore((s) => s.activeTabId)
  const setTabFilePath = useDocumentStore((s) => s.setTabFilePath)

  // 挂载时：如果当前标签有关联文件路径，则加载该文件
  useEffect(() => {
    let cancelled = false
    const store = useDocumentStore.getState()
    const tab = store.tabs.find((t) => t.id === store.activeTabId)
    if (tab?.filePath) {
      ;(async () => {
        try {
          const data = await window.jarekingAPI.file.readByPath(tab.filePath!)
          if (cancelled) return
          const wb = await importFromXlsx(data)
          const engine = new FormulaEngine(wb.activeSheet)
          engine.recalculateAll()
          if (!cancelled) {
            setWorkbook(wb)
            engineRef.current = engine
            setFilePath(tab.filePath!)
          }
        } catch (e) {
          console.error('加载文件失败', e)
        }
      })()
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 用 ref 保存最新状态供快捷键回调使用
  const selCellRef = useRef(selectedCell)
  const selRangeRef = useRef(selectedRange)
  selCellRef.current = selectedCell
  selRangeRef.current = selectedRange

  // 切换 workbook 时重建公式引擎
  const switchWorkbook = useCallback((wb: WorkbookModel, path: string | null) => {
    setWorkbook(wb)
    engineRef.current = new FormulaEngine(wb.activeSheet)
    setFilePath(path)
    setSelectedCell(null)
    setSelectedRange(null)
  }, [])

  const handleSelectCell = useCallback((cell: CellAddress) => {
    setSelectedCell(cell)
    setSelectedRange({ start: cell, end: cell })
  }, [])

  const handleSelectRange = useCallback((range: CellRange) => {
    setSelectedRange(range)
    setSelectedCell(range.end)
  }, [])

  const handleEditCell = useCallback((cell: CellAddress, value: string) => {
    const engine = engineRef.current
    if (value.startsWith('=')) {
      worksheet.setFormula(cell.row, cell.col, value)
      const result = engine.evaluateCell(cell.row, cell.col)
      worksheet.getCell(cell.row, cell.col).value = result
    } else {
      if (value === '') {
        worksheet.setValue(cell.row, cell.col, null)
      } else {
        const num = Number(value)
        worksheet.setValue(cell.row, cell.col, !isNaN(num) && value.trim() !== '' ? num : value)
      }
    }
    engine.recalculateDependents(cell.row, cell.col)
    rerender()
  }, [worksheet, rerender])

  // 格式刷：选中单元格时如果格式刷激活，应用样式
  const handleSelectCellWithBrush = useCallback((cell: CellAddress) => {
    if (formatBrush && selectedRange) {
      // 将源样式应用到选中区域
      for (const addr of iterateRange(selectedRange)) {
        worksheet.setStyle(addr.row, addr.col, formatBrush)
      }
      setFormatBrush(null)
      rerender()
    }
    handleSelectCell(cell)
  }, [formatBrush, selectedRange, worksheet, handleSelectCell, rerender])

  const startFormatBrush = useCallback(() => {
    if (selectedCell) {
      const style = worksheet.getStyle(selectedCell.row, selectedCell.col)
      setFormatBrush(style)
    }
  }, [selectedCell, worksheet])

  // 保存
  const handleSave = useCallback(async () => {
    try {
      const buffer = await exportToXlsx(workbook)
      const savedPath = await window.jarekingAPI.file.save(buffer, filePath ?? undefined)
      if (savedPath) {
        setFilePath(savedPath)
        if (activeTabId) setTabFilePath(activeTabId, savedPath)
      }
    } catch (e) {
      console.error('保存失败', e)
    }
  }, [workbook, filePath, activeTabId, setTabFilePath])

  // 打开
  const handleOpen = useCallback(async () => {
    try {
      const result = await window.jarekingAPI.file.open()
      if (!result) return
      const wb = await importFromXlsx(result.data)
      // 重算公式
      const engine = new FormulaEngine(wb.activeSheet)
      engine.recalculateAll()
      switchWorkbook(wb, result.filePath)
      if (activeTabId) setTabFilePath(activeTabId, result.filePath)
    } catch (e) {
      console.error('打开失败', e)
    }
  }, [switchWorkbook, activeTabId, setTabFilePath])

  // 另存为
  const handleSaveAs = useCallback(async () => {
    try {
      const buffer = await exportToXlsx(workbook)
      const savedPath = await window.jarekingAPI.file.save(buffer)
      if (savedPath) {
        setFilePath(savedPath)
        if (activeTabId) setTabFilePath(activeTabId, savedPath)
      }
    } catch (e) {
      console.error('另存为失败', e)
    }
  }, [workbook, activeTabId, setTabFilePath])

  // 快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const cell = selCellRef.current
      const range = selRangeRef.current

      // Ctrl+Z 撤销
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        if (worksheet.undo()) {
          engineRef.current.recalculateAll()
          rerender()
        }
        return
      }
      // Ctrl+Y / Ctrl+Shift+Z 重做
      if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault()
        if (worksheet.redo()) {
          engineRef.current.recalculateAll()
          rerender()
        }
        return
      }
      // Delete 清除
      if (e.key === 'Delete' && !ctrl) {
        e.preventDefault()
        if (range) {
          for (const addr of iterateRange(range)) worksheet.clearCell(addr.row, addr.col)
          engineRef.current.recalculateAll()
          rerender()
        } else if (cell) {
          worksheet.clearCell(cell.row, cell.col)
          engineRef.current.recalculateAll()
          rerender()
        }
        return
      }
      // Ctrl+C 复制
      if (ctrl && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        const src = range ?? (cell ? { start: cell, end: cell } : null)
        if (src) {
          const data: { value: CellValue; formula: string | null }[][] = []
          for (let r = src.start.row; r <= src.end.row; r++) {
            const row: { value: CellValue; formula: string | null }[] = []
            for (let c = src.start.col; c <= src.end.col; c++) {
              const cc = worksheet.getCell(r, c)
              row.push({ value: cc.value, formula: cc.formula })
            }
            data.push(row)
          }
          clipboardRef.current = data
        }
        return
      }
      // Ctrl+V 粘贴
      if (ctrl && e.key.toLowerCase() === 'v' && clipboardRef.current && cell) {
        e.preventDefault()
        const data = clipboardRef.current
        for (let i = 0; i < data.length; i++) {
          for (let j = 0; j < data[i].length; j++) {
            const item = data[i][j]
            const r = cell.row + i
            const c = cell.col + j
            if (item.formula) worksheet.setFormula(r, c, item.formula)
            else worksheet.setValue(r, c, item.value)
          }
        }
        engineRef.current.recalculateAll()
        rerender()
        return
      }
      // Ctrl+X 剪切
      if (ctrl && e.key.toLowerCase() === 'x' && range) {
        e.preventDefault()
        const data: { value: CellValue; formula: string | null }[][] = []
        for (let r = range.start.row; r <= range.end.row; r++) {
          const row: { value: CellValue; formula: string | null }[] = []
          for (let c = range.start.col; c <= range.end.col; c++) {
            const cc = worksheet.getCell(r, c)
            row.push({ value: cc.value, formula: cc.formula })
          }
          data.push(row)
        }
        clipboardRef.current = data
        for (const addr of iterateRange(range)) worksheet.clearCell(addr.row, addr.col)
        engineRef.current.recalculateAll()
        rerender()
        return
      }
      // Ctrl+B 粗体
      if (ctrl && e.key.toLowerCase() === 'b' && range) {
        e.preventDefault()
        for (const addr of iterateRange(range)) {
          const cur = worksheet.getStyle(addr.row, addr.col)
          worksheet.setStyle(addr.row, addr.col, { bold: !cur.bold })
        }
        rerender()
        return
      }
      // Ctrl+I 斜体
      if (ctrl && e.key.toLowerCase() === 'i' && range) {
        e.preventDefault()
        for (const addr of iterateRange(range)) {
          const cur = worksheet.getStyle(addr.row, addr.col)
          worksheet.setStyle(addr.row, addr.col, { italic: !cur.italic })
        }
        rerender()
        return
      }
      // Ctrl+U 下划线
      if (ctrl && e.key.toLowerCase() === 'u' && range) {
        e.preventDefault()
        for (const addr of iterateRange(range)) {
          const cur = worksheet.getStyle(addr.row, addr.col)
          worksheet.setStyle(addr.row, addr.col, { underline: !cur.underline })
        }
        rerender()
        return
      }
      // Ctrl+S 保存
      if (ctrl && e.key.toLowerCase() === 's' && !e.shiftKey) {
        e.preventDefault()
        handleSave()
        return
      }
      // Ctrl+Shift+S 另存为
      if (ctrl && e.key.toLowerCase() === 's' && e.shiftKey) {
        e.preventDefault()
        handleSaveAs()
        return
      }
      // Ctrl+O 打开
      if (ctrl && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        handleOpen()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [worksheet, rerender, handleSave, handleSaveAs, handleOpen])

  return (
    <div style={styles.container}>
      {/* 文件操作栏 */}
      <div style={styles.fileBar}>
        <button style={fileBtnStyle} onClick={handleOpen}>打开</button>
        <button style={fileBtnStyle} onClick={handleSave}>
          保存{filePath ? ` (${filePath.split(/[\\/]/).pop()})` : ''}
        </button>
        <button style={fileBtnStyle} onClick={handleSaveAs}>另存为</button>
      </div>
      <Ribbon
        worksheet={worksheet}
        selectedRange={selectedRange}
        onStyleChange={rerender}
        formatBrushActive={formatBrush !== null}
        onStartFormatBrush={startFormatBrush}
        onCancelFormatBrush={() => setFormatBrush(null)}
      />
      <SpreadsheetGrid
        worksheet={worksheet}
        selectedCell={selectedCell}
        selectedRange={selectedRange}
        onSelectCell={handleSelectCellWithBrush}
        onSelectRange={handleSelectRange}
        onEditCell={handleEditCell}
      />
    </div>
  )
}

const fileBtnStyle: React.CSSProperties = {
  padding: '4px 12px',
  border: '1px solid #dcdfe6',
  borderRadius: 3,
  background: '#fff',
  cursor: 'pointer',
  fontSize: 12,
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  fileBar: {
    display: 'flex',
    gap: 8,
    padding: '4px 12px',
    borderBottom: '1px solid #ebeef5',
    backgroundColor: '#fafafa',
  },
}

