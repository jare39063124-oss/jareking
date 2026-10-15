/**
 * 段落排版扩展（用户反馈 1：首行缩进/行距统一）。
 *
 * 背景：TipTap 的 TextAlign 通过 addGlobalAttributes 把 textAlign 挂到
 * paragraph/heading；多个属性同时渲染 style 会互相覆盖。此处用同一机制
 * 重写 textAlign 渲染，把对齐 + 首行缩进 + 行距合并为单一 style 输出。
 *
 * 链路：编辑器内联样式 → getHTML → htmlToJk（解析 text-indent/line-height）
 * → JkDocument（ind.firstLine / spacing.line）→ docx 导出（w:ind/w:spacing）。
 */
import TextAlign from '@tiptap/extension-text-align';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphLayout: {
      /** 设置段落排版属性（对齐/首行缩进/行距），作用于当前选区的各块 */
      setParagraphLayout: (attrs: {
        textAlign?: string;
        textIndent?: string;
        lineHeight?: string;
      }) => ReturnType;
    };
  }
}

/** 合并渲染：对齐 + 缩进 + 行距 → 单一 style（多个属性若各自渲染 style 会互相覆盖） */
function renderParagraphStyle(attributes: Record<string, unknown>): Record<string, string> {
  const styles: string[] = [];
  if (attributes.textAlign) styles.push(`text-align:${attributes.textAlign}`);
  if (attributes.textIndent) styles.push(`text-indent:${attributes.textIndent}`);
  if (attributes.lineHeight) styles.push(`line-height:${attributes.lineHeight}`);
  return styles.length ? { style: styles.join(';') } : {};
}

/** 段落排版：textIndent 形如 "2em"；lineHeight 形如 "1.5" 或 "28pt" */
export const ParagraphTextAlign = TextAlign.extend({
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          // textAlign 由合并渲染输出（覆盖 TextAlign 原版的单独渲染）
          textAlign: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.textAlign || null,
            renderHTML: renderParagraphStyle,
          },
          textIndent: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.textIndent || null,
            renderHTML: renderParagraphStyle,
          },
          lineHeight: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.lineHeight || null,
            renderHTML: renderParagraphStyle,
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setParagraphLayout:
        (attrs) =>
        ({ commands }) => {
          let ok = true;
          for (const [key, value] of Object.entries(attrs)) {
            // updateAttributes 为 TipTap 核心命令（setNodeAttribute 不存在）；
            // 逐属性写回，保持与原有「单属性设置 + 累积结果」语义一致
            ok = commands.updateAttributes('paragraph', { [key]: value ?? null }) && ok;
          }
          return ok;
        },
    };
  },
});
