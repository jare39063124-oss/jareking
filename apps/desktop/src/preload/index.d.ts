import type { JarekingApi } from './index';

declare global {
  interface Window {
    /**
     * jareking 桌面 API（preload 经 contextBridge 暴露）。
     * JarekingApi 定义于 ./index，随 preload 扩展同步更新：
     * - versions / ping：Phase 0 只读探针
     * - invoke：T0.5 新增通用 IPC 调用
     * - IPC：T0.5 新增 IPC 通道常量表
     * - getPathForFile：Office 转 PDF 新增，代理 webUtils.getPathForFile（取 File 磁盘路径）
     */
    jareking: JarekingApi;
  }
}

export {};
