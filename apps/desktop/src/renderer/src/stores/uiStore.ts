import { create } from 'zustand';

/** 主题模式：浅色 / 深色 */
export type ThemeMode = 'light' | 'dark';

/** Ribbon 菜单标签 id（文件/开始/插入/页面布局/引用/视图/审阅） */
export type RibbonTabId = 'file' | 'home' | 'insert' | 'layout' | 'reference' | 'view' | 'review';

interface UiState {
  theme: ThemeMode;
  /** AI 助手面板是否展开 */
  aiPanelOpen: boolean;
  /** 设置模态面板是否打开 */
  settingsOpen: boolean;
  /** 命令面板是否打开（Ctrl+Shift+P） */
  commandPaletteOpen: boolean;
  /** PDF 工具箱模态是否打开（文件菜单入口） */
  pdfToolboxOpen: boolean;
  /** Ribbon 当前激活的菜单标签 */
  activeRibbonTab: RibbonTabId;
  /** 功能区（工具组行）是否折叠——折叠后仅保留菜单标签行，给文档更多显示空间 */
  ribbonCollapsed: boolean;
  /** AI 助手面板宽度（px），可拖拽调整，给文档更多显示空间 */
  aiPanelWidth: number;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setAiPanelOpen: (open: boolean) => void;
  toggleAiPanel: () => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setPdfToolboxOpen: (open: boolean) => void;
  setActiveRibbonTab: (tab: RibbonTabId) => void;
  setRibbonCollapsed: (collapsed: boolean) => void;
  toggleRibbonCollapsed: () => void;
  setAiPanelWidth: (width: number) => void;
}

/** 将主题写入 <html data-theme>，驱动 CSS 变量切换 */
function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
}

export const useUiStore = create<UiState>()((set) => ({
  theme: 'light',
  aiPanelOpen: true,
  settingsOpen: false,
  commandPaletteOpen: false,
  pdfToolboxOpen: false,
  activeRibbonTab: 'home',
  ribbonCollapsed: false,
  aiPanelWidth: 320,

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },

  toggleTheme: () =>
    set((state) => {
      const theme: ThemeMode = state.theme === 'light' ? 'dark' : 'light';
      applyTheme(theme);
      return { theme };
    }),

  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
  toggleAiPanel: () => set((state) => ({ aiPanelOpen: !state.aiPanelOpen })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setPdfToolboxOpen: (open) => set({ pdfToolboxOpen: open }),
  setActiveRibbonTab: (tab) => set({ activeRibbonTab: tab }),
  setRibbonCollapsed: (collapsed) => set({ ribbonCollapsed: collapsed }),
  toggleRibbonCollapsed: () => set((state) => ({ ribbonCollapsed: !state.ribbonCollapsed })),
  setAiPanelWidth: (width) => set({ aiPanelWidth: Math.min(560, Math.max(240, Math.round(width))) }),
}));

// 初始化：确保首屏即应用当前主题（避免刷新/深色环境下闪烁）
applyTheme(useUiStore.getState().theme);
