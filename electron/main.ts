import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'

let mainWindow: BrowserWindow | null = null

/** 最近文件存储路径 */
function recentFilesPath(): string {
  return path.join(app.getPath('userData'), 'recent-files.json')
}

/** 读取最近文件列表 */
async function readRecentFiles(): Promise<{ path: string; name: string }[]> {
  try {
    const data = await fs.readFile(recentFilesPath(), 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

/** 写入最近文件列表 */
async function writeRecentFiles(files: { path: string; name: string }[]): Promise<void> {
  await fs.writeFile(recentFilesPath(), JSON.stringify(files, null, 2), 'utf-8')
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    frame: false,
    show: false,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../index.html'))
  }
}

// IPC: ping-pong
ipcMain.handle('app:ping', () => 'pong')

// IPC: 窗口控制
ipcMain.handle('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
  return mainWindow?.isMaximized() ?? false
})
ipcMain.handle('window:close', () => mainWindow?.close())
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

// IPC: 文件操作
ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const filePath = result.filePaths[0]
  const data = await fs.readFile(filePath)
  return { filePath, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }
})

// 按路径直接读取文件（不弹对话框，用于最近文件打开）
ipcMain.handle('file:read-by-path', async (_e, filePath: string) => {
  const data = await fs.readFile(filePath)
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
})

ipcMain.handle('file:save', async (_e, data: ArrayBuffer, filePath?: string) => {
  let targetPath = filePath
  if (!targetPath) {
    const result = await dialog.showSaveDialog({
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }],
      defaultPath: '未命名.xlsx',
    })
    if (result.canceled || !result.filePath) return null
    targetPath = result.filePath
    if (!targetPath.endsWith('.xlsx')) targetPath += '.xlsx'
  }
  await fs.writeFile(targetPath, Buffer.from(data))
  // 保存成功后加入最近文件列表
  const files = await readRecentFiles()
  const filename = path.basename(targetPath)
  const filtered = files.filter((f) => f.path !== targetPath)
  filtered.unshift({ path: targetPath, name: filename })
  await writeRecentFiles(filtered.slice(0, 10))
  return targetPath
})

// IPC: 最近文件列表
ipcMain.handle('recent-files:get', async () => readRecentFiles())
ipcMain.handle('recent-files:clear', async () => writeRecentFiles([]))

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
