import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { useTabStore } from '../stores/tabStore';
import { toast } from '../stores/toastStore';
import { useUiStore } from '../stores/uiStore';
import { accelLabel, hasPrimaryModifier } from '../lib/platform';

/** 命令面板命令项 */
interface Command {
  id: string;
  title: string;
  /** 分组提示（右侧灰色小字） */
  hint: string;
  /** 是否禁用（禁用时不响应执行） */
  disabled?: boolean;
  run: () => void;
}

/**
 * 简单模糊匹配：目标按子序列包含查询串即视为命中。
 * 连续匹配权重更高（每个连续字符 +2，非连续 +1）；不命中返回 -1。
 */
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q.length === 0) return 0;
  if (q.length > t.length) return -1;

  let score = 0;
  let qi = 0;
  let lastMatchIndex = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastMatchIndex === ti - 1 ? 2 : 1;
      lastMatchIndex = ti;
      qi++;
    }
  }
  return qi === q.length ? score : -1;
}

/** 命令面板：Ctrl+Shift+P 全局唤出，模糊搜索，Enter 执行 */
export function CommandPalette() {
  const open = useUiStore((state) => state.commandPaletteOpen);
  const setOpen = useUiStore((state) => state.setCommandPaletteOpen);

  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const openTab = useTabStore((state) => state.openTab);
  const closeTab = useTabStore((state) => state.closeTab);
  const closeAllTabs = useTabStore((state) => state.closeAllTabs);

  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // 全局快捷键 主修饰键+Shift+P（Windows Ctrl / macOS ⌘，再次按下时收起）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasPrimaryModifier(event) && event.shiftKey && event.code === 'KeyP') {
        event.preventDefault();
        setOpen(!useUiStore.getState().commandPaletteOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);

  // 打开时重置状态并聚焦输入框
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      // 等一帧渲染完成后再聚焦，保证浮层已挂载
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  // 命令列表（依赖标签与主题状态，保证"关闭当前标签/切换主题"的可用性实时准确）
  const commands = useMemo<Command[]>(() => {
    const hasActiveTab = tabs.some((tab) => tab.id === activeTabId);
    return [
      { id: 'new-writer', title: '新建 Word 文档', hint: '模块', run: () => openTab('writer') },
      { id: 'new-sheet', title: '新建 Excel 工作簿', hint: '模块', run: () => openTab('sheet') },
      { id: 'new-slide', title: '新建 PPT 演示文稿', hint: '模块', run: () => openTab('slide') },
      { id: 'new-pdf', title: '新建 PDF', hint: '模块', run: () => openTab('pdf') },
      {
        id: 'toggle-theme',
        title: theme === 'light' ? '切换到深色主题' : '切换到浅色主题',
        hint: '外观',
        run: () => toggleTheme(),
      },
      {
        id: 'close-tab',
        title: '关闭当前标签',
        hint: '标签',
        disabled: !hasActiveTab,
        run: () => {
          if (activeTabId) closeTab(activeTabId);
        },
      },
      {
        id: 'close-all-tabs',
        title: '关闭所有标签',
        hint: '标签',
        disabled: tabs.length === 0,
        run: () => closeAllTabs(),
      },
      { id: 'open-settings', title: '打开设置', hint: '应用', run: () => setSettingsOpen(true) },
    ];
  }, [tabs, activeTabId, theme, openTab, closeTab, closeAllTabs, toggleTheme, setSettingsOpen]);

  // 模糊搜索过滤 + 按相关度排序
  const filteredCommands = useMemo(() => {
    const q = query.trim();
    if (!q) return commands;
    return commands
      .map((command) => ({
        command,
        // 标题权重高于分组提示
        score: Math.max(fuzzyScore(q, command.title), fuzzyScore(q, command.hint) * 0.5),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command);
  }, [commands, query]);

  if (!open) return null;

  const close = () => setOpen(false);

  const execute = (command: Command) => {
    if (command.disabled) return;
    close();
    command.run();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => (filteredCommands.length === 0 ? 0 : (index + 1) % filteredCommands.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) =>
        filteredCommands.length === 0 ? 0 : (index - 1 + filteredCommands.length) % filteredCommands.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = filteredCommands[selectedIndex];
      if (command) execute(command);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[var(--jk-z-modal)] flex items-start justify-center pt-[12vh]">
      {/* 遮罩：点击关闭 */}
      <div className="absolute inset-0 bg-overlay" onClick={close} aria-hidden="true" />
      {/* 面板 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        className="relative flex w-[560px] max-h-[60vh] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-overlay"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 搜索输入 */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <Search size={15} className="shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="输入命令，模糊搜索…"
            aria-label="命令搜索"
            className="h-full flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-muted"
          />
          <kbd className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-tiny text-muted">Esc</kbd>
        </div>

        {/* 命令列表 */}
        <div className="min-h-0 flex-1 overflow-auto py-1" role="listbox" aria-label="命令列表">
          {filteredCommands.length === 0 ? (
            <div className="px-3 py-6 text-center text-tiny text-muted">无匹配命令</div>
          ) : (
            filteredCommands.map((command, index) => {
              const selected = index === selectedIndex;
              return (
                <div
                  key={command.id}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={command.disabled}
                  className={`mx-1 flex cursor-pointer items-center justify-between rounded-sm px-2.5 py-1.5 text-ui ${
                    command.disabled
                      ? 'cursor-not-allowed text-muted opacity-50'
                      : selected
                        ? 'bg-active text-fg'
                        : 'text-fg hover:bg-hover'
                  }`}
                  onClick={() => execute(command)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span>{command.title}</span>
                  <span className="shrink-0 pl-4 text-tiny text-muted">{command.hint}</span>
                </div>
              );
            })
          )}
        </div>

        {/* 底部快捷键提示 */}
        <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-tiny text-muted">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
          <span className="ml-auto">{accelLabel('P', true)} 唤出</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
