/**
 * 宏 store：封装宏列表的 IPC 读写（主进程文件系统 CRUD）。
 *
 * 通道名取自 preload 暴露的 `window.jareking.IPC`（单一来源 `src/ipc/channels.ts`），
 * 与主进程 handler 严格一致。
 */
import { create } from 'zustand';
import type { MacroMeta } from '../../../shared/macroUtils';

const IPC = window.jareking.IPC;

interface MacroState {
  /** 宏列表（名称 + 更新时间） */
  macros: MacroMeta[];
  /** 是否已完成首次加载 */
  loaded: boolean;
  /** 重新拉取列表 */
  load: () => Promise<void>;
  /** 读取指定宏源码 */
  read: (name: string) => Promise<string>;
  /** 新建 / 覆盖保存宏 */
  save: (name: string, code: string) => Promise<MacroMeta>;
  /** 删除宏 */
  remove: (name: string) => Promise<boolean>;
}

export const useMacroStore = create<MacroState>((set, get) => ({
  macros: [],
  loaded: false,

  load: async () => {
    const macros = await window.jareking.invoke<MacroMeta[]>(IPC.MACRO_LIST);
    set({ macros, loaded: true });
  },

  read: (name) => window.jareking.invoke<string>(IPC.MACRO_READ, { name }),

  save: async (name, code) => {
    const meta = await window.jareking.invoke<MacroMeta>(IPC.MACRO_SAVE, { name, code });
    await get().load();
    return meta;
  },

  remove: async (name) => {
    const ok = await window.jareking.invoke<boolean>(IPC.MACRO_DELETE, { name });
    await get().load();
    return ok;
  },
}));
