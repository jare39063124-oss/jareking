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
import { FloatingAiBar } from "./FloatingAiBar";
import { FONT_GROUPS } from "./fonts";
import { FindReplaceBar, EditorStatusBar } from "./FindReplaceBar";
import { buildTocEntries, buildTocContent } from "./tocBuilder";
import { takePendingOpen, peekPendingOpen } from "../stores/pendingOpenStore";
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
import { exportDocx, parseDocx } from '@jareking/writer';
import type { Block, JkDocument } from '@jareking/writer';
import {
  applyChunkEdits,
  collectImageRelIds,
  computeChunkRanges,
  extractChunk,
  maxMediaSeq,
  maxRelSeq,
  WRITER_CHUNK_BLOCK_THRESHOLD,
} from './chunking';
import type { ChunkRange } from './chunking';
import {
  Bold,
  Download,
  FolderOpen,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  Image as ImageIcon,
  List,
  ListOrdered,
  ListTree,
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
import { jkToHtml, extToMime } from './jkToHtml';
import { FontSize } from './fontSize';
import { JkField } from './jkField';
import { JkImage } from './jkImage';
import { MediaRegistry } from './mediaRegistry';
import { largeFileHint } from '../lib/largeFile';

/** 从解析后的文档登记图片字节并构建 relId → Blob URL 映射（#46-B） */
function buildMediaMap(
  jk: import('@jareking/writer').JkDocument,
  reg: MediaRegistry,
  relIdFilter?: Set<string>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of jk.relationships ?? []) {
    if (rel.type !== 'image') continue;
    if (relIdFilter && !relIdFilter.has(rel.id)) continue;
    const bytes = jk.media?.[rel.id];
    if (!bytes) continue;
    const ext = (rel.target.split('.').pop() ?? 'png').toLowerCase();
    reg.set(rel.id, bytes, extToMime(ext));
    const url = reg.blobUrl(rel.id);
    if (url) map.set(rel.id, url);
  }
  return map;
}

/** 常用字体（版权合规分组，见 docs/fonts.md 与 writer/fonts.ts） */
// FONT_FAMILIES 已迁移至 writer/fonts.ts 的 FONT_GROUPS（系统/OFL/厂商免费商用 三组）

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

  // 图片 Blob URL 注册表（#46-B）：加载时登记字节 + 创建 Blob URL，卸载/换文档时 revoke
  const mediaRegistryRef = useRef<MediaRegistry>();
  if (!mediaRegistryRef.current) mediaRegistryRef.current = new MediaRegistry();

  // #46-A 分块编辑：完整文档留内存作真源；编辑器只渲染 body 的一个切片，DOM 节点数受限
  const fullDocRef = useRef<JkDocument | null>(null);
  const chunkRangesRef = useRef<ChunkRange[]>([]);
  const currentRangeRef = useRef<ChunkRange>({ start: 0, end: 0 });
  const [chunkMode, setChunkMode] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  // 镜像 ref，供调试钩子读取实时值（避免闭包捕获初始 state）
  const chunkModeRef = useRef(false);
  const chunkIndexRef = useRef(0);

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
      JkImage,
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

  // 查找/替换（T1.7 自研落地）：Ctrl+F 查找、Ctrl+H 替换
  const [showFind, setShowFind] = useState(false);
  const [findMode, setFindMode] = useState<'find' | 'replace'>('find');
  useEffect(() => {
    if (!editor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setFindMode('find');
        setShowFind(true);
      } else if (e.ctrlKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault();
        setFindMode('replace');
        setShowFind(true);
      } else if (e.key === 'Escape' && showFind) {
        setShowFind(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, showFind]);

  // #46-A 分块编辑核心：完整文档在内存作真源，编辑器只渲染 body 的一个切片
  /** 把当前编辑器内容解析并写回整文对应切片（切换/保存前调用） */
  const flushCurrentChunk = () => {
    const ed = editor;
    const full = fullDocRef.current;
    if (!ed || !full) return;
    const range = currentRangeRef.current;
    const html = ed.getHTML();
    const mediaBytes = new Map<string, Uint8Array>();
    for (const [, e] of mediaRegistryRef.current!.entries()) mediaBytes.set(e.relId, e.bytes);
    // 续号起点：避免分块内新生成的 rId 与整文既有关系冲突
    const edited = htmlToJk(html, mediaBytes, maxRelSeq(full), maxMediaSeq(full));
    applyChunkEdits(full, range, edited.body, edited);
  };

  /** 渲染某个切片到编辑器 */
  const renderChunk = (
    index: number,
    docOverride?: JkDocument,
    rangesOverride?: ChunkRange[],
  ) => {
    const ed = editor;
    const doc = docOverride ?? fullDocRef.current;
    if (!ed || !doc) return;
    const ranges = rangesOverride ?? chunkRangesRef.current;
    const clamped = Math.max(0, Math.min(index, ranges.length - 1));
    const range = ranges[clamped];
    const reg = mediaRegistryRef.current!;
    reg.clear();
    const chunkDoc = extractChunk(doc, range);
    const relIds = collectImageRelIds(chunkDoc);
    const mediaMap = buildMediaMap(chunkDoc, reg, relIds);
    const html = jkToHtml(chunkDoc, mediaMap);
    ed.commands.setContent(html, false);
    currentRangeRef.current = range;
    setChunkIndex(clamped);
    chunkIndexRef.current = clamped;
  };

  /** 切换切片：先写回当前切片，再重算区间（长度可能变化）并渲染目标切片 */
  const goToChunk = (index: number) => {
    const full = fullDocRef.current;
    if (!full || !editor) return;
    flushCurrentChunk();
    const ranges = computeChunkRanges(full.body.length);
    chunkRangesRef.current = ranges;
    renderChunk(index);
  };

  /** 载入解析后的文档：决定分块模式并渲染首屏（#46-A 入口） */
  const loadDocument = (jk: JkDocument) => {
    const reg = mediaRegistryRef.current!;
    reg.clear();
    fullDocRef.current = jk;
    const ranges = computeChunkRanges(jk.body.length);
    chunkRangesRef.current = ranges;
    const isChunked = jk.body.length > WRITER_CHUNK_BLOCK_THRESHOLD && ranges.length > 1;
    setChunkMode(isChunked);
    chunkModeRef.current = isChunked;
    if (isChunked) {
      renderChunk(0, jk, ranges);
    } else {
      const mediaMap = buildMediaMap(jk, reg);
      const html = jkToHtml(jk, mediaMap);
      editor!.commands.setContent(html, false);
    }
  };

  // 首次加载示例文档（若有「最近文档待打开」则跳过，避免异步竞态覆盖）
  useEffect(() => {
    if (!editor) return;
    if (peekPendingOpen()) return;
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
        loadDocument(jk);
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

  // 最近文档直达（WPS 对齐 N5）：消费首页「最近使用」点击（挂载后一次性）
  useEffect(() => {
    if (!editor) return;
    const p = takePendingOpen();
    if (!p || p.module !== 'writer' || !/\.docx$/i.test(p.path)) return;
    let cancelled = false;
    void (async () => {
      try {
        setDocLoading(true);
        const bytes = await window.jareking.invoke<Uint8Array | null>('doc:read-file', { path: p.path });
        if (cancelled) return;
        if (!bytes) {
          toast.warning('文件已不存在或无法读取');
          return;
        }
        const jk = await parseDocx(new Uint8Array(bytes));
        if (cancelled) return;
        loadDocument(jk);
        toast.success(`已打开 ${p.name}`);
      } catch (err) {
        if (!cancelled) toast.warning(`打开失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (!cancelled) setDocLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editor]);

  // 卸载时销毁编辑器并释放 Blob URL
  useEffect(() => {
    return () => {
      editor?.destroy();
      mediaRegistryRef.current?.revokeAll();
    };
  }, [editor]);

  // 调试钩子（自动化冒烟 / 开发检查）：--jk-debug 启动时暴露 HTML 快照与排版能力
  useEffect(() => {
    if (!editor) return;
    if (new URLSearchParams(window.location.search).has('jk-debug')) {
      (window as unknown as Record<string, unknown>).__jkWriterDebug = {
        html: () => editor.getHTML(),
        text: () => editor.getText(),
        // #46-A 验证：载入合成大文档（count 个段落），触发分块分页模式
        loadLargeTest: (count = 2000) => {
          const body: Block[] = [];
          for (let i = 0; i < count; i++) {
            body.push({
              type: 'paragraph',
              runs: [{ type: 'run', text: `测试段落 ${i}` }],
            } as Block);
          }
          const doc = {
            body,
            sections: [],
            styleDefs: { styles: [] },
            numberingDefs: { abstractNum: [], num: [] },
            settings: {},
            relationships: [],
            fidelity: { level: 'L2' as const, features: [] },
          } as unknown as JkDocument;
          loadDocument(doc);
        },
        // #46-A 验证：读取当前是否为分块模式与分页信息（实时值）
        chunkInfo: () => ({
          chunkMode: chunkModeRef.current,
          chunkIndex: chunkIndexRef.current,
          total: chunkRangesRef.current.length,
        }),
        // #46-A 验证：跳转到指定切片
        goToChunk: (i: number) => goToChunk(i),
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
      loadDocument(jk);
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
      let jk: JkDocument;
      if (chunkMode && fullDocRef.current) {
        // #46-A：先把当前切片写回整文，再导出完整文档（保存无损）
        flushCurrentChunk();
        jk = fullDocRef.current;
      } else {
        // 凭注册表字节还原 Blob URL 图片（#46-B），新插入的 data URL 图片由 htmlToJk 解码
        const html = editor.getHTML();
        const mediaBytes = new Map<string, Uint8Array>();
        for (const [, e] of mediaRegistryRef.current!.entries()) mediaBytes.set(e.relId, e.bytes);
        jk = htmlToJk(html, mediaBytes);
      }
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
          {FONT_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label} title={group.note}>
              {group.fonts.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
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
        <ToolBtn
          icon={<Hash size={15} />}
          label="插入页码"
          disabled={!canFormat}
          onClick={() => {
            if (!editor) return;
            editor
              .chain()
              .focus()
              .insertContent({ type: 'jkField', attrs: { instr: 'PAGE', result: '1' } })
              .run();
          }}
        />
        <ToolBtn
          icon={<ListTree size={15} />}
          label="插入目录"
          disabled={!canFormat}
          onClick={() => {
            if (!editor) return;
            const entries = buildTocEntries(editor.state.doc);
            if (!entries.length) {
              toast.warning('文档中没有标题，先设置标题层级再插入目录');
              return;
            }
            editor.chain().focus().insertContent(buildTocContent(entries)).run();
            toast.success(`已插入目录（${entries.length} 个条目）`);
          }}
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

      {/* #46-A 分块分页条：仅大文档出现，DOM 节点数受切片大小约束 */}
      {chunkMode && (
        <div className="flex h-8 shrink-0 items-center justify-center gap-2 border-b border-border bg-surface text-xs text-text">
          <button
            type="button"
            className="rounded px-2 py-0.5 disabled:opacity-40 hover:bg-black/5"
            disabled={chunkIndex <= 0}
            onClick={() => goToChunk(chunkIndex - 1)}
            title="上一段"
          >
            ‹
          </button>
          <span className="tabular-nums">
            第 {chunkIndex + 1} / {chunkRangesRef.current.length} 段
          </span>
          <select
            className="h-6 rounded border border-border bg-surface px-1 text-xs outline-none"
            value={chunkIndex}
            onChange={(e) => goToChunk(Number(e.target.value))}
            title="跳转到指定段"
          >
            {chunkRangesRef.current.map((_, i) => (
              <option key={i} value={i}>
                第 {i + 1} 段
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded px-2 py-0.5 disabled:opacity-40 hover:bg-black/5"
            disabled={chunkIndex >= chunkRangesRef.current.length - 1}
            onClick={() => goToChunk(chunkIndex + 1)}
            title="下一段"
          >
            ›
          </button>
        </div>
      )}

      {/* 纸张区 */}
      <div className="relative min-h-0 flex-1 overflow-auto bg-muted-bg/40 p-8">
        {/* Ctrl+F/H 查找替换条 */}
        {editor && showFind && (
          <FindReplaceBar editor={editor} initialMode={findMode} onClose={() => setShowFind(false)} />
        )}
        <div className="mx-auto my-0 w-[794px] min-h-[1123px] rounded-sm bg-surface px-16 py-16 shadow-card">
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* 状态栏：字数统计（WPS 口径） */}
      {editor && <EditorStatusBar editor={editor} />}

      {/* T4.4 选中浮动 AI 工具条（选区非空时浮出） */}
      {editor && <FloatingAiBar editor={editor} />}

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
