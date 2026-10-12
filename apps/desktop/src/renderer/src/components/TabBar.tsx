import { FilePlus2, Plus, Settings, Sparkles, X } from 'lucide-react';
import { Dropdown } from './Dropdown';
import { IconButton } from './IconButton';
import { MODULE_META, useTabStore, type DocModule } from '../stores/tabStore';
import { useUiStore } from '../stores/uiStore';

/** 新建文档下拉菜单项 */
const NEW_DOC_ITEMS: { module: DocModule; label: string }[] = [
  { module: 'writer', label: '新建 Word 文档' },
  { module: 'sheet', label: '新建 Excel 工作簿' },
  { module: 'slide', label: '新建 PPT 演示文稿' },
  { module: 'pdf', label: '新建 PDF' },
];

/** 顶部多文档标签页栏：品牌位 + 标签列表 + 新建下拉 + AI 面板开关 */
export function TabBar() {
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const openTab = useTabStore((state) => state.openTab);
  const closeTab = useTabStore((state) => state.closeTab);
  const setActiveTab = useTabStore((state) => state.setActiveTab);

  const aiPanelOpen = useUiStore((state) => state.aiPanelOpen);
  const toggleAiPanel = useUiStore((state) => state.toggleAiPanel);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface px-2">
      {/* 品牌位 */}
      <span className="mr-1 shrink-0 select-none px-1 text-ui font-semibold text-accent">jareking</span>

      {/* 标签列表 */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const { icon: ModuleIcon } = MODULE_META[tab.module];
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              title={tab.title}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setActiveTab(tab.id);
                }
              }}
              // 鼠标中键关闭标签
              onAuxClick={(event) => {
                if (event.button === 1 && tab.closable) closeTab(tab.id);
              }}
              className={`group flex h-7 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-ui transition-colors ${
                active
                  ? 'border border-accent/40 bg-active text-fg'
                  : 'border border-transparent text-muted hover:bg-hover hover:text-fg'
              }`}
            >
              <ModuleIcon size={13} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{tab.title}</span>
              {/* 未保存标记 */}
              {tab.dirty ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="有未保存的更改" />
              ) : null}
              {/* 关闭按钮（可关闭时显示；激活标签常显，其余悬停显示） */}
              {tab.closable ? (
                <span
                  role="button"
                  aria-label={`关闭 ${tab.title}`}
                  title="关闭"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted transition-colors hover:bg-border hover:text-fg ${
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }}
                >
                  <X size={11} />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* 新建文档下拉 */}
      <Dropdown
        align="left"
        trigger={<IconButton label="新建文档" icon={<Plus size={16} />} />}
        items={NEW_DOC_ITEMS.map((item) => ({
          id: item.module,
          label: item.label,
          icon: <FilePlus2 size={14} />,
          onSelect: () => openTab(item.module),
        }))}
      />

      {/* AI 助手面板开关 */}
      <IconButton
        label={aiPanelOpen ? '收起 AI 助手面板' : '展开 AI 助手面板'}
        icon={<Sparkles size={16} className={aiPanelOpen ? 'text-accent' : undefined} />}
        onClick={toggleAiPanel}
      />

      {/* 设置 */}
      <IconButton label="设置" icon={<Settings size={16} />} onClick={() => setSettingsOpen(true)} />
    </div>
  );
}
