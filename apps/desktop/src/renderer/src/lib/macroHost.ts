/**
 * 宏宿主（主线程侧）：把 Worker 内的 jk API 调用落到「当前文档」上。
 *
 * 默认实现面向 **Writer（TipTap）**：经 `writer/editorRef` 取活动编辑器实例，
 * 复用既有 `findReplace` / `opsExecutor`，不另起一套文档操作。
 *
 * Sheet / Slide 等其它编辑器可通过 `registerMacroHost` 注册专属宿主
 * （例如 Excel 工作表用 Univer API 实现 `jk.sheet.*`）——属于待整合事项。
 */
import type { Editor } from '@tiptap/react';
import type { WriterOp } from '@jareking/ai';
import { getActiveEditor } from '../writer/editorRef';
import { applyReplaceAll } from '../writer/findReplace';
import { applyWriterOps } from '../writer/opsExecutor';
import type { MacroHost } from './macroProtocol';

/** 取活动 Writer 编辑器，无则抛出可读错误 */
function requireEditor(): Editor {
  const editor = getActiveEditor();
  if (!editor) throw new Error('当前没有可操作的 Writer 文档（请先打开并激活一个文档再运行宏）');
  return editor;
}

/** 纯文本 → TipTap 段落节点数组（按行拆分） */
function textToDoc(text: string): { type: 'paragraph'; content: { type: 'text'; text: string }[] }[] {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => ({
      type: 'paragraph' as const,
      content: line ? [{ type: 'text' as const, text: line }] : [],
    }));
}

/** Writer 宏宿主实现（TipTap 编辑器） */
export const writerMacroHost: MacroHost = {
  getText: () => requireEditor().state.doc.textContent,

  setText: (text) => {
    requireEditor().commands.setContent(textToDoc(text));
  },

  appendText: (text) => {
    const editor = requireEditor();
    editor
      .chain()
      .focus()
      .insertContentAt(editor.state.doc.content.size, textToDoc(text))
      .run();
  },

  findReplace: (needle, replacement, opts) => {
    const editor = requireEditor();
    const tr = editor.state.tr;
    const count = applyReplaceAll(tr, needle, replacement, opts ?? {});
    if (tr.docChanged) editor.view.dispatch(tr);
    return { count };
  },

  getSelection: () => {
    const editor = requireEditor();
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, '\n');
  },

  replaceSelection: (text) => {
    // TipTap insertContent 天然替换当前选区
    requireEditor().chain().focus().insertContent(String(text ?? '')).run();
  },

  applyOps: (ops) => {
    const editor = requireEditor();
    return applyWriterOps(editor, (Array.isArray(ops) ? ops : []) as WriterOp[]);
  },

  sheetGetCellText: () => {
    throw new Error('当前文档不支持 jk.sheet API（仅 Excel 工作表可用，且需注册 Sheet 宏宿主）');
  },

  sheetSetValues: () => {
    throw new Error('当前文档不支持 jk.sheet API（仅 Excel 工作表可用，且需注册 Sheet 宏宿主）');
  },
};

/** 当前生效的宏宿主（默认 Writer） */
let activeHost: MacroHost = writerMacroHost;

/**
 * 注册宏宿主。
 * @param host 传 null 恢复默认 Writer 宿主（如 Sheet 编辑器卸载时调用）
 */
export function registerMacroHost(host: MacroHost | null): void {
  activeHost = host ?? writerMacroHost;
}

/** 取当前宏宿主（宏运行器默认使用） */
export function getMacroHost(): MacroHost {
  return activeHost;
}
