import { useRef, useEffect, useState, useCallback } from 'react'
import type { WorksheetModel } from '../model/WorksheetModel'
import type { CellAddress, CellRange } from '../model/types'

interface SpreadsheetGridProps {
  worksheet: WorksheetModel
  selectedCell: CellAddress | null
  selectedRange: CellRange | null
  onSelectCell: (cell: CellAddress) => void
  onSelectRange: (range: CellRange) => void
  onEditCell: (cell: CellAddress, value: string) => void
}

const ROW_HEADER_WIDTH = 42
const COL_HEADER_HEIGHT = 24
const HEADER_BG = '#f5f6f8'
const HEADER_BORDER = '#dcdfe6'
const GRID_LINE = '#e8eaed'
const SELECTED_BG = 'rgba(43, 127, 255, 0.08)'
const SELECTED_BORDER = '#2b7fff'

export function SpreadsheetGrid({
  worksheet,
  selectedCell,
  selectedRange,
  onSelectCell,
  onSelectRange,
  onEditCell,
}: SpreadsheetGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [editing, setEditing] = useState<{ cell: CellAddress; value: string } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef<CellAddress | null>(null)
  // 列宽拖拽状态
  const [resizingCol, setResizingCol] = useState<number | null>(null)
  const resizeStartXRef = useRef(0)
  const resizeStartWidthRef = useRef(0)

  // 容器尺寸监听
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect
      setSize({ width: cr.width, height: cr.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 渲染 Canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = size.width * dpr
    canvas.height = size.height * dpr
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    const gridWidth = size.width - ROW_HEADER_WIDTH
    const gridHeight = size.height - COL_HEADER_HEIGHT

    // 计算列的 x 偏移
    const colX: number[] = []
    let xAcc = 0
    for (let c = 0; c < worksheet.colCount; c++) {
      colX.push(xAcc)
      xAcc += worksheet.getColWidth(c)
    }
    const totalColWidth = xAcc

    // 计算行的 y 偏移
    const rowY: number[] = []
    let yAcc = 0
    for (let r = 0; r < worksheet.rowCount; r++) {
      rowY.push(yAcc)
      yAcc += worksheet.getRowHeight(r)
    }
    const totalRowHeight = yAcc

    // 二分查找可视区域起止列
    const startCol = binarySearch(colX, scroll.left)
    const endCol = Math.min(worksheet.colCount - 1, binarySearch(colX, scroll.left + gridWidth) + 1)
    const startRow = binarySearch(rowY, scroll.top)
    const endRow = Math.min(worksheet.rowCount - 1, binarySearch(rowY, scroll.top + gridHeight) + 1)

    ctx.clearRect(0, 0, size.width, size.height)

    // 列头
    ctx.fillStyle = HEADER_BG
    ctx.fillRect(ROW_HEADER_WIDTH, 0, gridWidth, COL_HEADER_HEIGHT)
    ctx.strokeStyle = HEADER_BORDER
    ctx.font = '12px Microsoft YaHei'
    ctx.fillStyle = '#606266'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let c = startCol; c <= endCol; c++) {
      const x = ROW_HEADER_WIDTH + (colX[c] - scroll.left)
      const w = worksheet.getColWidth(c)
      ctx.strokeRect(x + 0.5, 0.5, w, COL_HEADER_HEIGHT)
      ctx.fillText(colLabel(c), x + w / 2, COL_HEADER_HEIGHT / 2)
    }

    // 行头
    ctx.fillStyle = HEADER_BG
    ctx.fillRect(0, COL_HEADER_HEIGHT, ROW_HEADER_WIDTH, gridHeight)
    for (let r = startRow; r <= endRow; r++) {
      const y = COL_HEADER_HEIGHT + (rowY[r] - scroll.top)
      const h = worksheet.getRowHeight(r)
      ctx.strokeRect(0.5, y + 0.5, ROW_HEADER_WIDTH, h)
      ctx.fillText(String(r + 1), ROW_HEADER_WIDTH / 2, y + h / 2)
    }

    // 选中区域背景
    if (selectedRange) {
      const x = ROW_HEADER_WIDTH + (colX[selectedRange.start.col] - scroll.left)
      const y = COL_HEADER_HEIGHT + (rowY[selectedRange.start.row] - scroll.top)
      const w = colX[selectedRange.end.col] + worksheet.getColWidth(selectedRange.end.col) - colX[selectedRange.start.col]
      const h = rowY[selectedRange.end.row] + worksheet.getRowHeight(selectedRange.end.row) - rowY[selectedRange.start.row]
      ctx.fillStyle = SELECTED_BG
      ctx.fillRect(x, y, w, h)
    }

    // 单元格
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        const x = ROW_HEADER_WIDTH + (colX[c] - scroll.left)
        const y = COL_HEADER_HEIGHT + (rowY[r] - scroll.top)
        const w = worksheet.getColWidth(c)
        const h = worksheet.getRowHeight(r)

        const cell = worksheet.getCell(r, c)
        if (cell.style.bgColor && cell.style.bgColor !== '#ffffff') {
          ctx.fillStyle = cell.style.bgColor
          ctx.fillRect(x, y, w, h)
        }

        ctx.strokeStyle = GRID_LINE
        ctx.lineWidth = 1
        ctx.strokeRect(x + 0.5, y + 0.5, w, h)

        const value = cell.value
        if (value !== null && value !== undefined && value !== '') {
          const text = String(value)
          ctx.font = `${cell.style.bold ? 'bold ' : ''}${cell.style.fontSize || 12}px ${cell.style.fontFamily || 'Microsoft YaHei'}`
          ctx.fillStyle = cell.style.color || '#000000'

          let drawX = x + 6
          if (cell.style.hAlign === 'center') {
            ctx.textAlign = 'center'
            drawX = x + w / 2
          } else if (cell.style.hAlign === 'right') {
            ctx.textAlign = 'right'
            drawX = x + w - 6
          } else {
            ctx.textAlign = 'left'
          }

          const maxWidth = w - 12
          const metrics = ctx.measureText(text)
          const displayText = metrics.width > maxWidth ? text.slice(0, Math.floor(text.length * maxWidth / metrics.width)) + '…' : text
          ctx.fillText(displayText, drawX, y + h / 2)
        }
      }
    }

    // 选中单元格边框
    if (selectedCell && !editing) {
      const x = ROW_HEADER_WIDTH + (colX[selectedCell.col] - scroll.left)
      const y = COL_HEADER_HEIGHT + (rowY[selectedCell.row] - scroll.top)
      const w = worksheet.getColWidth(selectedCell.col)
      const h = worksheet.getRowHeight(selectedCell.row)
      ctx.strokeStyle = SELECTED_BORDER
      ctx.lineWidth = 2
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2)
    }

    // 存储总尺寸供滚动容器使用
    totalSizeRef.current = { width: totalColWidth, height: totalRowHeight, colX, rowY }
  }, [worksheet, scroll, size, selectedCell, selectedRange, editing])

  // 总尺寸和偏移缓存
  const totalSizeRef = useRef({ width: 0, height: 0, colX: [] as number[], rowY: [] as number[] })

  // 坐标转行列
  const pointToCell = useCallback((clientX: number, clientY: number): CellAddress | null => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return null
    const rect = scrollEl.getBoundingClientRect()
    const { colX, rowY } = totalSizeRef.current
    const x = clientX - rect.left + scrollEl.scrollLeft - ROW_HEADER_WIDTH
    const y = clientY - rect.top + scrollEl.scrollTop - COL_HEADER_HEIGHT
    if (x < 0 || y < 0) return null
    const col = binarySearch(colX, x, true)
    const row = binarySearch(rowY, y, true)
    if (col >= worksheet.colCount || row >= worksheet.rowCount) return null
    return { row, col }
  }, [worksheet.colCount, worksheet.rowCount])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const scrollEl = scrollRef.current
    if (!scrollEl) return
    const rect = scrollEl.getBoundingClientRect()
    const x = e.clientX - rect.left + scrollEl.scrollLeft

    // 检测是否点击列头右边界（列宽拖拽）
    if (e.clientY - rect.top < COL_HEADER_HEIGHT && x > ROW_HEADER_WIDTH) {
      const { colX } = totalSizeRef.current
      for (let c = 0; c < worksheet.colCount; c++) {
        const boundary = ROW_HEADER_WIDTH + colX[c] + worksheet.getColWidth(c)
        if (Math.abs(x - boundary) < 5) {
          setResizingCol(c)
          resizeStartXRef.current = e.clientX
          resizeStartWidthRef.current = worksheet.getColWidth(c)
          return
        }
      }
    }

    const cell = pointToCell(e.clientX, e.clientY)
    if (!cell) return
    dragStartRef.current = cell
    setIsDragging(true)
    onSelectCell(cell)
  }, [pointToCell, onSelectCell, worksheet])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (resizingCol !== null) {
      const delta = e.clientX - resizeStartXRef.current
      worksheet.setColWidth(resizingCol, resizeStartWidthRef.current + delta)
      setSize((s) => ({ ...s }))
      return
    }
    if (!isDragging || !dragStartRef.current) return
    const cell = pointToCell(e.clientX, e.clientY)
    if (!cell) return
    const start = dragStartRef.current
    onSelectRange({
      start: { row: Math.min(start.row, cell.row), col: Math.min(start.col, cell.col) },
      end: { row: Math.max(start.row, cell.row), col: Math.max(start.col, cell.col) },
    })
  }, [isDragging, resizingCol, pointToCell, onSelectRange, worksheet])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
    setResizingCol(null)
    dragStartRef.current = null
  }, [])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const cell = pointToCell(e.clientX, e.clientY)
    if (!cell) return
    const value = worksheet.getValue(cell.row, cell.col)
    setEditing({ cell, value: value !== null ? String(value) : '' })
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [pointToCell, worksheet])

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    setScroll({ top: target.scrollTop, left: target.scrollLeft })
  }, [])

  const commitEdit = useCallback(() => {
    if (editing) {
      onEditCell(editing.cell, editing.value)
      setEditing(null)
    }
  }, [editing, onEditCell])

  const cancelEdit = useCallback(() => {
    setEditing(null)
  }, [])

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitEdit()
      if (selectedCell) {
        const next = { row: Math.min(selectedCell.row + 1, worksheet.rowCount - 1), col: selectedCell.col }
        onSelectCell(next)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitEdit()
      if (selectedCell) {
        const next = { row: selectedCell.row, col: Math.min(selectedCell.col + 1, worksheet.colCount - 1) }
        onSelectCell(next)
      }
    }
  }, [commitEdit, cancelEdit, selectedCell, onSelectCell, worksheet.rowCount, worksheet.colCount])

  const totalWidth = ROW_HEADER_WIDTH + totalSizeRef.current.width
  const totalHeight = COL_HEADER_HEIGHT + totalSizeRef.current.height

  const editStyle: React.CSSProperties | null = editing
    ? {
        position: 'absolute',
        left: ROW_HEADER_WIDTH + (totalSizeRef.current.colX[editing.cell.col] - scroll.left) + 1,
        top: COL_HEADER_HEIGHT + (totalSizeRef.current.rowY[editing.cell.row] - scroll.top) + 1,
        width: worksheet.getColWidth(editing.cell.col) - 2,
        height: worksheet.getRowHeight(editing.cell.row) - 2,
        border: `1px solid ${SELECTED_BORDER}`,
        padding: '0 4px',
        fontSize: 12,
        outline: 'none',
        boxSizing: 'border-box',
      }
    : null

  return (
    <div ref={containerRef} style={styles.container}>
      <div
        ref={scrollRef}
        style={{ ...styles.scroll, cursor: resizingCol !== null ? 'col-resize' : 'cell' }}
        onScroll={handleScroll}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      >
        <div style={{ width: totalWidth, height: totalHeight, position: 'relative' }}>
          <canvas ref={canvasRef} style={{ position: 'sticky', top: 0, left: 0 }} />
          {editing && editStyle && (
            <input
              ref={inputRef}
              style={editStyle}
              value={editing.value}
              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
              onBlur={commitEdit}
              onKeyDown={handleInputKeyDown}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** 二分查找：找到 target 所在的区间索引 */
function binarySearch(arr: number[], target: number, inclusive = false): number {
  if (arr.length === 0) return 0
  let lo = 0
  let hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] === target) return mid
    if (arr[mid] < target) lo = mid + 1
    else hi = mid - 1
  }
  return inclusive ? Math.max(0, lo - 1) : Math.max(0, lo - 1)
}

function colLabel(idx: number): string {
  let result = ''
  let n = idx
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result
    n = Math.floor(n / 26) - 1
  }
  return result
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  scroll: {
    width: '100%',
    height: '100%',
    overflow: 'auto',
  },
}
