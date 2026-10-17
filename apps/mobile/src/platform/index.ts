/**
 * 平台桥安装：把 `window.jareking` 装到全局，形状与 desktop preload 完全一致。
 *
 * 渲染层（apps/desktop/src/renderer）没有一行代码需要改：
 * 它调用 `window.jareking.invoke(channel, payload)`、`window.jareking.IPC`、
 * `window.jareking.getPathForFile(file)`——这里分别由
 * `handlers.dispatch` / 共用通道表 / 文件注册表实现。
 */
import { IPC } from '@ipc';
import { dispatch, IMPLEMENTED_CHANNELS, registerPickedFile } from './handlers';
import { installDownloadInterceptor } from './download';

/** 与 desktop preload 的 JarekingApi 保持同形（形状是跨端契约） */
export interface JarekingApi {
  versions: Record<string, string>;
  ping: () => string;
  invoke: <T>(channel: string, payload?: unknown) => Promise<T>;
  IPC: typeof IPC;
  getPathForFile: (file: File) => string;
}

/** 是否运行在 Capacitor 原生壳内（浏览器直开时为 false，便于本地调试） */
export const isNative = (): boolean => {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
};

const api: JarekingApi = {
  // 渲染层只读展示用；WebView 无 process.versions
  versions: { platform: isNative() ? 'android' : 'web' },
  ping: () => 'pong',
  invoke: <T>(channel: string, payload?: unknown): Promise<T> =>
    dispatch(channel, payload) as Promise<T>,
  IPC,
  getPathForFile: (file: File): string => registerPickedFile(file),
};

/** 安装到全局（幂等；渲染层 store 在模块顶层读取 IPC，必须先于 App 导入执行） */
export function installJarekingBridge(): void {
  const w = window as unknown as {
    jareking: JarekingApi;
    /** 接线自检：确认通道表里的每一条都有移动端实现（冒烟脚本消费） */
    __jkMobileDiagnostics?: () => {
      total: number;
      implemented: number;
      missing: string[];
    };
  };
  w.jareking = api;
  // 保存/导出：拦截 <a download>，改走 Filesystem + 系统分享（见 download.ts 注释）
  installDownloadInterceptor();
  w.__jkMobileDiagnostics = () => {
    const all = Object.values(IPC) as string[];
    const done = new Set(IMPLEMENTED_CHANNELS);
    return {
      total: all.length,
      implemented: all.filter((c) => done.has(c)).length,
      missing: all.filter((c) => !done.has(c)),
    };
  };
}

installJarekingBridge();

export { api };
