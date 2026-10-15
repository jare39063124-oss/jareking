/**
 * FontSize —— 自定义 TipTap 扩展（T1.6）。
 *
 * TipTap 官方未提供字号扩展；本扩展把 `font-size` 挂在 `textStyle` 全局属性上，
 * 与官方 `TextStyle` / `Color` / `FontFamily` 共用同一 mark，渲染为
 * `<span style="font-size: 12pt">`，可被 `htmlToJk` 的 span 样式解析识别。
 */
import { Extension } from '@tiptap/core';
import '@tiptap/extension-text-style';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (fontSize: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
  }
}

export const FontSize = Extension.create({
  name: 'fontSize',

  addOptions() {
    return { types: ['textStyle'] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize:
        (fontSize) =>
        ({ chain }) =>
          chain().setMark('textStyle', { fontSize }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain()
            .setMark('textStyle', { fontSize: null })
            // removeEmptyTextStyle 由 TextStyle 扩展提供；extendEmptyMarkRange 令空的
            // textStyle（仅剩字号被清除后）也一并移除，避免残留空 <span>
            .unsetMark('textStyle', { extendEmptyMarkRange: true })
            .run(),
    };
  },
});
