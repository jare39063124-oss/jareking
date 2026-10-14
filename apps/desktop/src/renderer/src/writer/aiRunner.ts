/**
 * Writer AI 共享执行管线（T4.4 浮动工具条 + T4.7 多轮对话 共用）。
 *
 * 流程：取启用配置 → resolveKey → Planner（含对话历史）→ 执行前快照 →
 * applyWriterOps 确定性执行 → 返回摘要 + undo 闭包（恢复快照）。
 *
 * 可回退（T4.9 前置）：任何 AI 写操作都先快照 TipTap JSON，undo 用 setContent
 * 恢复——不依赖 TipTap history（程序化事务对 undo 栈的影响不可控）。
 */
import type { Editor } from '@tiptap/react';
import { createAiAdapter, createWriterPlanner } from '@jareking/ai';
import type { DocContextSummary } from '@jareking/ai';
import { useAiStore } from '../stores/aiStore';
import { applyWriterOps } from './opsExecutor';
import { getActiveEditor } from './editorRef';

export interface WriterAiRunResult {
  ok: boolean;
  /** 面板展示的执行摘要（含 explanation 与成功/跳过统计） */
  summary: string;
  appliedCount: number;
  skippedCount: number;
  /** 恢复到执行前状态（幂等，可重复调用） */
  undo: () => void;
}

/** 读 store 的快照（组件外可用的 zustand API） */
async function resolveEnabledConfig(): Promise<{ id: string } | null> {
  const s = useAiStore.getState();
  if (!s.loaded) await s.load();
  const cfg = s.configs.find((c) => c.enabled);
  return cfg ? { id: cfg.id } : null;
}

/**
 * 执行一条 Writer AI 指令（不关心 UI 来源：面板输入、浮动工具条、验收脚本皆可）。
 * 失败时抛错由调用方展示；undo 始终返回（即使 ok=false 也是安全 no-op）。
 */
export async function runWriterAi(
  editor: Editor,
  instruction: string,
  history?: DocContextSummary['history'],
): Promise<WriterAiRunResult> {
  const noopUndo = () => {};
  const config = await resolveEnabledConfig();
  if (!config) throw new Error('还没有可用的 AI 服务商配置，请到「设置 → AI 服务商」添加并启用');

  const key = await useAiStore.getState().resolveKey(config.id);
  const adapter = createAiAdapter(
    useAiStore.getState().configs.find((c) => c.id === config.id)!,
    key,
  );
  const planner = createWriterPlanner({ adapter });

  const { from, to, empty } = editor.state.selection;
  const plan = await planner.planWriter(instruction, {
    text: editor.getText().slice(0, 1500),
    selection: empty ? undefined : editor.state.doc.textBetween(from, to, '\n'),
    history,
  });

  // 执行前快照（可回退）
  const snapshot = editor.getJSON();
  const undo = () => {
    editor.commands.setContent(snapshot);
  };

  const result = applyWriterOps(editor, plan.ops);
  const summary = [
    plan.explanation || '已执行计划',
    `✅ ${result.applied.length} 个操作成功`,
    result.skipped.length ? `⚠️ ${result.skipped.length} 个跳过（${result.skipped.map((s) => s.op).join('、')}）` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { ok: true, summary, appliedCount: result.applied.length, skippedCount: result.skipped.length, undo };
}

/** 便捷入口：取当前活动编辑器执行（面板/工具条共用） */
export async function runWriterAiOnActive(
  instruction: string,
  history?: DocContextSummary['history'],
): Promise<WriterAiRunResult> {
  const editor = getActiveEditor();
  if (!editor) throw new Error('请先打开一个文字文档，AI 助手才能操作它');
  return runWriterAi(editor, instruction, history);
}
