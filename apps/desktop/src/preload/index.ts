import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '../ipc/channels.js';

export { IPC };

/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露受控 API。
 * versions / ping 为 Phase 0 只读探针；invoke 与 IPC 通道表由 T0.5 桌面能力扩展，
 * db / account / document / updater 通道的主进程处理器由 persistence 任务按
 * packages/core 契约补齐。
 */
export interface JarekingApi {
  versions: NodeJS.ProcessVersions;
  /**
   * 运行平台（`process.platform` 原值：'win32' / 'darwin' / 'linux'）。
   * 渲染层据此决定主修饰键（mac = ⌘，其余 = Ctrl）与快捷键文案，
   * 避免用 UA / navigator.platform 嗅探（不可靠且被逐步废弃）。
   */
  platform: NodeJS.Platform;
  ping: () => string;
  /** 通用 IPC 调用：向主进程指定通道发送 payload 并等待结果 */
  invoke: <T>(channel: string, payload?: unknown) => Promise<T>;
  /** IPC 通道常量表 */
  IPC: typeof IPC;
  /**
   * 取 File 对象对应的本机磁盘路径。
   * Electron 32+ 已移除非标准的 `File.path`，官方迁移方案即 `webUtils.getPathForFile`；
   * 此处由 preload 代理暴露（渲染进程在 contextIsolation 下无法直接访问 electron 模块）。
   */
  getPathForFile: (file: File) => string;
}

const api: JarekingApi = {
  versions: process.versions,
  platform: process.platform,
  ping: () => 'pong',
  invoke: <T>(channel: string, payload?: unknown): Promise<T> =>
    ipcRenderer.invoke(channel, payload) as Promise<T>,
  IPC,
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld('jareking', api);
