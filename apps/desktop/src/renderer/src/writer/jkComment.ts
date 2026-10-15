/**
 * jkComment —— TipTap 自定义 mark，承载 Writer 批注（WPS 对齐：批注协作功能）。
 *
 * 作用：让选区文本带上批注锚点，并在编辑器内以「高亮底色 + 波浪下划线」呈现；
 * 已解决的批注以灰色删除线样式弱化显示。
 *  - parseHTML：识别 span[data-jk-comment]（由 jkToHtml 生成）
 *  - renderHTML：还原为带 data-jk-comment / data-jk-resolved 的 span
 *  - 保存时 htmlToJk 读回 span[data-jk-comment] → Paragraph.commentRanges，
 *    writer 包再导出为 w:commentRangeStart/End/reference（Word/WPS 原生批注）。
 *
 * 与模型字段对应关系：attrs.commentId ↔ JkComment.id / CommentRange.id。
 */
import { Mark, mergeAttributes } from '@tiptap/core';

/** 批注 mark 名称（命令总线与 htmlToJk 共用，避免魔法字符串） */
export const JK_COMMENT_MARK = 'jkComment';

export const JkCommentMark = Mark.create({
  name: JK_COMMENT_MARK,

  // 选区边界处插入文本时不自动延伸批注范围（避免误扩）
  inclusive: false,

  addAttributes() {
    return {
      /** 批注 id（对应 JkComment.id / w:id） */
      commentId: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-jk-comment'),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.commentId ? { 'data-jk-comment': String(attrs.commentId) } : {},
      },
      /** 是否已解决（仅影响显示样式，true 时加 data-jk-resolved="1"） */
      resolved: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-jk-resolved') === '1',
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.resolved ? { 'data-jk-resolved': '1' } : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-jk-comment]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const resolved = HTMLAttributes['data-jk-resolved'] === '1';
    const style = resolved
      ? 'background-color:transparent;text-decoration:line-through;color:#9CA3AF;'
      : 'background-color:#FEF9C3;border-bottom:1px dashed #EAB308;';
    return ['span', mergeAttributes(HTMLAttributes, { class: 'jk-comment', style }), 0];
  },
});
