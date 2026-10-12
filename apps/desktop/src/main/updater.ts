import { app } from 'electron';
// electron-updater 是 CJS 包：ESM 具名导入在运行时会失败（lexer 检测不到导出），
// 必须走默认导入 + 解构
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

/**
 * 自动更新（T0.5 桌面能力）
 *
 * - 仅在打包后的应用（app.isPackaged）中执行检查；开发模式下静默跳过，
 *   避免向不存在的更新源发起请求
 * - autoDownload 使用 electron-updater 默认行为（发现新版本后自动下载，
 *   下载完成后在退出应用时经 autoInstallOnAppQuit 安装，即天然支持回滚到旧版本：
 *   用户不退出则继续使用旧版本）
 * - 本阶段所有事件仅输出 console 日志，后续接入本地崩溃日志/日志文件时统一收敛
 */
export function initAutoUpdater(): void {
  // 开发模式（未打包）不执行更新检查
  if (!app.isPackaged) return;

  autoUpdater.on('error', (error) => {
    console.error('[updater] 更新检查/下载失败:', error.message);
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] 发现新版本 ${info.version}，开始自动下载`);
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('[updater] 新版本已下载完成，将在应用退出时自动安装');
  });

  // checkForUpdatesAndNotify 内部异常一般会通过 error 事件派发，
  // 此处兜底 catch，防止 Promise rejection 未处理
  void autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
    console.error('[updater] checkForUpdatesAndNotify 调用异常:', error);
  });
}

/**
 * 手动触发一次更新检查（由渲染进程「检查更新」入口经 IPC 调用）。
 * 开发模式或未打包时直接返回，不发起请求。
 */
export async function checkForUpdates(): Promise<boolean> {
  if (!app.isPackaged) {
    console.log('[updater] 开发模式跳过更新检查');
    return false;
  }
  try {
    await autoUpdater.checkForUpdatesAndNotify();
    return true;
  } catch (error: unknown) {
    console.error('[updater] 手动更新检查失败:', error);
    return false;
  }
}
