/**
 * jkField —— TipTap 内联原子节点，承载 Word 域（PAGE/NUMPAGES/DATE/TOC…）。
 *
 * 作用：让 jareking 编辑器能「原样保留」域，而不是把 <span data-jk-field> 降级为纯文本。
 *  - parseHTML：识别 span[data-jk-field]，读取指令(instr)与缓存结果(result)
 *  - renderHTML：还原为带 data-jk-field / data-jk-field-result 的 span（淡蓝底便于辨认）
 *  - 编辑器内为原子节点（不可编辑其文本），导出时由 htmlToJk 读回 field 行内元素，
 *    再由 writer 包导出为 w:fldSimple，Word/WPS 打开后按指令重算。
 */
import { Node, mergeAttributes } from '@tiptap/core';

export const JkField = Node.create({
  name: 'jkField',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      instr: {
        default: '',
        // 由节点统一渲染 data-jk-field，避免属性名冲突
        renderHTML: () => ({}),
      },
      result: {
        default: '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-jk-field]',
        getAttrs: (el) => {
          const node = el as Element;
          return {
            instr: node.getAttribute('data-jk-field') ?? '',
            result: node.getAttribute('data-jk-field-result') ?? node.textContent ?? '',
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const instr = (node.attrs.instr as string) ?? '';
    const result = (node.attrs.result as string) ?? '';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-jk-field': instr,
        'data-jk-field-result': result,
        style: 'background:#EEF2FF;color:#3730A3;padding:0 2px;border-radius:2px',
      }),
      result || '',
    ];
  },
});
