import { create } from 'zustand';

/** 主题模式：浅色 / 深色 */
export type ThemeMode = 'light' | 'dark';

/** Ribbon 菜单标签 id（文件/开始/插入/页面布局/引用/视图/审阅 + PDF 工具） */
export type RibbonTabId =
  | 'file'
  | 'home'
  | 'insert'
  | 'layout'
  | 'reference'
  | 'view'
  | 'review'
  | 'pdf';

/**
 * PDF 工具箱的工作模式（与 @jareking/pdf 已实现能力一一对应）。
 * 由 Ribbon「PDF 工具」标签页决定：点哪个按钮就以哪个模式打开工具箱。
 */
export type PdfToolboxMode = 'extract' | 'merge' | 'rotate' | 'images' | 'insert' | 'replace';

/** 文档缩放允许区间（WPS 常见 50%~200%） */
export const WRITER_ZOOM_MIN = 0.5;
export const WRITER_ZOOM_MAX = 2;

/** 把缩放值钳制到合法区间（并保留两位小数，避免浮点累积误差） */
export function clampWriterZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  const clamped = Math.min(WRITER_ZOOM_MAX, Math.max(WRITER_ZOOM_MIN, zoom));
  return Math.round(clamped * 100) / 100;
}

interface UiState {
  theme: ThemeMode;
  /** AI 助手面板是否展开（默认收起：把横向空间让给文档区，可从 TabBar 的 Sparkles 按钮展开） */
  aiPanelOpen: boolean;
  /** 设置模态面板是否打开 */
  settingsOpen: boolean;
  /** 命令面板是否打开（Ctrl+Shift+P） */
  commandPaletteOpen: boolean;
  /** PDF 工具箱模态是否打开（文件菜单 / PDF 工具标签页入口） */
  pdfToolboxOpen: boolean;
  /** PDF 工具箱当前模式（打开时由入口按钮决定，关闭不重置） */
  pdfToolboxMode: PdfToolboxMode;
  /** Ribbon 当前激活的菜单标签 */
  activeRibbonTab: RibbonTabId;
  /** 功能区（工具组行）是否折叠——折叠后仅保留菜单标签行，给文档更多显示空间 */
  ribbonCollapsed: boolean;
  /** AI 助手面板宽度（px），可拖拽调整，给文档更多显示空间 */
  aiPanelWidth: number;
  /** Writer 文档区缩放（1 = 100%，钳制 0.5~2） */
  writerZoom: number;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  setAiPanelOpen: (open: boolean) => void;
  toggleAiPanel: () => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setPdfToolboxOpen: (open: boolean) => void;
  setPdfToolboxMode: (mode: PdfToolboxMode) => void;
  setActiveRibbonTab: (tab: RibbonTabId) => void;
  setRibbonCollapsed: (collapsed: boolean) => void;
  toggleRibbonCollapsed: () => void;
  setAiPanelWidth: (width: number) => void;
  setWriterZoom: (zoom: number) => void;
}

/** 将主题写入 <html data-theme>，驱动 CSS 变量切换 */
function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
}

export const useUiStore = create<UiState>()((set) => ({
  theme: 'light',
  aiPanelOpen: false,
  settingsOpen: false,
  commandPaletteOpen: false,
  pdfToolboxOpen: false,
  pdfToolboxMode: 'extract',
  activeRibbonTab: 'home',
  ribbonCollapsed: false,
  aiPanelWidth: 320,
  writerZoom: 1,

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
  setPdfToolboxMode: (mode) => set({ pdfToolboxMode: mode }),
  setActiveRibbonTab: (tab) => set({ activeRibbonTab: tab }),
  setRibbonCollapsed: (collapsed) => set({ ribbonCollapsed: collapsed }),
  toggleRibbonCollapsed: () => set((state) => ({ ribbonCollapsed: !state.ribbonCollapsed })),
  setAiPanelWidth: (width) => set({ aiPanelWidth: Math.min(560, Math.max(240, Math.round(width))) }),
  setWriterZoom: (zoom) => set({ writerZoom: clampWriterZoom(zoom) }),
}));

// 初始化：确保首屏即应用当前主题（避免刷新/深色环境下闪烁）
applyTheme(useUiStore.getState().theme);
