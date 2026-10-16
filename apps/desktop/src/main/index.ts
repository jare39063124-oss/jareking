import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { initAutoUpdater, checkForUpdates } from './updater.js';
import { initServices, type AppServices } from './services/bootstrap.js';
import type { AiConfigSaveInput } from './services/aiConfigService.js';
import { convertOfficeToPdf } from './services/officeConvert.js';
import { htmlToPdfBuffer } from './services/pdfExport.js';
import type { OfficeKind } from '../shared/officePdfScript.js';
import type { HtmlPdfRequest } from '../shared/pdfPrint.js';
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
  const { account, library, db, ai, macro, metering } = services;

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
      library.library.pin(payload.documentId, payload.pinned);
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

  // 崩溃恢复中心：保存「文件字节备份」（编辑器防抖调用；bytes 为 docx/xlsx/pptx 字节）
  ipcMain.handle(
    IPC.DOC_BACKUP_SAVE,
    (
      _event,
      payload?: { documentId?: string; module?: string; title?: string; bytes?: Uint8Array },
    ) => {
      if (!payload?.documentId || !payload.module) return null;
      const bytes = payload.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(0);
      return library.autosave.saveBackup(
        payload.documentId,
        { module: payload.module, title: payload.title ?? '' },
        bytes,
      );
    },
  );

  // 崩溃恢复中心：列出全部「文件字节备份」（按保存时间倒序）
  ipcMain.handle(IPC.DOC_BACKUP_LIST, () => library.autosave.listBackups());

  // 崩溃恢复中心：恢复单条备份（物化到 userData/autosaves/recovered，走渲染层待打开机制直达打开）
  ipcMain.handle(IPC.DOC_BACKUP_RECOVER, (_event, payload?: { documentId?: string }) => {
    if (!payload?.documentId) return null;
    const recoveredDir = join(app.getPath('userData'), 'autosaves', 'recovered');
    return library.autosave.resolveBackup(payload.documentId, recoveredDir);
  });

  // 崩溃恢复中心：丢弃单条备份（删快照文件 + 库记录）
  ipcMain.handle(IPC.DOC_BACKUP_DISCARD, (_event, payload?: { documentId?: string }) => {
    if (!payload?.documentId) return false;
    return library.autosave.discardBackup(payload.documentId);
  });

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

  // Office 转 PDF（Word/Excel/PPT → PDF）：用本机 WPS/Office 的 COM 组件转换，纯本地零服务端。
  // 渲染层经文件选择拿到路径后调用；outputPath 缺省则与输入同目录换 .pdf。
  ipcMain.handle(
    IPC.PDF_OFFICE_TO_PDF,
    async (
      _event,
      payload?: { kind?: OfficeKind; inputPath?: string; outputPath?: string },
    ) => {
      if (!payload?.inputPath || !payload?.kind) throw new Error('缺少 inputPath 或 kind');
      return convertOfficeToPdf(payload.kind, payload.inputPath, payload.outputPath);
    },
  );

  // 导出 PDF（打印管线）：渲染层传打印 HTML → 隐藏窗口 printToPDF → 返回 PDF 字节。
  // 返回 Uint8Array（structured clone 可跨进程），渲染层再走 downloadBlob 落盘。
  ipcMain.handle(IPC.PDF_EXPORT_HTML, async (_event, payload?: HtmlPdfRequest) => {
    if (!payload) throw new Error('缺少打印参数');
    return htmlToPdfBuffer(payload);
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

  // AI 算力计量（token → 积分）：读取汇总与最近用量流水（只读，从本地库读）
  ipcMain.handle(IPC.AI_METER_SUMMARY, () => metering.summary());
  ipcMain.handle(
    IPC.AI_METER_RECORDS,
    (_event, payload?: { limit?: number; offset?: number }) => {
      const limit = payload?.limit ?? 50;
      const offset = payload?.offset ?? 0;
      return metering.listRecords(limit, offset);
    },
  );

  // 宏：列表 / 读取 / 保存 / 删除（主进程仅存取文件，绝不执行宏代码；执行在渲染进程 Worker 沙箱）
  ipcMain.handle(IPC.MACRO_LIST, () => macro.list());
  ipcMain.handle(IPC.MACRO_READ, (_event, payload?: { name?: string }) => {
    if (!payload?.name) return '';
    return macro.read(payload.name);
  });
  ipcMain.handle(IPC.MACRO_SAVE, (_event, payload?: { name?: string; code?: string }) => {
    if (!payload?.name) throw new Error('缺少宏名');
    return macro.save(payload.name, payload.code ?? '');
  });
  ipcMain.handle(IPC.MACRO_DELETE, (_event, payload?: { name?: string }) => {
    if (!payload?.name) return false;
    return macro.remove(payload.name);
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
    // 崩溃恢复：进程启动即把库中所有快照标记为待恢复（语义：凡存在快照即上次会话遗留的未保存文档）
    services.library.autosave.beginSession();
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
