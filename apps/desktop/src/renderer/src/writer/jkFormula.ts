/**
 * jkFormula —— TipTap 内联原子节点，承载 OMML 公式（WPS 对齐：公式能力）。
 *
 * parseHTML：识别 span[data-jk-formula]，读取线性公式文本
 * renderHTML：还原为带 data-jk-formula 的 span（浅绿底便于辨认）
 * 导出时由 htmlToJk 读回 formula 行内元素，writer 包导出为 m:oMath——
 * Word/WPS 打开后是**可编辑的原生公式对象**。
 */
import { Node, mergeAttributes } from '@tiptap/core';

export const JkFormula = Node.create({
  name: 'jkFormula',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      text: {
        default: '',
        // 由节点统一渲染 data-jk-formula，避免属性名冲突
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-jk-formula]',
        getAttrs: (el) => {
          const node = el as Element;
          return { text: node.getAttribute('data-jk-formula') ?? node.textContent ?? '' };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const text = (node.attrs.text as string) ?? '';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-jk-formula': text,
        style:
          'font-family:Cambria Math,serif;font-style:italic;background:#F0FDF4;color:#166534;padding:0 3px;border-radius:2px',
      }),
      text,
    ];
  },
});