/**
 * jkNoteRef —— TipTap 内联原子节点，承载脚注 / 尾注引用（WPS 对齐：引用能力）。
 *
 * 作用：让 jareking 编辑器能「原样保留」脚注/尾注引用标记，而不是在打开→编辑→保存
 * 往返中丢失。与 jkField / jkFormula 同范式（内联原子节点，可整体删除）。
 *  - parseHTML：识别 `<sup data-jk-note="id" data-jk-note-type="footnote|endnote">`
 *  - renderHTML：还原为带上述属性的 sup（蓝色上标，便于辨认）
 *  - 导出时由 htmlToJk 读回 footnoteRef 行内元素，writer 包据此写出
 *    w:footnoteReference / w:endnoteReference 并生成 footnotes.xml / endnotes.xml。
 */
import { Node, mergeAttributes } from '@tiptap/core';

/** 节点名常量（命令总线 insertContent 与扩展注册共用，避免字面量漂移） */
export const JK_NOTE_REF = 'jkNoteRef';

export const JkNoteRef = Node.create({
  name: JK_NOTE_REF,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      noteId: {
        default: '',
        // 由节点统一渲染 data-jk-note，避免属性名冲突
        renderHTML: () => ({}),
      },
      noteType: {
        default: 'footnote',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'sup[data-jk-note]',
        getAttrs: (el) => {
          const node = el as Element;
          return {
            noteId: node.getAttribute('data-jk-note') ?? '',
            noteType: node.getAttribute('data-jk-note-type') === 'endnote' ? 'endnote' : 'footnote',
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const noteId = (node.attrs.noteId as string) ?? '';
    const noteType = node.attrs.noteType === 'endnote' ? 'endnote' : 'footnote';
    // 可见文本：脚注/尾注 id 为数字时显示该序号，否则以 * 占位（Word/WPS 打开后按顺序重排）
    const label = /^\d+$/.test(noteId) ? noteId : '*';
    return [
      'sup',
      mergeAttributes(HTMLAttributes, {
        'data-jk-note': noteId,
        'data-jk-note-type': noteType,
        style: 'color:#2563EB;font-size:0.75em;vertical-align:super',
      }),
      label,
    ];
  },
});
