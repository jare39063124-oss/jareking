import { create } from 'zustand';
import { BookOpen, FileText, Presentation, Table } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { DocModule } from '@jareking/core';

/**
 * 文档模块类型（对应产品规格 4.2~4.5：Writer / Sheet / Presentation / PDF）。
 * **单一来源**：复用 `@jareking/core` 契约（`contracts/document.ts`），勿在本文件重复定义——
 * 历史上这里与 core 各存一份，是多模型协作下命名漂移的高危点。
 */
export type { DocModule };

/** 模块元信息：图标、显示名、新建默认标题 */
export interface ModuleMeta {
  label: string;
  shortLabel: string;
  defaultTitle: string;
  icon: LucideIcon;
}

/** 全应用共享的模块元信息表（标签栏 / 编辑区 / 状态栏 / 命令面板复用） */
export const MODULE_META: Record<DocModule, ModuleMeta> = {
  writer: { label: '文字', shortLabel: '文字', defaultTitle: '文档', icon: FileText },
  sheet: { label: '表格', shortLabel: '表格', defaultTitle: '工作簿', icon: Table },
  slide: { label: '演示', shortLabel: '演示', defaultTitle: '演示文稿', icon: Presentation },
  pdf: { label: 'PDF', shortLabel: 'PDF', defaultTitle: 'PDF 文档', icon: BookOpen },
};

/** 多文档标签页结构 */
export interface Tab {
  id: string;
  module: DocModule;
  title: string;
  closable: boolean;
  dirty: boolean;
}

interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  /** 新建标签页（默认标题按模块自动编号），返回新标签 id */
  openTab: (module: DocModule, title?: string) => string;
  /** 关闭指定标签页；关闭的是当前页时自动激活相邻标签 */
  closeTab: (id: string) => void;
  /** 全部关闭（回到空状态引导） */
  closeAllTabs: () => void;
  /** 切换当前标签页 */
  setActiveTab: (id: string) => void;
  /** 设置标签页的未保存标记（持久层就绪后由保存流程调用） */
  setDirty: (id: string, dirty: boolean) => void;
}

/** 标签 id 生成器（自增计数，保证进程内唯一且可读） */
let tabSeq = 0;
const nextTabId = (): string => `tab-${++tabSeq}`;

export const useTabStore = create<TabState>()((set) => ({
  tabs: [],
  activeTabId: null,

  openTab: (module, title) => {
    const id = nextTabId();
    set((state) => {
      // 未显式指定标题时，按同模块已有数量自动编号：文档 1、文档 2 …
      const sameModuleCount = state.tabs.filter((t) => t.module === module).length;
      const finalTitle = title ?? `${MODULE_META[module].defaultTitle} ${sameModuleCount + 1}`;
      const tab: Tab = { id, module, title: finalTitle, closable: true, dirty: false };
      return { tabs: [...state.tabs, tab], activeTabId: id };
    });
    return id;
  },

  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== id);
      let activeTabId = state.activeTabId;
      if (state.activeTabId === id) {
        // 优先激活原右侧标签，否则激活左侧最后一个
        const next = tabs[index] ?? tabs[index - 1] ?? null;
        activeTabId = next ? next.id : null;
      }
      return { tabs, activeTabId };
    }),

  closeAllTabs: () => set({ tabs: [], activeTabId: null }),

  setActiveTab: (id) =>
    set((state) => (state.tabs.some((t) => t.id === id) ? { activeTabId: id } : state)),

  setDirty: (id, dirty) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, dirty } : t)),
    })),
}));

/** 选择器：当前激活的标签页（无则为 null，对应空状态引导） */
export const selectActiveTab = (state: TabState): Tab | null =>
  state.tabs.find((t) => t.id === state.activeTabId) ?? null;
