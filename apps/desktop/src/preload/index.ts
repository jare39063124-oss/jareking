import { contextBridge, ipcRenderer } from 'electron';

/**
 * IPC 通道常量表：主进程与渲染进程之间的约定通道名。
 * 与 packages/core 契约对齐，由 persistence / main-infra 任务在主进程侧实现各通道处理器；
 * 渲染进程通过 window.jareking.invoke(channel, payload) 调用。
 */
export const IPC = {
  DB_QUERY: 'db:query',
  ACCOUNT_GET: 'account:get',
  ACCOUNT_POINTS: 'account:points',
  DOC_RECENT_LIST: 'doc:recent:list',
  DOC_RECENT_PIN: 'doc:recent:pin',
  DOC_AUTOSAVE_SAVE: 'doc:autosave:save',
  DOC_AUTOSAVE_PENDING: 'doc:autosave:pending',
  UPDATER_CHECK: 'updater:check',
} as const;

/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露受控 API。
 * versions / ping 为 Phase 0 只读探针；invoke 与 IPC 通道表由 T0.5 桌面能力扩展，
 * db / account / document / updater 通道的主进程处理器由 persistence 任务按
 * packages/core 契约补齐。
 */
export interface JarekingApi {
  versions: NodeJS.ProcessVersions;
  ping: () => string;
  /** 通用 IPC 调用：向主进程指定通道发送 payload 并等待结果 */
  invoke: <T>(channel: string, payload?: unknown) => Promise<T>;
  /** IPC 通道常量表 */
  IPC: typeof IPC;
}

const api: JarekingApi = {
  versions: process.versions,
  ping: () => 'pong',
  invoke: <T>(channel: string, payload?: unknown): Promise<T> =>
    ipcRenderer.invoke(channel, payload) as Promise<T>,
  IPC,
};

contextBridge.exposeInMainWorld('jareking', api);
