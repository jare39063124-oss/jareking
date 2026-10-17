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
 *
 * macOS 差异（交接文档 §7.2 第 5 条）：
 *  electron-updater 在 mac 上依赖 **Squirrel.Mac**，要求应用已用 Developer ID 证书签名，
 *  否则 `checkForUpdates` 会以「Could not get code signature」类错误拒绝执行。
 *  因此：
 *   - 未签名的本地/CI 构建（identity=null）**只会打印一条 error 日志**，不影响应用可用性；
 *   - 正式分发必须补 Apple Developer 证书 + 公证（notarytool）后自动更新才真正生效。
 *  这里不做「mac 一律跳过」的硬编码开关——否则签名后还得改代码；错误统一由下方
 *  `autoUpdater.on('error')` 兜住，不会弹出原生错误框打断用户。
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
