/**
 * WriterEditor —— 真实可编辑的 TipTap 文档编辑器（T1.4）。
 *
 * 职责：
 *  - 首次加载：fetch 内置 sample.docx → parseDocx → jkToHtml → setContent
 *  - 打开文件：<input type=file accept=.docx> → parseDocx → setContent
 *  - 保存到文件：getHTML → htmlToJk → exportDocx → Blob 下载
 *  - 工具栏：加粗/斜体/下划线/删除线、H1~H3、对齐、有序/无序列表、插入表格、撤销/重做、打开、保存
 *  - 健壮性：所有解析/导出用 try/catch + toast，失败不白屏
 */

import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from "@tiptap/react";
import { setActiveEditor } from "./editorRef";
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import { ParagraphTextAlign } from './paragraphLayout';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Image from '@tiptap/extension-image';
import { exportDocx, parseDocx } from '@jareking/writer';
import {
  Bold,
  Download,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  Image as ImageIcon,
  List,
  ListOrdered,
  Redo2,
  SeparatorHorizontal,
  Strikethrough,
  Table as TableIcon,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react';

import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { toast } from '../stores/toastStore';
import { htmlToJk } from './htmlToJk';
import { jkToHtml } from './jkToHtml';
import { FontSize } from './fontSize';
import { JkField } from './jkField';
import { largeFileHint } from '../lib/largeFile';

/** 常用字体（中文办公场景），FontFamily 扩展按名应用 */
const FONT_FAMILIES = [
  '宋体',
  '黑体',
  '微软雅黑',
  '楷体',
  '仿宋',
  'Times New Roman',
  'Arial',
  'Calibri',
  'Cambria',
];

/** 常用字号（磅），字号下拉选项 */
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 48, 72];

/** 内置示例文档（位于 public/，Vite 自动复制到 out/renderer，运行时经 BASE_URL 引用） */
const sampleDocxUrl = `${import.meta.env.BASE_URL}sample.docx`;

/** 工具栏按钮：图标 + 激活态高亮 + 点击命令 */
function ToolBtn({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <IconButton
      label={label}
      icon={icon}
      disabled={disabled}
      onClick={onClick}
      className={active ? '!bg-accent/15 !text-accent' : undefined}
    />
  );
}

export function WriterEditor() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [largeHint, setLargeHint] = useState<string | null>(null);

  // 表格底纹（单元格/表头/行/表格四级）保真：默认 table 扩展不保留 background-color，
  // 必须显式加 backgroundColor 属性，才能在编辑器内渲染并在 getHTML 时回写 style，
  // 进而被 htmlToJk 读回模型（否则底纹在打开→编辑→保存后丢失）。
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

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
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
      Image,
      JkField,
    ],
    content: '',
    editorProps: {
      attributes: { class: 'jk-prose focus:outline-none' },
    },
  });
  // AI 面板经 editorRef 取当前编辑器执行 ops（T4.3）
  useEffect(() => {
    if (editor) setActiveEditor(editor);
    return () => setActiveEditor(null);
  }, [editor]);

  // 首次加载示例文档
  useEffect(() => {
    if (!editor) return;
    let cancelled = false;

    (async () => {
      try {
        setDocLoading(true);
        // 让遮罩先绘制，避免大文件解析期间 UI 冻结错觉
        await new Promise((r) => setTimeout(r, 0));
        const res = await fetch(sampleDocxUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        const jk = await parseDocx(buf);
        if (cancelled) return;
        const html = jkToHtml(jk);
        editor.commands.setContent(html, false); // 不触发更新广播，降低加载开销
      } catch {
        if (!cancelled) toast.warning('示例文档加载失败，已创建空白文档');
      } finally {
        if (!cancelled) setDocLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [editor]);

  // 卸载时销毁编辑器
  useEffect(() => {
    return () => {
      editor?.destroy();
    };
  }, [editor]);

  // 调试钩子（自动化冒烟 / 开发检查）：--jk-debug 启动时暴露 HTML 快照与排版能力
  useEffect(() => {
    if (!editor) return;
    if (new URLSearchParams(window.location.search).has('jk-debug')) {
      (window as unknown as Record<string, unknown>).__jkWriterDebug = {
        html: () => editor.getHTML(),
        text: () => editor.getText(),
      };
    }
    return () => {
      delete (window as unknown as Record<string, unknown>).__jkWriterDebug;
    };
  }, [editor]);

  const onOpenFile = () => fileInputRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!file || !editor) return;
    try {
      setDocLoading(true);
      // 让遮罩先绘制，避免大文件解析期间 UI 冻结错觉
      await new Promise((r) => setTimeout(r, 0));
      const buf = new Uint8Array(await file.arrayBuffer());
      const jk = await parseDocx(buf);
      const html = jkToHtml(jk);
      editor.commands.setContent(html, false); // 不触发更新广播，降低加载开销
      setLargeHint(largeFileHint(file.size, 'word'));
      toast.success(`已打开 ${file.name}`);
    } catch {
      toast.warning('打开失败：文件可能不是有效的 .docx');
    } finally {
      setDocLoading(false);
    }
  };

  const onSave = async () => {
    if (!editor) return;
    try {
      const html = editor.getHTML();
      const jk = htmlToJk(html);
      const buf = await exportDocx(jk);
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '导出.docx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('已导出「导出.docx」');
    } catch {
      toast.warning('导出失败：文档包含暂不支持的内容');
    }
  };

  const canFormat = !!editor;

  /** 字体族下拉：应用到当前选区 */
  const onFontFamily = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const fam = e.target.value;
    if (!fam || !editor) return;
    editor.chain().focus().setFontFamily(fam).run();
  };

  /** 字号下拉：应用到当前选区（单位 pt） */
  const onFontSize = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const sz = e.target.value;
    if (!sz || !editor) return;
    editor.chain().focus().setFontSize(`${sz}pt`).run();
  };

  /** 字体颜色：取色器变更即应用到当前选区 */
  const onColor = (e: React.ChangeEvent<HTMLInputElement>) => {
    const color = e.target.value;
    if (!color || !editor) return;
    editor.chain().focus().setColor(color).run();
  };

  /** 插入/编辑超链接：弹窗输入 URL，空则移除链接 */
  const onLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('输入链接地址（留空取消链接）：', prev ?? 'https://');
    if (url === null) return; // 取消
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange('link')
      .setLink({ href: url.trim() })
      .run();
  };

  /** 插入图片：选择本地文件 → 读为 data URL → TipTap Image（保存时由 htmlToJk 落盘为 media） */
  const imageInputRef = useRef<HTMLInputElement>(null);
  const onInsertImage = () => imageInputRef.current?.click();

  const onImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !editor) return;
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      editor.chain().focus().setImage({ src: dataUrl }).run();
      toast.success(`已插入图片 ${file.name}`);
    } catch {
      toast.warning('图片插入失败');
    }
  };

  return (
    <div className="relative flex h-full w-full min-h-0 flex-col">
      {/* 工具栏 */}
      <div className="flex h-10 shrink-0 flex-wrap items-center gap-0.5 border-b border-border bg-surface px-2">
        {/* 字体族 / 字号 */}
        <select
          className="h-7 rounded border border-border bg-surface px-1 text-xs text-text outline-none disabled:opacity-50"
          value={editor?.getAttributes('textStyle').fontFamily ?? ''}
          disabled={!canFormat}
          onChange={onFontFamily}
          title="字体"
        >
          <option value="">字体</option>
          {FONT_FAMILIES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select
          className="h-7 w-14 rounded border border-border bg-surface px-1 text-xs text-text outline-none disabled:opacity-50"
          value={editor?.getAttributes('textStyle').fontSize?.replace('pt', '') ?? ''}
          disabled={!canFormat}
          onChange={onFontSize}
          title="字号"
        >
          <option value="">字号</option>
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {/* 字体颜色 */}
        <label
          className="relative flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-border disabled:opacity-50"
          title="字体颜色"
        >
          <span
            className="h-3.5 w-3.5 rounded-sm border border-border"
            style={{
              backgroundColor:
                (editor?.getAttributes('textStyle').color as string) || '#000000',
            }}
          />
          <input
            type="color"
            className="absolute inset-0 cursor-pointer opacity-0"
            disabled={!canFormat}
            onChange={onColor}
          />
        </label>

        <ToolBtn
          icon={<LinkIcon size={15} />}
          label="超链接"
          active={editor?.isActive('link')}
          disabled={!canFormat}
          onClick={onLink}
        />
        <ToolBtn
          icon={<ImageIcon size={15} />}
          label="插入图片"
          disabled={!canFormat}
          onClick={onInsertImage}
        />

        <span className="mx-1 h-5 w-px bg-border" />

        <ToolBtn
          icon={<Bold size={15} />}
          label="加粗"
          active={editor?.isActive('bold')}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        />
        <ToolBtn
          icon={<Italic size={15} />}
          label="斜体"
          active={editor?.isActive('italic')}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        />
        <ToolBtn
          icon={<UnderlineIcon size={15} />}
          label="下划线"
          active={editor?.isActive('underline')}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
        />
        <ToolBtn
          icon={<Strikethrough size={15} />}
          label="删除线"
          active={editor?.isActive('strike')}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        />

        <span className="mx-1 h-5 w-px bg-border" />

        <ToolBtn
          icon={<Heading1 size={15} />}
          label="标题 1"
          active={editor?.isActive('heading', { level: 1 })}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
        />
        <ToolBtn
          icon={<Heading2 size={15} />}
          label="标题 2"
          active={editor?.isActive('heading', { level: 2 })}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        />
        <ToolBtn
          icon={<Heading3 size={15} />}
          label="标题 3"
          active={editor?.isActive('heading', { level: 3 })}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().setParagraph().run()}
        >
          正文
        </Button>

        <span className="mx-1 h-5 w-px bg-border" />

        <ToolBtn
          icon={<TextAlignStart size={15} />}
          label="左对齐"
          active={editor?.isActive({ textAlign: 'left' })}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().setTextAlign('left').run()}
        />
        <ToolBtn
          icon={<TextAlignCenter size={15} />}
          label="居中"
          active={editor?.isActive({ textAlign: 'center' })}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().setTextAlign('center').run()}
        />
        <ToolBtn
          icon={<TextAlignEnd size={15} />}
          label="右对齐"
          active={editor?.isActive({ textAlign: 'right' })}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().setTextAlign('right').run()}
        />
        <ToolBtn
          icon={<TextAlignJustify size={15} />}
          label="两端对齐"
          active={editor?.isActive({ textAlign: 'justify' })}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().setTextAlign('justify').run()}
        />

        <span className="mx-1 h-5 w-px bg-border" />

        <ToolBtn
          icon={<List size={15} />}
          label="无序列表"
          active={editor?.isActive('bulletList')}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        />
        <ToolBtn
          icon={<ListOrdered size={15} />}
          label="有序列表"
          active={editor?.isActive('orderedList')}
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        />
        <ToolBtn
          icon={<TableIcon size={15} />}
          label="插入表格"
          disabled={!canFormat}
          onClick={() =>
            editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        />
        <ToolBtn
          icon={<SeparatorHorizontal size={15} />}
          label="插入分页符"
          disabled={!canFormat}
          onClick={() => editor?.chain().focus().setHorizontalRule().run()}
        />

        <span className="mx-1 h-5 w-px bg-border" />

        <ToolBtn
          icon={<Undo2 size={15} />}
          label="撤销"
          disabled={!canFormat || !editor?.can().undo()}
          onClick={() => editor?.chain().focus().undo().run()}
        />
        <ToolBtn
          icon={<Redo2 size={15} />}
          label="重做"
          disabled={!canFormat || !editor?.can().redo()}
          onClick={() => editor?.chain().focus().redo().run()}
        />

        <span className="mx-1 h-5 w-px bg-border" />

        <Button variant="secondary" size="sm" icon={<FolderOpen size={13} />} onClick={onOpenFile}>
          打开
        </Button>
        <Button variant="primary" size="sm" icon={<Download size={13} />} onClick={onSave}>
          保存
        </Button>
      </div>

      {/* 大文件非阻塞提示横幅 */}
      {largeHint && (
        <div
          className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-tiny"
          style={{ background: '#FEF3C7', color: '#92400E', borderColor: '#FCD34D' }}
        >
          <span>{largeHint}</span>
          <button
            type="button"
            className="rounded px-1 leading-none hover:bg-black/5"
            onClick={() => setLargeHint(null)}
            title="关闭提示"
          >
            ×
          </button>
        </div>
      )}

      {/* 纸张区 */}
      <div className="min-h-0 flex-1 overflow-auto bg-muted-bg/40 p-8">
        <div className="mx-auto my-0 w-[794px] min-h-[1123px] rounded-sm bg-surface px-16 py-16 shadow-card">
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* 隐藏的文件选择器 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".docx"
        className="hidden"
        onChange={onFileChange}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onImageChange}
      />

      {docLoading && <LoadingOverlay text="正在加载文档…" />}
    </div>
  );
}
