/**
 * Writer 选中浮动 AI 工具条（T4.4 后续）。
 *
 * 选中文字后在其上方浮出快捷 AI 操作（润色/译英/改写/总结），
 * 走 aiRunner 共享管线（Planner → 快照 → Executor），执行结果与撤销
 * 统一写入 aiChatStore——与 AI 面板共用撤销入口。
 *
 * 自实现定位（不引入 @tiptap/extension-bubble-menu，避免 v2/v3 版本漂移）：
 * selectionUpdate 时用 view.coordsAtPos 取选区起点屏幕坐标。
 */
import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Sparkles } from 'lucide-react';
import { toast } from '../stores/toastStore';
import {
  useAiChatStore,
  recentAiHistory,
  registerAiUndo,
} from '../stores/aiChatStore';
import { runWriterAi } from './aiRunner';

const ACTIONS: { label: string; instruction: string }[] = [
  { label: '润色', instruction: '润色当前选区的文字，使其更通顺专业，用 replaceSelection 替换选区' },
  { label: '译英', instruction: '把当前选区翻译成英文，用 replaceSelection 替换选区' },
  { label: '改写', instruction: '换一种表达方式改写当前选区，保持原意，用 replaceSelection 替换选区' },
  { label: '总结', instruction: '用一句话总结当前选区的要点，用 replaceSelection 替换选区' },
];

let runSeq = 0;

export function FloatingAiBar({ editor }: { editor: Editor }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    const update = () => {
      if (busyRef.current) return;
      const { from, to, empty } = editor.state.selection;
      if (empty || from === to) {
        setPos(null);
        return;
      }
      try {
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        const left = Math.max(8, (start.left + end.left) / 2 - 120);
        setPos({ top: Math.max(8, start.top - 42), left });
      } catch {
        setPos(null);
      }
    };
    editor.on('selectionUpdate', update);
    editor.on('blur', () => setPos(null));
    window.addEventListener('scroll', () => setPos(null), true);
    window.addEventListener('resize', () => setPos(null));
    return () => {
      editor.off('selectionUpdate', update);
      window.removeEventListener('resize', () => setPos(null));
    };
  }, [editor]);

  if (!pos) return null;

  const run = async (instruction: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const chat = useAiChatStore.getState();
    chat.append({ role: 'user', content: `（选中操作）${instruction.slice(0, 30)}…` });
    try {
      const result = await runWriterAi(editor, instruction, recentAiHistory());
      const runId = `float-${Date.now()}-${++runSeq}`;
      registerAiUndo(runId, result.undo);
      chat.append({ role: 'assistant', content: result.summary, runId });
      toast.success('AI 已执行，可在 AI 面板撤销');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chat.append({ role: 'assistant', content: `执行失败：${msg}` });
      toast.warning('AI 执行失败');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setPos(null);
    }
  };

  return (
    <div
      className="fixed z-50 flex items-center gap-0.5 rounded-md border border-border bg-surface px-1 py-0.5 shadow-card"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Sparkles size={12} className="mx-1 text-accent" aria-hidden="true" />
      {ACTIONS.map((a) => (
        <button
          key={a.label}
          type="button"
          disabled={busy}
          className="rounded px-1.5 py-0.5 text-tiny text-fg transition-colors hover:bg-hover disabled:opacity-50"
          onClick={() => void run(a.instruction)}
        >
          {a.label}
        </button>
      ))}
      {busy && <span className="px-1 text-tiny text-muted">执行中…</span>}
    </div>
  );
}
