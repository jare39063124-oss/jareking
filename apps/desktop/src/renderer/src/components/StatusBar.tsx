import { Moon, Sun } from 'lucide-react';
import { MODULE_META, selectActiveTab, useTabStore, type DocModule } from '../stores/tabStore';
import { useUiStore } from '../stores/uiStore';

/** 各模块的占位统计信息（状态栏中部） */
const MODULE_STATS: Record<DocModule, string> = {
  writer: '第 1 页 / 共 1 页 · 字数 0',
  sheet: 'Sheet1 · 单元格 A1',
  slide: '第 1 张 / 共 1 张',
  pdf: '第 1 页 / 共 1 页',
};

/** 底部状态栏：当前模块、占位页码/字数、主题指示 */
export function StatusBar() {
  const activeTab = useTabStore(selectActiveTab);
  const theme = useUiStore((state) => state.theme);

  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-muted-bg px-3 text-tiny text-muted">
      {/* 左侧：当前模块 + 占位统计 */}
      <div className="flex items-center gap-3">
        <span>{activeTab ? MODULE_META[activeTab.module].label : '未打开文档'}</span>
        {activeTab ? <span>{MODULE_STATS[activeTab.module]}</span> : null}
      </div>
      {/* 右侧：主题指示 */}
      <div className="flex items-center gap-1">
        {theme === 'dark' ? <Moon size={12} aria-hidden="true" /> : <Sun size={12} aria-hidden="true" />}
        <span>{theme === 'dark' ? '深色主题' : '浅色主题'}</span>
      </div>
    </div>
  );
}
