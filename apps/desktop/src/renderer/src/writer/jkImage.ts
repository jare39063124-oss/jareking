/**
 * jkImage —— 在 TipTap Image 基础上保留 `mediaRelId`（渲染为 data-jk-media 属性）。
 *
 * 用途（#46-B）：编辑器内图片改用 Blob URL 显示后，src 为不可还原的 `blob:uuid`。
 * 若不保留 relId，保存时无法取回模型字节 → 图片丢失。本扩展让 relId 随 DOM 持久化，
 * htmlToJk 据此从 MediaRegistry 取回字节。新插入的图片（data URL）该属性为 null，
 * 仍走 htmlToJk 的 base64 解码分支，互不影响。
 */

import Image from '@tiptap/extension-image';

export const JkImage = Image.extend({
  name: 'image',
  addAttributes() {
    return {
      ...this.parent?.(),
      mediaRelId: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-jk-media') || null,
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.mediaRelId
            ? { 'data-jk-media': attrs.mediaRelId as string }
            : {},
      },
    };
  },
});
