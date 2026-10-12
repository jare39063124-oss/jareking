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
  /** Ribbon 当前激活的菜单标签 */
  activeRibbonTab: RibbonTabId;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setAiPanelOpen: (open: boolean) => void;
  toggleAiPanel: () => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setActiveRibbonTab: (tab: RibbonTabId) => void;
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
  activeRibbonTab: 'home',

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
  setActiveRibbonTab: (tab) => set({ activeRibbonTab: tab }),
}));

// 初始化：确保首屏即应用当前主题（避免刷新/深色环境下闪烁）
applyTheme(useUiStore.getState().theme);
