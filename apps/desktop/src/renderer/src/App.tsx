import { AIPanel } from './components/AIPanel';
import { CommandPalette } from './components/CommandPalette';
import { PdfToolbox } from './components/PdfToolbox';
import { EditorArea } from './components/EditorArea';
import { RecoveryCenter } from './components/RecoveryCenter';
import { Ribbon } from './components/Ribbon';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { ToastViewport } from './components/Toast';
import { useUiStore } from './stores/uiStore';

/**
 * 应用主框架（布局对标 WPS）：
 *   顶部：标签页栏 + 菜单栏/Ribbon
 *   中部：文档编辑区（占位）+ AI 助手面板（可折叠）
 *   底部：状态栏
 *   全局浮层：命令面板（Ctrl+Shift+P）、设置页、Toast
 */
export default function App() {
  const aiPanelOpen = useUiStore((state) => state.aiPanelOpen);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-fg">
      {/* 顶部：标签页栏 + 菜单栏 + Ribbon 工具栏骨架 */}
      <header className="shrink-0">
        <TabBar />
        <Ribbon />
      </header>

      {/* 中部：文档编辑区 + AI 助手面板 */}
      <main className="flex min-h-0 flex-1">
        <EditorArea />
        {aiPanelOpen ? <AIPanel /> : null}
      </main>

      {/* 底部：状态栏 */}
      <StatusBar />

      {/* 全局浮层 */}
      <CommandPalette />
      <SettingsPanel />
      <PdfToolbox />
      <RecoveryCenter />
      <ToastViewport />
    </div>
  );
}
