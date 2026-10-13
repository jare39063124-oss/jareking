/**
 * 活跃 Writer 编辑器引用（模块级单点）。
 * AI 助手面板与编辑器解耦：编辑器 onCreate 注册、onDestroy 注销；
 * 面板发送指令时取当前实例执行 ops。v1 简化：仅支持单活动文档。
 */
import type { Editor } from '@tiptap/react';

let activeEditor: Editor | null = null;

export function setActiveEditor(editor: Editor | null): void {
  activeEditor = editor;
}

export function getActiveEditor(): Editor | null {
  return activeEditor;
}
