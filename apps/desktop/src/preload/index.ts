import { contextBridge } from 'electron';

/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露受控 API。
 * Phase 0 仅暴露只读探针；db / account / document / updater 通道由
 * persistence / main-infra 任务按 packages/core 契约扩展。
 */
export interface JarekingApi {
  versions: NodeJS.ProcessVersions;
  ping: () => string;
}

const api: JarekingApi = {
  versions: process.versions,
  ping: () => 'pong',
};

contextBridge.exposeInMainWorld('jareking', api);
