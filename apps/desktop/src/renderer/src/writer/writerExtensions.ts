/**
 * writerExtensions —— Writer 编辑器与页眉页脚 Modal 共用的 TipTap 扩展数组。
 *
 * 抽离自 WriterEditor.tsx 的主编辑器 extensions，供「页眉页脚」对话框复用，
 * 避免重复声明（含自研 FontSize / Color / FontFamily / Link / Image / Field / Formula
 * 以及表格底纹保真所需的 background-color 扩展节点）。
 */

import type { Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { ParagraphTextAlign } from './paragraphLayout';
import { FontSize } from './fontSize';
import { JkField } from './jkField';
import { JkImage } from './jkImage';
import { JkFormula } from './jkFormula';

/**
 * 表格底纹（单元格/表头/行/表格四级）保真：默认 table 扩展不保留 background-color，
 * 必须显式加 backgroundColor 属性，才能在编辑器内渲染并在 getHTML 时回写 style，
 * 进而被 htmlToJk 读回模型（否则底纹在打开→编辑→保存后丢失）。
 */
const backgroundColorAttr = {
  backgroundColor: {
    default: null as string | null,
    parseHTML: (element: HTMLElement) =>
      (element.style.backgroundColor as string) || null,
    renderHTML: (attributes: Record<string, unknown>) =>
      attributes.backgroundColor
        ? { style: `background-color: ${attributes.backgroundColor}` }
        : {},
  },
};

const extendWithBg = (node: any) =>
  node.extend({
    addAttributes() {
      return { ...(this.parent?.() ?? {}), ...backgroundColorAttr };
    },
  });

const TableCellWithBg = extendWithBg(TableCell);
const TableHeaderWithBg = extendWithBg(TableHeader);
const TableRowWithBg = extendWithBg(TableRow);
const TableWithBg = extendWithBg(Table);

/** Writer 编辑器统一扩展集合（主编辑器与页眉页脚 Modal 共用） */
export const writerExtensions: Extensions = [
  StarterKit.configure({
    // 默认 history 提供撤销/重做；保留 strike
    strike: true,
  }),
  Underline,
  TextStyle,
  Color,
  FontFamily,
  FontSize,
  Link.configure({
    openOnClick: false,
    autolink: true,
    HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
  }),
  ParagraphTextAlign.configure({ types: ['heading', 'paragraph'] }),
  TableWithBg.configure({ resizable: true }),
  TableRowWithBg,
  TableHeaderWithBg,
  TableCellWithBg,
  JkImage,
  JkField,
  JkFormula,
];

export { TableCellWithBg, TableHeaderWithBg, TableRowWithBg, TableWithBg };
