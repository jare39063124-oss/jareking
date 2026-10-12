import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { initAutoUpdater } from './updater.js';

// 注意：__dirname 由 electron-vite 在打包时注入（ESM 环境下可用），无需手动声明
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

/**
 * 待打开文件队列（T0.5 单实例锁完善）
 * 当已运行实例通过 second-instance 收到新实例转发的命令行参数时，
 * 将其中形如文件路径的参数暂存于此，供持久层/文档编排服务读取后打开对应文档。
 */
const pendingOpenFiles: string[] = [];

/**
 * 读取待打开文件列表（返回副本，避免外部直接改动内部队列）。
 * 持久层服务就绪后由编排 Agent 决定消费语义（读取即清空 or 保留）。
 */
export function getPendingOpenFiles(): string[] {
  return [...pendingOpenFiles];
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'jareking',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// 单实例锁：第二个实例启动时，其命令行参数（双击关联文件等）通过 second-instance 转发到本实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows 下 argv[0] 为可执行文件路径，其余为命令行参数；
    // 过滤掉可执行文件本身与开关类参数，其余视为待打开的文件路径
    const fileArgs = argv.filter((arg) => arg.length > 0 && arg !== process.execPath && !arg.startsWith('-'));
    if (fileArgs.length > 0) {
      pendingOpenFiles.push(...fileArgs);
    }

    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    initAutoUpdater();
    // TODO(persistence): initServices() 接入点，持久层服务就绪后由编排 Agent 取消注释
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
