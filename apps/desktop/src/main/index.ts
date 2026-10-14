import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { initAutoUpdater, checkForUpdates } from './updater.js';
import { initServices, type AppServices } from './services/bootstrap.js';
import type { AiConfigSaveInput } from './services/aiConfigService.js';
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
  const { account, library, db, ai } = services;

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

  // 存储管理（对标 WPS「C 盘垃圾不透明」痛点）：数据位置与占用一目了然
  ipcMain.handle(IPC.SYSTEM_STORAGE_INFO, async () => {
    const { app } = await import('electron');
    const dataDir = app.getPath('userData');
    let bytes = 0;
    const walk = async (dir: string): Promise<void> => {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else {
          const { stat } = await import('node:fs/promises');
          bytes += (await stat(p).catch(() => ({ size: 0 }))).size;
        }
      }
    };
    await walk(dataDir);
    return { dataDir, bytes, platform: process.platform };
  });
  ipcMain.handle(IPC.SYSTEM_OPEN_DATA_DIR, async () => {
    const { app, shell } = await import('electron');
    await shell.openPath(app.getPath('userData'));
  });

  // 读取文档文件字节（首页最近文档点击直达：主进程读盘 → 渲染进程解析）
  ipcMain.handle(IPC.DOC_READ_FILE, async (_event, payload?: { path?: string }) => {
    if (!payload?.path) return null;
    const { readFile } = await import('node:fs/promises');
    try {
      const buf = await readFile(payload.path);
      // 返回 Uint8Array（structured clone 可跨进程传递）
      return new Uint8Array(buf);
    } catch {
      return null; // 文件已被移动/删除：返回 null 由渲染层提示
    }
  });

  // 在系统文件管理器中定位文件（最近列表悬停「定位」）
  ipcMain.handle(IPC.DOC_REVEAL, async (_event, payload?: { path?: string }) => {
    if (!payload?.path) return false;
    const { shell } = await import('electron');
    shell.showItemInFolder(payload.path);
    return true;
  });

  // 打开外部链接（字体官方下载页）
  ipcMain.handle(IPC.SYSTEM_OPEN_EXTERNAL, async (_event, payload?: { url?: string }) => {
    if (!payload?.url || !/^https:\/\//i.test(payload.url)) return false;
    const { shell } = await import('electron');
    await shell.openExternal(payload.url);
    return true;
  });

  // AI 配置：列表 / 保存（含密钥加密）/ 删除 / 明文 Key 解析（单次调用注入）
  ipcMain.handle(IPC.AI_CONFIG_LIST, () => ai.list());
  ipcMain.handle(IPC.AI_CONFIG_SAVE, (_event, payload?: AiConfigSaveInput) => {
    if (!payload || !payload.name || !payload.kind || !payload.baseUrl) {
      throw new Error('AI 配置缺少必填字段');
    }
    return ai.save(payload);
  });
  ipcMain.handle(IPC.AI_CONFIG_DELETE, (_event, payload?: { id: string }) => {
    if (!payload?.id) return false;
    return ai.remove(payload.id);
  });
  ipcMain.handle(IPC.AI_KEY_RESOLVE, (_event, payload?: { id: string }) => {
    if (!payload?.id) return '';
    return ai.resolveKey(payload.id);
  });
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
    // jk-debug=1：启用渲染层调试钩子（自动化冒烟 / 开发检查用）
    const debugQuery = isDev || process.argv.includes('--jk-debug') ? 'jk-debug=1' : undefined;
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), debugQuery ? { search: debugQuery } : undefined);
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
