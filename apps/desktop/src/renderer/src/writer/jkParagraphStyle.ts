/**
 * jkParagraphStyle —— TipTap 自定义 mark，承载 Writer「段落样式」引用（WPS 对齐：样式管理器）。
 *
 * 背景：TipTap 的 Paragraph/Heading 节点 schema 默认不保留未声明的 `data-*` 属性，
 * 因此「把段落样式 styleId 直接写在 <p> 上」会在编辑器往返（setContent → getHTML）
 * 中被丢弃，导致保存后再打开丢失样式引用。
 *
 * 方案（复用批注/修订既有 data-jk-* 惯例）：把段落样式的 styleId 以 **mark** 形式
 * 挂到该段落的文本上，渲染为 `<span data-jk-para-style="styleId">`：
 *  - `parseHTML`：识别 `span[data-jk-para-style]`（由 jkToHtml 生成）；
 *  - `renderHTML`：还原为带 `data-jk-para-style` 的 span（无额外可见样式，
 *    可见格式由「应用样式」时逐属性下发，互不干扰）；
 *  - 保存时 `htmlToJk` 读回该 span → `Paragraph.pPr.styleId`，
 *    再经 `packages/writer` 导出为 `<w:pStyle w:val="…">`（Word/WPS 原生样式引用）。
 *
 * 与模型对应关系：`attrs.styleId` ↔ `ParagraphProperties.styleId` / `StyleDef.styleId`。
 */
import { Mark, mergeAttributes } from '@tiptap/core';

/** 段落样式 mark 名称（命令总线与 htmlToJk 共用，避免魔法字符串漂移） */
export const JK_PARAGRAPH_STYLE = 'jkParagraphStyle';

export const JkParagraphStyle = Mark.create({
  name: JK_PARAGRAPH_STYLE,

  // 段落样式对整段生效：光标在段落边界继续输入时保留样式关联
  inclusive: true,

  addAttributes() {
    return {
      /** 段落样式 id（对应 ParagraphProperties.styleId / StyleDef.styleId） */
      styleId: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-jk-para-style'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.styleId ? { 'data-jk-para-style': String(attrs.styleId) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-jk-para-style]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // 无额外可见样式：段落样式的「可见效果」由应用时逐属性下发，避免与字符格式叠加冲突
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});
