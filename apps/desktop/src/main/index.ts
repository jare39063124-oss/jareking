import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { initAutoUpdater, checkForUpdates } from './updater.js';
import { initServices, type AppServices } from './services/bootstrap.js';
import { IPC } from '../ipc/channels.js';

// 注意：__dirname 由 electron-vite 在打包时注入（ESM 环境下可用），无需手动声明
const isDev = !app.isPackaged;

// 规范 userData 目录名（开发模式下 Electron 默认用包名 @jareking/desktop，
// 设回 jareking 让本地数据库/自动保存到 AppData/Roaming/jareking）
app.setName('jareking');

/** 主进程全部本地服务实例（initServices 完成后赋值，供 IPC 处理器使用） */
let services: AppServices | null = null;

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

/**
 * 注册主进程 ↔ 渲染进程 IPC 处理器。
 * 全部操作映射到 packages/core 服务层（账户 / 积分 / 文档库 / 自动保存），
 * db:query 仅暴露白名单只读/设置操作，杜绝任意 SQL 注入。
 * 依赖模块级 `services` 已初始化完成（whenReady 内先 initServices 再调用本函数）。
 */
function registerIpcHandlers(): void {
  if (!services) return;
  const { account, library, db } = services;

  // 账户：获取并引导本地账户 + 注册礼（幂等）
  ipcMain.handle(IPC.ACCOUNT_GET, () => account.bootstrapAccount());

  // 积分：余额 + 流水分页
  ipcMain.handle(
    IPC.ACCOUNT_POINTS,
    (_event, payload?: { limit?: number; offset?: number }) => {
      const limit = payload?.limit ?? 20;
      const offset = payload?.offset ?? 0;
      return {
        balance: account.points.getBalance(),
        entries: account.points.listEntries(limit, offset),
      };
    },
  );

  // 最近文件：列表
  ipcMain.handle(IPC.DOC_RECENT_LIST, () => library.library.listRecent());

  // 最近文件：置顶/取消置顶
  ipcMain.handle(
    IPC.DOC_RECENT_PIN,
    (_event, payload?: { documentId: string; pinned: boolean }) => {
      if (!payload?.documentId) return false;
      library.library.pin(payload.documentId, payload.pinned ? 1 : 0);
      return true;
    },
  );

  // 自动保存：写快照（编辑器防抖调用）
  ipcMain.handle(
    IPC.DOC_AUTOSAVE_SAVE,
    (_event, payload?: { documentId: string; data: unknown }) => {
      if (!payload?.documentId) return null;
      return library.autosave.saveSnapshot(payload.documentId, payload.data);
    },
  );

  // 自动保存：列出待恢复快照（崩溃后重启时由渲染进程读取并提示恢复）
  ipcMain.handle(IPC.DOC_AUTOSAVE_PENDING, () =>
    library.autosave.listPendingRecovery(),
  );

  // 数据库：白名单操作（settings 读写）；其余 op 抛错
  ipcMain.handle(IPC.DB_QUERY, (_event, payload?: { op: string; params?: unknown[] }) => {
    const op = payload?.op;
    const params = (payload?.params as (string | number)[]) ?? [];
    switch (op) {
      case 'settingsGet':
        return db.getSetting(String(params[0] ?? ''));
      case 'settingsSet':
        db.setSetting(String(params[0]), String(params[1] ?? ''));
        return true;
      default:
        throw new Error(`未知的 db 操作: ${String(op)}`);
    }
  });

  // 更新：手动触发检查（仅打包模式生效）
  ipcMain.handle(IPC.UPDATER_CHECK, async () => checkForUpdates());
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

  app.whenReady().then(async () => {
    // 持久层服务接入：初始化数据库 / 账户 / 文档库（幂等单例），并引导本地账户与注册礼
    services = await initServices();
    services.account.bootstrapAccount();
    registerIpcHandlers();

    createWindow();
    initAutoUpdater();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
