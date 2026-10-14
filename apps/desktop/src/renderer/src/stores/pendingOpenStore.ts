/**
 * 待打开文件传递（WPS 对齐 N5：最近文档点击直达）。
 *
 * 首页点击「最近使用」→ setPendingOpen({module, path, name}) + openTab(module)；
 * 对应模块的 Editor 挂载完成后调用 takePendingOpen() 消费（一次性读取即清）。
 * 用 store 而非事件：openTab 后 Editor 异步挂载，事件会早于挂载发出而丢失。
 */
import { create } from 'zustand';

export interface PendingOpen {
  module: 'writer' | 'sheet' | 'presentation';
  path: string;
  name: string;
}

let pending: PendingOpen | null = null;

/** 设置待打开文件（首页最近列表点击） */
export function setPendingOpen(p: PendingOpen): void {
  pending = p;
}

/** 消费待打开文件（Editor 挂载时；无则返回 null） */
export function takePendingOpen(): PendingOpen | null {
  const p = pending;
  pending = null;
  return p;
}

/** 查看（不消费）待打开文件——用于「有则跳过内置示例加载」的竞态防护 */
export function peekPendingOpen(): PendingOpen | null {
  return pending;
}

/** zustand 包装（仅为接入渲染层数据流，保持 store 语义统一） */
export const usePendingOpenStore = create<{ version: number }>(() => ({ version: 0 }));