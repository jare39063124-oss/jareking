/**
 * editorCommands —— 编辑器命令总线（Ribbon ↔ 编辑器 解耦）。
 *
 * 背景：Ribbon 是全局唯一的（跨模块、跨标签），而 Writer/Sheet/Slide 编辑器
 * 各自挂载/卸载。为了让 Ribbon 的按钮真正驱动"当前编辑器"，引入一条命令总线：
 *  - 编辑器挂载时 `registerEditorCommands(cmds)` 注册一组命令（run + state）；
 *  - Ribbon 点击时 `runEditorCommand(id)`，未注册则回落到 PDF 工具箱 / 占位提示；
 *  - Ribbon 渲染时 `getEditorCommandState(id)` 读实时值（是否加粗、当前字体…），
 *    并通过 `useEditorRevision()` 订阅 revision，在编辑器状态变化后重渲染。
 *
 * 这样 Ribbon 不必持有编辑器实例，也不需要在编辑器里塞一整条重复工具栏
 * （布局瘦身：文档区垂直空间全部还给文档）。
 */

import { create } from 'zustand';

/** 命令的实时状态：是否激活（加粗高亮）、是否禁用、当前值（字体名/字号/颜色） */
export interface EditorCommandState {
  /** 切换类命令的激活态（如加粗生效中） */
  active?: boolean;
  /** 禁用态（如无编辑器、不可撤销） */
  disabled?: boolean;
  /** 取值类命令的当前值（如 '宋体'、'12'、'#ff0000'） */
  value?: string;
}

/** 单条命令：可选执行函数 + 可选状态查询函数 */
export interface EditorCommand {
  /** 执行命令；payload 由调用方传入（如字体名、颜色值） */
  run?: (payload?: unknown) => void;
  /** 读取当前状态，供 Ribbon 控件显示激活/禁用/当前值 */
  state?: () => EditorCommandState;
}

interface EditorCommandStore {
  /** 修订号：注册/注销/编辑器状态变化时自增，驱动订阅方重渲染 */
  revision: number;
}

const useEditorCommandStore = create<EditorCommandStore>()((set) => ({
  revision: 0,
}));

/** 命令注册表（id → 命令），全局唯一 */
const registry = new Map<string, EditorCommand>();

/** 合并同一事件循环内的多次通知，避免高频事务（每次击键）重复触发重渲染 */
let notifyScheduled = false;

function bumpRevision(): void {
  useEditorCommandStore.setState((state) => ({ revision: state.revision + 1 }));
}

/**
 * 注册一组命令。
 *
 * @returns 注销函数（组件卸载 / 编辑器销毁时调用）
 */
export function registerEditorCommands(cmds: Record<string, EditorCommand>): () => void {
  const keys = Object.keys(cmds);
  for (const key of keys) registry.set(key, cmds[key]);
  bumpRevision();
  return () => {
    // 仅注销本次注册的命令（避免误删后注册者的同名命令）
    for (const key of keys) {
      if (registry.get(key) === cmds[key]) registry.delete(key);
    }
    bumpRevision();
  };
}

/**
 * 执行命令。
 *
 * @returns 是否已由编辑器处理；false 表示无注册命令（调用方应回落到其他入口）
 */
export function runEditorCommand(id: string, payload?: unknown): boolean {
  const cmd = registry.get(id);
  if (!cmd?.run) return false;
  cmd.run(payload);
  return true;
}

/** 命令是否已注册（Ribbon 用它决定控件是否禁用） */
export function hasEditorCommand(id: string): boolean {
  return !!registry.get(id);
}

/**
 * 读取命令实时状态。
 *
 * @returns 未注册返回 null；已注册但无 state 函数返回空对象
 */
export function getEditorCommandState(id: string): EditorCommandState | null {
  const cmd = registry.get(id);
  if (!cmd) return null;
  return cmd.state ? cmd.state() : {};
}

/**
 * 编辑器状态变化（事务 / 选区更新）时通知订阅方重渲染。
 * 合并到微任务，避免一次事务内多次自增 revision。
 */
export function notifyEditorChange(): void {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    bumpRevision();
  });
}

/** 订阅命令总线的修订号（Ribbon 用于刷新激活态与控件取值） */
export function useEditorRevision(): number {
  return useEditorCommandStore((state) => state.revision);
}
