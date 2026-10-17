/**
 * Writer 查找/替换条 + 编辑器状态栏。
 *
 * - 主修饰键+F 查找（Windows Ctrl / macOS ⌘；计数 + 上/下导航 + 自动选中），主修饰键+H 替换（逐个/全部）；
 * - 匹配定位：findAllMatches（纯函数）→ setTextSelection + scrollIntoView；
 * - 全部替换：applyReplaceAll 倒序 replaceWith（单事务，可一步撤销）；
 * - 状态栏：字数/字符（countWords，对齐 WPS 口径）。
 */
import { useEffect, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { ArrowDown, ArrowUp, CaseSensitive, Replace, ReplaceAll, X } from 'lucide-react';
import { findAllMatches, applyReplaceAll } from './findReplace';
import { countWords } from '../lib/fonts';
import { accelLabel } from '../lib/platform';

export function FindReplaceBar({
  editor,
  initialMode,
  onClose,
}: {
  editor: Editor;
  initialMode: 'find' | 'replace';
  onClose: () => void;
}) {
  const [needle, setNeedle] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(initialMode === 'replace');
  const [cursor, setCursor] = useState(0);

  const matches = useMemo(
    () => findAllMatches(editor.state.doc, needle, { caseSensitive }),
    // editor.state.doc 变化依赖 editor 更新事件，见下方 force 版本号
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needle, caseSensitive, editor],
  );

  const [, forceTick] = useState(0);
  useEffect(() => {
    const bump = () => forceTick((t) => t + 1);
    editor.on('update', bump);
    return () => {
      editor.off('update', bump);
    };
  }, [editor]);

  useEffect(() => {
    setCursor(0);
  }, [needle, caseSensitive]);

  const goto = (index: number) => {
    if (!matches.length) return;
    const i = ((index % matches.length) + matches.length) % matches.length;
    setCursor(i);
    const m = matches[i];
    editor.commands.setTextSelection({ from: m.from, to: m.to });
    // 滚动到选区可见
    const dom = editor.view.domAtPos(m.from);
    const el = dom.node instanceof Element ? dom.node : dom.node.parentElement;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const replaceCurrent = () => {
    if (!matches.length) return;
    const m = matches[Math.min(cursor, matches.length - 1)];
    editor.chain().focus().insertContentAt({ from: m.from, to: m.to }, replacement).run();
  };

  const replaceAll = () => {
    if (!needle) return;
    const tr = editor.state.tr;
    const count = applyReplaceAll(tr, needle, replacement, { caseSensitive });
    if (count) editor.view.dispatch(tr);
    toastDone(count);
  };

  const toastDone = (count: number) => {
    // 轻提示由调用方 toast 体系处理太重，此处用窗口标题级提示省略；计数显示在条内
    void count;
  };

  return (
    <div
      data-testid="find-replace-bar"
      className="absolute right-4 top-2 z-30 w-96 rounded-md border border-border bg-surface p-2 shadow-card"
    >
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={needle}
          placeholder="查找内容"
          className="h-7 flex-1 rounded border border-border bg-surface px-2 text-body text-fg outline-none focus:border-accent"
          onChange={(e) => setNeedle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') goto(e.shiftKey ? cursor - 1 : cursor + 1);
            if (e.key === 'Escape') onClose();
          }}
        />
        <button
          type="button"
          title="区分大小写"
          className={`rounded p-1 ${caseSensitive ? 'text-accent' : 'text-muted'}`}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          <CaseSensitive size={15} />
        </button>
        <span className="min-w-14 text-center text-tiny text-muted">
          {needle ? `${matches.length ? cursor + 1 : 0}/${matches.length}` : ''}
        </span>
        <button type="button" title="上一个" className="rounded p-1 text-muted hover:text-fg" onClick={() => goto(cursor - 1)}>
          <ArrowUp size={15} />
        </button>
        <button type="button" title="下一个" className="rounded p-1 text-muted hover:text-fg" onClick={() => goto(cursor + 1)}>
          <ArrowDown size={15} />
        </button>
        <button
          type="button"
          title={showReplace ? '收起替换' : '展开替换'}
          className={`rounded p-1 ${showReplace ? 'text-accent' : 'text-muted hover:text-fg'}`}
          onClick={() => setShowReplace((v) => !v)}
        >
          <Replace size={15} />
        </button>
        <button type="button" title="关闭" className="rounded p-1 text-muted hover:text-fg" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {showReplace && (
        <div className="mt-1.5 flex items-center gap-1">
          <input
            value={replacement}
            placeholder="替换为"
            className="h-7 flex-1 rounded border border-border bg-surface px-2 text-body text-fg outline-none focus:border-accent"
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
          />
          <button
            type="button"
            title="替换当前"
            className="rounded border border-border px-2 py-1 text-tiny text-fg hover:border-accent disabled:opacity-50"
            disabled={!matches.length}
            onClick={replaceCurrent}
          >
            替换
          </button>
          <button
            type="button"
            title={`全部替换（单事务，可 ${accelLabel('Z')} 一步撤销）`}
            className="rounded border border-border px-2 py-1 text-tiny text-fg hover:border-accent disabled:opacity-50"
            disabled={!matches.length}
            onClick={replaceAll}
          >
            <ReplaceAll size={14} className="inline" /> 全部
          </button>
        </div>
      )}
    </div>
  );
}

/** 编辑器底部状态栏：字数/字符（WPS 口径） */
export function EditorStatusBar({ editor }: { editor: Editor }) {
  const [stats, setStats] = useState({ words: 0, charsNoSpace: 0, chars: 0 });
  useEffect(() => {
    const update = () => setStats(countWords(editor.getText()));
    update();
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor]);
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-tiny text-muted">
      <span>字数：{stats.words}</span>
      <span>字符（不计空格）：{stats.charsNoSpace}</span>
      <span>字符（计空格）：{stats.chars}</span>
      <span className="ml-auto">jareking 文字</span>
    </div>
  );
}
