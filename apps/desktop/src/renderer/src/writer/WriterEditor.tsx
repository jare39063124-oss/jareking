/**
 * WriterEditor —— 真实可编辑的 TipTap 文档编辑器（T1.4）。
 *
 * 职责：
 *  - 首次加载：fetch 内置 sample.docx → parseDocx → jkToHtml → setContent
 *  - 打开文件：<input type=file accept=.docx> → parseDocx → setContent
 *  - 保存到文件：getHTML → htmlToJk → exportDocx → Blob 下载
 *  - 对外命令：把全部编辑能力注册到命令总线（stores/editorCommands.ts），由 Ribbon 驱动
 *    （布局瘦身：编辑器自带工具栏已移除，垂直空间全部还给文档区）
 *  - 健壮性：所有解析/导出用 try/catch + toast，失败不白屏
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor } from "@tiptap/react";
import { setActiveEditor } from "./editorRef";
import { FloatingAiBar } from "./FloatingAiBar";
import { FindReplaceBar, EditorStatusBar } from "./FindReplaceBar";
import { buildTocEntries, buildTocContent } from "./tocBuilder";
import { takePendingOpen, peekPendingOpen } from "../stores/pendingOpenStore";
import { JkFormula } from "./jkFormula";
import { JK_COMMENT_MARK } from "./jkComment";
import { JK_NOTE_REF } from "./jkNoteRef";
import { JK_PARAGRAPH_STYLE } from "./jkParagraphStyle";
import { linearToOmml, validateLinearFormula } from "@jareking/writer";
import { Modal } from "../components/Modal";
import { Input } from "../components/Input";
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import { exportDocx, parseDocx } from '@jareking/writer';
// 样式管理器纯函数（packages/writer/src/styleManager.ts）
import {
  cloneStyleDef,
  groupStyles,
  makeUniqueStyleId,
  resolveParagraphAttrs,
} from '@jareking/writer';
import type {
  Alignment,
  Block,
  Inline,
  JkComment,
  JkDocument,
  JkNote,
  ParagraphProperties,
  Run,
  RunProperties,
  Section,
  StyleDef,
  StyleSheet,
} from '@jareking/writer';
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
import { Link as LinkIcon, Sigma, Hash, PanelTop, PanelBottom, Bold, Italic, Underline as UnderlineIcon, MessageSquarePlus, Footprints, Columns2, Plus, Trash2, Check } from 'lucide-react';

import { Button } from '../components/Button';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { toast } from '../stores/toastStore';
import { htmlToJk } from './htmlToJk';
import { jkToHtml, extToMime } from './jkToHtml';
import { writerExtensions } from './writerExtensions';
import { JkTrackChanges } from './jkRevision';
import { MediaRegistry } from './mediaRegistry';
import { largeFileHint } from '../lib/largeFile';
import { downloadBlob } from '../lib/download';
import { buildPrintDocument } from '../lib/printHtml';
import { exportHtmlToPdf } from '../lib/pdfExport';
import { FONT_SIZES } from '../lib/fonts';
import { useUiStore } from '../stores/uiStore';
import {
  notifyEditorChange,
  registerEditorCommands,
  type EditorCommand,
} from '../stores/editorCommands';

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

/** 内置示例文档（位于 public/，Vite 自动复制到 out/renderer，运行时经 BASE_URL 引用） */
const sampleDocxUrl = `${import.meta.env.BASE_URL}sample.docx`;

/** A4 纸张宽度（px，96dpi）——缩放包裹层按 794 * zoom 计算，保证滚动区与光标定位正确 */
const PAGE_WIDTH_PX = 794;

/** 现有批注中的最大数字 id（新批注 id = max + 1，避免与既有/已解析批注冲突） */
function maxCommentId(list: JkComment[]): number {
  return list.reduce((max, c) => {
    const n = Number(c.id);
    return Number.isFinite(n) ? Math.max(max, n) : max;
  }, 0);
}

/** 批注时间展示（ISO → MM-DD HH:mm；无效/缺失返回空串） */
function formatCommentTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 脚注/尾注条目 → 纯文本（段落以 \n 连接，便于在 Modal 内编辑） */
function noteToText(note: JkNote): string {
  return (note.blocks ?? [])
    .map((b) =>
      b.type === 'paragraph'
        ? b.runs.map((r) => (r.type === 'run' ? r.text : '')).join('')
        : '',
    )
    .join('\n');
}

/** 纯文本 → 脚注/尾注条目块（按行拆分为段落，空行保留为空段落） */
function textToNoteBlocks(text: string): Block[] {
  return text.split('\n').map((line) =>
    line ? ({ type: 'paragraph', runs: [{ type: 'run', text: line }] } as Block) : ({ type: 'paragraph', runs: [] } as Block),
  );
}

/** 现有脚注/尾注中的最大数字 id（新 id = max + 1，且至少为 1） */
function maxNoteId(list: JkNote[]): number {
  return list.reduce((max, n) => {
    const v = Number(n.id);
    return Number.isFinite(v) ? Math.max(max, v) : max;
  }, 0);
}

/* -------------------- 样式管理器（WPS 对齐）辅助 -------------------- */

/** 模型对齐方式（w:jc）→ 样式管理器下拉/命令取值（left/center/right/justify；其它返回空串） */
function jcToUi(jc?: Alignment): '' | 'left' | 'center' | 'right' | 'justify' {
  switch (jc) {
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'justify':
    case 'both':
    case 'distribute':
      return 'justify';
    case 'left':
    case 'start':
      return 'left';
    default:
      return '';
  }
}

/** 样式管理器下拉取值 → 模型对齐方式（非四值之一返回 undefined） */
function uiToJc(ui: string): Alignment | undefined {
  if (ui === 'left' || ui === 'center' || ui === 'right' || ui === 'justify') return ui;
  return undefined;
}

/**
 * 样式管理器「属性摘要」文案：把有效属性（pPr + rPr）拼为一段人类可读文本。
 * 无任何可展示属性时返回「（无格式属性）」。
 */
function styleAttrSummary(attrs: {
  pPr: ParagraphProperties;
  rPr: RunProperties;
}): string {
  const parts: string[] = [];
  const { pPr, rPr } = attrs;
  const fam = rPr.font?.eastAsia ?? rPr.font?.ascii ?? rPr.font?.hAnsi;
  if (fam) parts.push(`字体 ${fam}`);
  if (rPr.size !== undefined) parts.push(`字号 ${rPr.size / 2}pt`);
  if (rPr.bold) parts.push('加粗');
  if (rPr.italic) parts.push('斜体');
  if (rPr.underline && rPr.underline !== 'none') parts.push('下划线');
  if (rPr.color) parts.push(`颜色 #${rPr.color}`);
  const jc = jcToUi(pPr.jc);
  if (jc) parts.push(`对齐 ${jc === 'justify' ? '两端' : jc === 'center' ? '居中' : jc === 'right' ? '右' : '左'}`);
  return parts.length ? parts.join(' · ') : '（无格式属性）';
}

/**
 * 按「接受 / 拒绝」改写一组行内元素上的修订（纯函数，返回新数组）。
 *
 * - 接受（accept）：插入修订 → 清除 revision 标记（内容保留）；删除修订 → 丢弃该 run。
 * - 拒绝（reject）：删除修订 → 清除 revision 标记（还原文本）；插入修订 → 丢弃该 run。
 *
 * 无修订的 run 原样保留；超链接内的 runs 递归处理。用于「接受/拒绝所有修订」。
 */
function rewriteInlineList(runs: Inline[], mode: 'accept' | 'reject'): Inline[] {
  const kept: Inline[] = [];
  for (const inl of runs) {
    if (inl.type === 'run') {
      const rev = (inl as Run).revision;
      if (!rev) {
        kept.push(inl);
        continue;
      }
      const isInsert = rev.kind === 'insert';
      const keep = mode === 'accept' ? isInsert : !isInsert;
      if (keep) {
        // 接受插入 / 拒绝删除：清除修订标记（保留文本）
        const { revision, ...rest } = inl as Run;
        void revision;
        kept.push(rest as Inline);
      }
      // 否则丢弃该 run（接受删除 / 拒绝插入）
    } else if (inl.type === 'hyperlink') {
      kept.push({ ...inl, runs: rewriteInlineList(inl.runs, mode) });
    } else {
      kept.push(inl);
    }
  }
  return kept;
}

/** 递归改写块级元素（含段落、嵌套表格）上的修订；直接修改传入的 blocks */
function rewriteRevisions(blocks: Block[], mode: 'accept' | 'reject'): void {
  for (const b of blocks) {
    if (b.type === 'paragraph') {
      b.runs = rewriteInlineList(b.runs, mode);
    } else if (b.type === 'table') {
      for (const row of b.rows) {
        for (const cell of row.cells) rewriteRevisions(cell.blocks, mode);
      }
    }
  }
}

export function WriterEditor() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [largeHint, setLargeHint] = useState<string | null>(null);

  // 文档区缩放（Ribbon「视图」/ 状态栏共享）
  const writerZoom = useUiStore((state) => state.writerZoom);

  // 图片 Blob URL 注册表（#46-B）：加载时登记字节 + 创建 Blob URL，卸载/换文档时 revoke
  const mediaRegistryRef = useRef<MediaRegistry | undefined>(undefined);
  if (!mediaRegistryRef.current) mediaRegistryRef.current = new MediaRegistry();

  /** 导出 PDF 调试探针（--jk-debug）：与 onExportPdf 同路径构建 HTML，但不下载，直接取字节 */
  const pdfProbeRef = useRef<() => Promise<{ size: number; head: string }>>(async () => ({
    size: 0,
    head: '',
  }));

  // #46-A 分块编辑：完整文档留内存作真源；编辑器只渲染 body 的一个切片，DOM 节点数受限
  const fullDocRef = useRef<JkDocument | null>(null);
  const chunkRangesRef = useRef<ChunkRange[]>([]);
  const currentRangeRef = useRef<ChunkRange>({ start: 0, end: 0 });
  const [chunkMode, setChunkMode] = useState(false);
  const [chunkIndex, setChunkIndex] = useState(0);
  // 镜像 ref，供调试钩子读取实时值（避免闭包捕获初始 state）
  const chunkModeRef = useRef(false);
  const chunkIndexRef = useRef(0);

  // 页眉/页脚（WPS 对齐）：当前文档的页眉/页脚内容（Block[]）。
  // 用 ref 持有最新值，保存时直接读取；同时用 state 触发 Modal 初始渲染。
  const [hfOpen, setHfOpen] = useState(false);
  const hfRef = useRef<{ header: Block[]; footer: Block[] }>({ header: [], footer: [] });
  // 页眉页脚对话框内的两个独立 TipTap 实例（顶/底各一个），始终挂载以便内容留存
  const hfHeaderEditor = useEditor({ extensions: writerExtensions, content: '', immediatelyRender: false });
  const hfFooterEditor = useEditor({ extensions: writerExtensions, content: '', immediatelyRender: false });
  const [hfTab, setHfTab] = useState<'header' | 'footer'>('header');

  // 批注（WPS 对齐：协作功能）：文档级批注列表（内存态，用 ref 持有，参照 hfRef 模式）。
  // 行内锚点存在于编辑器 mark（jkComment）与模型 Paragraph.commentRanges 中；
  // 保存时把本 ref 注入 jk.comments，并随正文锚点一并落盘为 word/comments.xml。
  const commentsRef = useRef<JkComment[]>([]);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentInput, setCommentInput] = useState('');
  const [commentPanelOpen, setCommentPanelOpen] = useState(false);
  // 面板重渲染信号（ref 变更不触发渲染，用 tick 强制刷新）
  const [commentTick, setCommentTick] = useState(0);
  // 打开批注 Modal 时暂存的选区（Modal 获得焦点后编辑器选区可能变化，需固定范围）
  const pendingCommentRangeRef = useRef<{ from: number; to: number } | null>(null);

  // —— 脚注 / 尾注（WPS 对齐：引用）——
  // 文档级脚注/尾注条目（内存态，用 ref 持有，参照 commentsRef 模式）；
  // 正文引用由编辑器 jkNoteRef 节点与模型 Paragraph 内的 FootnoteRef 承载，
  // 保存时把本 ref 注入 jk.footnotes / jk.endnotes，并落盘为 footnotes.xml / endnotes.xml。
  const notesRef = useRef<{ footnotes: JkNote[]; endnotes: JkNote[] }>({ footnotes: [], endnotes: [] });
  const [notesOpen, setNotesOpen] = useState(false);
  // 面板/编辑区重渲染信号（ref 变更不触发渲染，用 tick 强制刷新）
  const [notesTick, setNotesTick] = useState(0);

  // —— 分栏（WPS 对齐：页面布局）——
  // 当前节的分栏设置（内存态）；保存时注入 jk.sections[0].columns，导出为 sectPr/w:cols。
  const columnsRef = useRef<Section['columns']>(undefined);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [colCount, setColCount] = useState(2);
  const [colSep, setColSep] = useState(false);

  // —— 样式管理器（WPS 对齐：样式）——
  // 样式定义表真源：以 ref 持有（保存时注入导出模型；分块模式与 fullDocRef.styleDefs 同引用）。
  // 段落引用该样式经 jkParagraphStyle mark 往返（见 jkParagraphStyle / jkToHtml / htmlToJk）。
  const styleDefsRef = useRef<StyleSheet>({ styles: [] });
  const [styleOpen, setStyleOpen] = useState(false);
  // ref 变更不触发渲染，用 tick 强制刷新列表/摘要
  const [styleTick, setStyleTick] = useState(0);
  const [styleSelectedId, setStyleSelectedId] = useState('');
  // 编辑表单字段（新建样式 / 覆盖修改共用）
  const [styleName, setStyleName] = useState('');
  const [styleType, setStyleType] = useState<StyleDef['styleType']>('paragraph');
  const [styleFontSize, setStyleFontSize] = useState('');
  const [styleFontFamily, setStyleFontFamily] = useState('');
  const [styleBold, setStyleBold] = useState(false);
  const [styleItalic, setStyleItalic] = useState(false);
  const [styleColor, setStyleColor] = useState('#000000');
  const [styleAlign, setStyleAlign] = useState('');

  // 表格底纹（单元格/表头/行/表格四级）保真逻辑与统一扩展集合见 ./writerExtensions。
  // 主编辑器与「页眉页脚」Modal 共用 writerExtensions，避免重复声明。

  // —— 修订（track changes）——
  // revisionMode：修订模式开关（关闭时不产生任何实时修订，普通编辑路径不受影响）。
  // 用 ref 镜像供插件 options.enabled 实时读取（避免闭包捕获初始值）。
  const [revisionMode, setRevisionMode] = useState(false);
  const revisionModeRef = useRef(false);
  // 主编辑器扩展 = 共享扩展 + 修订插件（插件只挂主编辑器；页眉页脚不挂）
  const editorExtensions = useMemo(
    () =>
      [
        ...writerExtensions,
        JkTrackChanges.configure({
          enabled: () => revisionModeRef.current,
          author: () => '我',
        }),
      ],
    [],
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions: editorExtensions,
    content: '',
    editorProps: {
      attributes: { class: 'jk-prose focus:outline-none' },
    },
    // 事务 / 选区变化 → 通知命令总线，Ribbon 的激活态与控件取值实时刷新
    onTransaction: () => notifyEditorChange(),
    onSelectionUpdate: () => notifyEditorChange(),
  });
  // AI 面板经 editorRef 取当前编辑器执行 ops（T4.3）
  useEffect(() => {
    if (editor) setActiveEditor(editor);
    return () => setActiveEditor(null);
  }, [editor]);

  // 查找/替换（T1.7 自研落地）：Ctrl+F 查找、Ctrl+H 替换
  const [showFind, setShowFind] = useState(false);
  /** 插入公式对话框（WPS 对齐：公式）—— 用 Modal 而非 window.prompt（原生弹窗阻断自动化） */
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [formulaInput, setFormulaInput] = useState('x^2+y^2=z^2');
  const [formulaError, setFormulaError] = useState<string | null>(null);
  /** 插入超链接对话框 —— 同样用 Modal（禁止 window.prompt） */
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkInput, setLinkInput] = useState('');
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
    // 回填样式定义表（缺省为空表）：样式管理器与保存注入的真源；
    // 与 fullDocRef.styleDefs 同一对象引用，分块写回不会丢失定义。
    if (!jk.styleDefs) jk.styleDefs = { styles: [] };
    styleDefsRef.current = jk.styleDefs;
    setStyleTick((t) => t + 1);
    // 回填当前文档的页眉/页脚内容（缺省为空数组）
    hfRef.current = {
      header: jk.sections?.[0]?.header ?? [],
      footer: jk.sections?.[0]?.footer ?? [],
    };
    // 回填当前文档的批注列表（深拷贝，避免污染解析结果）
    commentsRef.current = (jk.comments ?? []).map((c) => ({ ...c }));
    setCommentTick((t) => t + 1);
    // 回填脚注/尾注条目（深拷贝）与当前节分栏设置
    notesRef.current = {
      footnotes: (jk.footnotes ?? []).map((n) => ({ ...n, blocks: [...n.blocks] })),
      endnotes: (jk.endnotes ?? []).map((n) => ({ ...n, blocks: [...n.blocks] })),
    };
    setNotesTick((t) => t + 1);
    columnsRef.current = jk.sections?.[0]?.columns ? { ...jk.sections[0].columns } : undefined;
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
        // 导出 PDF 探针（QA 冒烟）：走与 onExportPdf 相同的 HTML 构建路径，但不下载，
        // 直接返回可跨 CDP 序列化的 { size, head }（head 期望为 '%PDF-'）
        pdfProbe: () => pdfProbeRef.current(),
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

  /** 把内存态的脚注/尾注与分栏设置注入导出模型（分块/非分块两路保存共用） */
  const applyNotesAndColumns = (jk: JkDocument): void => {
    if (!jk.sections || jk.sections.length === 0) jk.sections = [{ type: 'section' }];
    jk.sections[0].columns = columnsRef.current;
    jk.footnotes = notesRef.current.footnotes.length ? notesRef.current.footnotes : undefined;
    jk.endnotes = notesRef.current.endnotes.length ? notesRef.current.endnotes : undefined;
  };

  /** 从编辑器取回当前模型（非分块模式的真源）：HTML → JkDocument，并注入页眉页脚与批注 */
  const collectModelFromEditor = (): JkDocument => {
    const html = editor!.getHTML();
    const mediaBytes = new Map<string, Uint8Array>();
    for (const [, e] of mediaRegistryRef.current!.entries()) mediaBytes.set(e.relId, e.bytes);
    const jk = htmlToJk(html, mediaBytes);
    if (!jk.sections || jk.sections.length === 0) jk.sections = [{ type: 'section' }];
    jk.sections[0].header = hfRef.current.header;
    jk.sections[0].footer = hfRef.current.footer;
    jk.comments = commentsRef.current.length ? commentsRef.current : undefined;
    applyNotesAndColumns(jk);
    return jk;
  };

  const onSave = async () => {
    if (!editor) return;
    try {
      let jk: JkDocument;
      if (chunkModeRef.current && fullDocRef.current) {
        // #46-A：先把当前切片写回整文，再导出完整文档（保存无损）
        flushCurrentChunk();
        jk = fullDocRef.current;
      } else {
        // 非分块模式：编辑器即真源，取回模型（含 Blob URL 图片字节还原，#46-B）
        jk = collectModelFromEditor();
      }
      // 注入页眉/页脚（两路保存都注入）：确保非分块模式也能保留页眉页脚，
      // 并顺带修复非分块模式丢失 sections 的潜在问题（仅动 header/footer，不改 sections 其它字段）。
      if (!jk.sections || jk.sections.length === 0) {
        jk.sections = [{ type: 'section' }];
      }
      jk.sections[0].header = hfRef.current.header;
      jk.sections[0].footer = hfRef.current.footer;
      // 注入批注（两路保存都注入）：正文锚点由 htmlToJk/jkToHtml 往返，批注正文来自 ref
      jk.comments = commentsRef.current.length ? commentsRef.current : undefined;
      // 注入脚注/尾注与分栏设置（两路保存都注入）
      applyNotesAndColumns(jk);
      // 注入样式定义表（两路保存都注入）：确保新建/修改/删除的样式能落盘。
      // 说明：非分块模式的模型由 htmlToJk 从 HTML 重建（styleDefs 为空），
      // 故此处以 styleDefsRef 覆盖；分块模式二者本就同引用，覆盖无副作用。
      jk.styleDefs = styleDefsRef.current;
      const buf = await exportDocx(jk);
      downloadBlob(
        buf,
        '导出.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      toast.success('已导出「导出.docx」');
    } catch {
      toast.warning('导出失败：文档包含暂不支持的内容');
    }
  };

  /**
   * 构建打印用 HTML（导出 PDF 与调试探针共用同一条 HTML 构建路径）。
   * 分块模式先写回当前切片取整文；非分块模式从编辑器取回最新模型。
   * `jkToHtml(jk)` 不传 mediaMap —— 纯函数语义会把图片内联为 data URL，正是打印所需。
   */
  const buildPdfHtml = (): string => {
    let jk: JkDocument;
    if (chunkModeRef.current && fullDocRef.current) {
      flushCurrentChunk();
      jk = fullDocRef.current;
    } else {
      jk = collectModelFromEditor();
    }
    const body = jkToHtml(jk);
    // 纸张宽度相关 CSS：正文占满页宽，图片/表格不溢出
    const extraCss = '.jk-prose{max-width:100%;}img{max-width:100%;}table{max-width:100%;}';
    return buildPrintDocument({ title: '导出', bodyHtml: body, extraCss });
  };

  /** 导出 PDF：经 Electron 打印管线生成 PDF 并交给统一下载助手 */
  const onExportPdf = async () => {
    if (!editor) return;
    try {
      const html = buildPdfHtml();
      await exportHtmlToPdf({ html, fileName: '导出.pdf' });
      toast.success('已导出「导出.pdf」');
    } catch (err) {
      toast.warning('导出 PDF 失败：' + (err instanceof Error ? err.message : String(err)));
    }
  };

  /**
   * 接受 / 拒绝所有修订：真实改写文档模型并刷新编辑器。
   * - accept：删除所有删除修订、清除插入修订标记；
   * - reject：移除所有插入修订、清除删除修订标记并还原文本。
   * 分块模式先写回当前切片；非分块模式从编辑器取回最新模型，避免丢失未保存编辑。
   */
  const applyRevisions = (mode: 'accept' | 'reject') => {
    let doc: JkDocument | null = null;
    if (chunkModeRef.current && fullDocRef.current) {
      flushCurrentChunk();
      doc = fullDocRef.current;
    } else if (editor) {
      doc = collectModelFromEditor();
      fullDocRef.current = doc;
    }
    if (!doc) {
      toast.warning('当前没有可处理的文档');
      return;
    }
    rewriteRevisions(doc.body, mode);
    loadDocument(doc);
    toast.success(mode === 'accept' ? '已接受所有修订' : '已拒绝所有修订');
  };

  // 命令总线里的接受/拒绝命令要读到最新闭包（命令只在 editor 变化时注册），用 ref 同步
  const applyRevisionsRef = useRef<(mode: 'accept' | 'reject') => void>(() => {});
  useEffect(() => {
    applyRevisionsRef.current = applyRevisions;
  });

  // 保存命令要读到最新闭包（命令只在 editor 变化时注册），用 ref 同步
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveRef.current = () => void onSave();
  });

  // 导出 PDF 命令要读到最新闭包（命令只在 editor 变化时注册），用 ref 同步
  const exportPdfRef = useRef<() => void>(() => {});
  useEffect(() => {
    exportPdfRef.current = () => void onExportPdf();
    pdfProbeRef.current = async () => {
      const html = buildPdfHtml();
      const bytes = await window.jareking.invoke<Uint8Array>(window.jareking.IPC.PDF_EXPORT_HTML, {
        html,
        fileName: '导出.pdf',
      });
      return { size: bytes.length, head: String.fromCharCode(...bytes.slice(0, 5)) };
    };
  });

  /** 插入图片：选择本地文件 → 读为 data URL → TipTap Image（保存时由 htmlToJk 落盘为 media） */
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

  /** 应用超链接（Modal 输入，空值取消链接） */
  const applyLink = () => {
    if (!editor) return;
    const url = linkInput.trim();
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
    setLinkOpen(false);
  };

  /* -------------------- 批注（WPS 对齐：协作功能） -------------------- */

  /** 确定新建批注：给暂存选区的文本加 jkComment mark，并把批注正文追加到 commentsRef */
  const applyComment = () => {
    const ed = editor;
    const range = pendingCommentRangeRef.current;
    if (!ed || !range) {
      setCommentOpen(false);
      return;
    }
    const text = commentInput.trim();
    if (!text) return;
    const id = String(maxCommentId(commentsRef.current) + 1);
    ed.chain()
      .focus()
      .setTextSelection({ from: range.from, to: range.to })
      .setMark(JK_COMMENT_MARK, { commentId: id })
      .run();
    commentsRef.current = [
      ...commentsRef.current,
      { id, author: '我', date: new Date().toISOString(), text },
    ];
    setCommentInput('');
    setCommentOpen(false);
    setCommentPanelOpen(true);
    setCommentTick((t) => t + 1);
    toast.success('已添加批注');
  };

  /** 删除批注：移除 commentsRef 条目 + 清除文档内对应 mark */
  const removeComment = (id: string) => {
    const ed = editor;
    const markType = ed?.schema.marks[JK_COMMENT_MARK];
    if (ed && markType) {
      const tr = ed.state.tr;
      let changed = false;
      ed.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        node.marks.forEach((m) => {
          if (m.type === markType && m.attrs.commentId === id) {
            tr.removeMark(pos, pos + node.nodeSize, m);
            changed = true;
          }
        });
      });
      if (changed) ed.view.dispatch(tr);
    }
    commentsRef.current = commentsRef.current.filter((c) => c.id !== id);
    setCommentTick((t) => t + 1);
  };

  /** 切换「已解决」：更新 ref 并同步文档内所有该 id 的 mark 样式 */
  const toggleResolvedComment = (id: string) => {
    commentsRef.current = commentsRef.current.map((c) =>
      c.id === id ? { ...c, resolved: !c.resolved } : c,
    );
    const nowResolved = commentsRef.current.find((c) => c.id === id)?.resolved ?? false;
    const ed = editor;
    const markType = ed?.schema.marks[JK_COMMENT_MARK];
    if (ed && markType) {
      const tr = ed.state.tr;
      let changed = false;
      ed.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        node.marks.forEach((m) => {
          if (m.type === markType && m.attrs.commentId === id) {
            tr.removeMark(pos, pos + node.nodeSize, m);
            tr.addMark(
              pos,
              pos + node.nodeSize,
              markType.create({ ...m.attrs, resolved: nowResolved }),
            );
            changed = true;
          }
        });
      });
      if (changed) ed.view.dispatch(tr);
    }
    setCommentTick((t) => t + 1);
  };

  /** 定位批注：查找文档内该 id 的 mark 范围并选中滚动到可见处 */
  const locateComment = (id: string) => {
    const ed = editor;
    if (!ed) return;
    const markType = ed.schema.marks[JK_COMMENT_MARK];
    let found: { from: number; to: number } | null = null;
    if (markType) {
      ed.state.doc.descendants((node, pos) => {
        if (found) return false;
        if (node.isText) {
          const has = node.marks.some((m) => m.type === markType && m.attrs.commentId === id);
          if (has) found = { from: pos, to: pos + node.nodeSize };
        }
        return true;
      });
    }
    const target = found as { from: number; to: number } | null;
    if (target) {
      ed.chain().focus().setTextSelection({ from: target.from, to: target.to }).scrollIntoView().run();
    } else {
      toast.warning('未找到该批注对应的文本（可能已被删除）');
    }
  };

  /* -------------------- 脚注 / 尾注（WPS 对齐：引用） -------------------- */

  /** 在光标处插入脚注/尾注引用，并新建一条空条目、打开编辑面板 */
  const insertNote = (kind: 'footnote' | 'endnote') => {
    const ed = editor;
    if (!ed) return;
    const list = kind === 'footnote' ? notesRef.current.footnotes : notesRef.current.endnotes;
    const id = String(maxNoteId(list) + 1);
    ed.chain().focus().insertContent({ type: JK_NOTE_REF, attrs: { noteId: id, noteType: kind } }).run();
    const note: JkNote = { id, blocks: [{ type: 'paragraph', runs: [] }] };
    notesRef.current =
      kind === 'footnote'
        ? { ...notesRef.current, footnotes: [...list, note] }
        : { ...notesRef.current, endnotes: [...list, note] };
    setNotesTick((t) => t + 1);
    setNotesOpen(true);
    toast.success(kind === 'footnote' ? '已插入脚注，请填写内容' : '已插入尾注，请填写内容');
  };

  /** 更新某条脚注/尾注正文（Modal 文本域 onChange）：写回内存态并触发重渲染 */
  const updateNoteText = (kind: 'footnote' | 'endnote', id: string, text: string) => {
    const blocks = textToNoteBlocks(text);
    notesRef.current =
      kind === 'footnote'
        ? {
            ...notesRef.current,
            footnotes: notesRef.current.footnotes.map((n) => (n.id === id ? { ...n, blocks } : n)),
          }
        : {
            ...notesRef.current,
            endnotes: notesRef.current.endnotes.map((n) => (n.id === id ? { ...n, blocks } : n)),
          };
    setNotesTick((t) => t + 1);
  };

  /* -------------------- 分栏（WPS 对齐：页面布局） -------------------- */

  /** 打开分栏对话框（回显当前设置） */
  const openColumns = () => {
    setColCount(columnsRef.current?.count ?? 1);
    setColSep(columnsRef.current?.separator ?? false);
    setColumnsOpen(true);
  };

  /** 应用分栏设置：写回内存态（保存时注入节 model）；单栏无分隔线视为缺省（清除设置） */
  const applyColumns = () => {
    columnsRef.current =
      colCount <= 1 && !colSep ? undefined : { count: colCount, separator: colSep || undefined };
    setColumnsOpen(false);
    toast.success(colCount <= 1 ? '已设为单栏' : `已设为 ${colCount} 栏`);
  };

  /* -------------------- 样式管理器（WPS 对齐：样式） -------------------- */

  /** 把某个样式（含 basedOn 链继承的有效属性）回显到编辑表单 */
  const loadStyleToForm = (def: StyleDef) => {
    const attrs = resolveParagraphAttrs(styleDefsRef.current, def.styleId);
    setStyleSelectedId(def.styleId);
    setStyleName(def.name ?? def.styleId);
    setStyleType(def.styleType);
    setStyleFontSize(attrs.rPr.size !== undefined ? String(attrs.rPr.size / 2) : '');
    setStyleFontFamily(
      attrs.rPr.font?.eastAsia ?? attrs.rPr.font?.ascii ?? attrs.rPr.font?.hAnsi ?? '',
    );
    setStyleBold(attrs.rPr.bold === true);
    setStyleItalic(attrs.rPr.italic === true);
    setStyleColor(attrs.rPr.color ? `#${attrs.rPr.color}` : '#000000');
    setStyleAlign(jcToUi(attrs.pPr.jc));
  };

  /** 打开样式管理器时，若尚未选择样式则默认选中第一个（便于直接查看/应用） */
  useEffect(() => {
    if (!styleOpen) return;
    const styles = styleDefsRef.current.styles;
    if (!styleSelectedId && styles.length) loadStyleToForm(styles[0]);
    // 仅在「打开」动作时同步一次默认选择，避免每次列表变动都覆盖用户选择
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleOpen]);

  /** 表单字段 → RunProperties（仅写入显式设置的项；字号 pt → half-point 存储） */
  const buildRPrFromForm = (): RunProperties | undefined => {
    const rPr: RunProperties = {};
    const size = Number(styleFontSize);
    if (styleFontSize !== '' && Number.isFinite(size) && size > 0) rPr.size = Math.round(size * 2);
    const fam = styleFontFamily.trim();
    if (fam) rPr.font = { ascii: fam, eastAsia: fam, hAnsi: fam };
    if (styleBold) rPr.bold = true;
    if (styleItalic) rPr.italic = true;
    const c = styleColor.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(c)) rPr.color = c.toUpperCase();
    return Object.keys(rPr).length ? rPr : undefined;
  };

  /** 表单字段 → ParagraphProperties（当前仅对齐；缩进/行距本轮不入 UI） */
  const buildPPrFromForm = (): ParagraphProperties | undefined => {
    const jc = uiToJc(styleAlign);
    return jc ? { jc } : undefined;
  };

  /** 新建样式：以表单（名称 + 关键属性）创建并 push 进样式表（makeUniqueStyleId 保证唯一） */
  const createStyleFromForm = () => {
    const name = styleName.trim() || '新样式';
    const existing = styleDefsRef.current.styles.map((s) => s.styleId);
    const styleId = makeUniqueStyleId(name, existing);
    // 以当前所选样式为「派生来源」复制基础属性，再以表单值覆盖
    const src = styleDefsRef.current.styles.find((s) => s.styleId === styleSelectedId);
    const def = cloneStyleDef(src, name, styleType);
    def.styleId = styleId;
    def.rPr = buildRPrFromForm();
    def.pPr = buildPPrFromForm();
    styleDefsRef.current.styles.push(def);
    setStyleSelectedId(styleId);
    setStyleTick((t) => t + 1);
    toast.success(`已新建样式「${name}」`);
  };

  /** 保存修改：覆盖当前所选样式的名称与属性（同 styleId 就地更新） */
  const overwriteSelectedStyle = () => {
    const def = styleDefsRef.current.styles.find((s) => s.styleId === styleSelectedId);
    if (!def) {
      toast.warning('请先选择一个样式');
      return;
    }
    def.name = styleName.trim() || def.name || def.styleId;
    def.styleType = styleType;
    def.rPr = buildRPrFromForm();
    def.pPr = buildPPrFromForm();
    setStyleTick((t) => t + 1);
    toast.success(`已更新样式「${def.name}」`);
  };

  /**
   * 删除样式：仅从定义表移除，**不清理**正文中对该 styleId 的引用
   * （引用保留便于撤销/后续恢复；Word/WPS 打开时缺失样式按默认格式呈现）。
   */
  const deleteSelectedStyle = () => {
    const styles = styleDefsRef.current.styles;
    const idx = styles.findIndex((s) => s.styleId === styleSelectedId);
    if (idx < 0) {
      toast.warning('请先选择一个样式');
      return;
    }
    const [removed] = styles.splice(idx, 1);
    setStyleSelectedId('');
    setStyleTick((t) => t + 1);
    toast.success(`已删除样式「${removed.name ?? removed.styleId}」`);
  };

  /**
   * 应用样式到当前光标/选区覆盖的段落：
   *  1) 段落样式 → 打 jkParagraphStyle mark（承载 styleId，随 HTML 往返落盘为 w:pStyle）；
   *  2) 把有效属性（字号/字体/加粗/斜体/颜色/对齐）应用到当前选区，使效果立即可见；
   *  3) 同步模型（fullDocRef），保证「保存再打开不丢」。
   * 字符样式仅下发字符属性（不设段落 pStyle）；表格样式暂缓（明确提示，不留空壳）。
   */
  const applySelectedStyle = () => {
    const ed = editor;
    const def = styleDefsRef.current.styles.find((s) => s.styleId === styleSelectedId);
    if (!ed || !def) {
      toast.warning('请先选择一个样式');
      return;
    }
    if (def.styleType === 'table') {
      toast.warning('表格样式应用将在后续版本支持');
      return;
    }
    const isChar = def.styleType === 'character';
    const attrs = resolveParagraphAttrs(styleDefsRef.current, def.styleId);
    // 扩展到选区覆盖段落的整段：光标落在段内时作用于整段（对齐 WPS 段落样式语义）
    const { $from, $to } = ed.state.selection;
    const from = $from.start($from.depth);
    const to = $to.end($to.depth);

    // 1) 段落样式：给选区覆盖的段落加 mark（承载 styleId）
    if (!isChar) {
      const markType = ed.schema.marks[JK_PARAGRAPH_STYLE];
      if (markType) {
        const tr = ed.state.tr;
        let touched = false;
        ed.state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.isTextblock) {
            const s = pos + 1;
            const e = pos + node.content.size;
            if (e > s) {
              tr.removeMark(s, e, markType);
              tr.addMark(s, e, markType.create({ styleId: def.styleId }));
              touched = true;
            }
          }
          return true;
        });
        if (touched) ed.view.dispatch(tr);
      }
    }

    // 2) 可见格式：逐属性应用到当前选区
    let chain = ed.chain().focus().setTextSelection({ from, to });
    if (attrs.rPr.size !== undefined) chain = chain.setFontSize(`${attrs.rPr.size / 2}pt`);
    const fam = attrs.rPr.font?.eastAsia ?? attrs.rPr.font?.ascii ?? attrs.rPr.font?.hAnsi;
    if (fam) chain = chain.setFontFamily(fam);
    if (attrs.rPr.bold === true) chain = chain.setBold();
    else if (attrs.rPr.bold === false) chain = chain.unsetBold();
    if (attrs.rPr.italic === true) chain = chain.setItalic();
    else if (attrs.rPr.italic === false) chain = chain.unsetItalic();
    if (attrs.rPr.color) chain = chain.setColor(`#${attrs.rPr.color}`);
    const uiJc = jcToUi(attrs.pPr.jc);
    if (!isChar && uiJc) chain = chain.setTextAlign(uiJc);
    chain.run();

    // 3) 模型同步：把 styleId 与格式写回保存真源
    if (chunkModeRef.current && fullDocRef.current) {
      // 分块模式：把当前切片写回整文（含 styleId），定义表本就同引用
      flushCurrentChunk();
    } else if (editor) {
      const doc = collectModelFromEditor();
      doc.styleDefs = styleDefsRef.current;
      fullDocRef.current = doc;
    }

    setStyleTick((t) => t + 1);
    toast.success(`已应用样式「${def.name ?? def.styleId}」`);
  };

  /**
   * 把编辑能力注册到命令总线：Ribbon 的按钮 / 控件由此驱动。
   * 依赖 editor，命令闭包读最新 editor；卸载时自动注销。
   */
  useEffect(() => {
    if (!editor) return;
    const commands: Record<string, EditorCommand> = {
      // —— 字体 ——
      'font-family': {
        run: (payload) => {
          const family = String(payload ?? '').trim();
          if (family) editor.chain().focus().setFontFamily(family).run();
        },
        state: () => ({
          disabled: false,
          value: (editor.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
        }),
      },
      'font-size': {
        run: (payload) => {
          const size = String(payload ?? '').trim();
          if (size) editor.chain().focus().setFontSize(`${size}pt`).run();
        },
        state: () => {
          const raw = editor.getAttributes('textStyle').fontSize as string | undefined;
          return { disabled: false, value: raw ? String(raw).replace('pt', '') : '' };
        },
      },
      'font-color': {
        run: (payload) => {
          const color = String(payload ?? '').trim();
          if (color) editor.chain().focus().setColor(color).run();
        },
        state: () => ({
          disabled: false,
          value: (editor.getAttributes('textStyle').color as string | undefined) ?? '',
        }),
      },
      bold: {
        run: () => editor.chain().focus().toggleBold().run(),
        state: () => ({ active: editor.isActive('bold'), disabled: false }),
      },
      italic: {
        run: () => editor.chain().focus().toggleItalic().run(),
        state: () => ({ active: editor.isActive('italic'), disabled: false }),
      },
      underline: {
        run: () => editor.chain().focus().toggleUnderline().run(),
        state: () => ({ active: editor.isActive('underline'), disabled: false }),
      },
      strike: {
        run: () => editor.chain().focus().toggleStrike().run(),
        state: () => ({ active: editor.isActive('strike'), disabled: false }),
      },
      // —— 段落 / 样式 ——
      h1: {
        run: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
        state: () => ({ active: editor.isActive('heading', { level: 1 }), disabled: false }),
      },
      h2: {
        run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        state: () => ({ active: editor.isActive('heading', { level: 2 }), disabled: false }),
      },
      h3: {
        run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
        state: () => ({ active: editor.isActive('heading', { level: 3 }), disabled: false }),
      },
      body: {
        run: () => editor.chain().focus().setParagraph().run(),
        state: () => ({ active: editor.isActive('paragraph'), disabled: false }),
      },
      // —— 样式管理器（WPS 对齐：样式）——
      'style-manager': { run: () => setStyleOpen(true) },
      'align-left': {
        run: () => editor.chain().focus().setTextAlign('left').run(),
        state: () => ({ active: editor.isActive({ textAlign: 'left' }), disabled: false }),
      },
      'align-center': {
        run: () => editor.chain().focus().setTextAlign('center').run(),
        state: () => ({ active: editor.isActive({ textAlign: 'center' }), disabled: false }),
      },
      'align-right': {
        run: () => editor.chain().focus().setTextAlign('right').run(),
        state: () => ({ active: editor.isActive({ textAlign: 'right' }), disabled: false }),
      },
      'align-justify': {
        run: () => editor.chain().focus().setTextAlign('justify').run(),
        state: () => ({ active: editor.isActive({ textAlign: 'justify' }), disabled: false }),
      },
      bullet: {
        run: () => editor.chain().focus().toggleBulletList().run(),
        state: () => ({ active: editor.isActive('bulletList'), disabled: false }),
      },
      numbering: {
        run: () => editor.chain().focus().toggleOrderedList().run(),
        state: () => ({ active: editor.isActive('orderedList'), disabled: false }),
      },
      // —— 插入 ——
      table: {
        run: () =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      },
      'page-break': {
        run: () => editor.chain().focus().setHorizontalRule().run(),
      },
      'page-number': {
        run: () =>
          editor
            .chain()
            .focus()
            .insertContent({ type: 'jkField', attrs: { instr: 'PAGE', result: '1' } })
            .run(),
      },
      toc: {
        run: () => {
          const entries = buildTocEntries(editor.state.doc);
          if (!entries.length) {
            toast.warning('文档中没有标题，先设置标题层级再插入目录');
            return;
          }
          editor.chain().focus().insertContent(buildTocContent(entries)).run();
          toast.success(`已插入目录（${entries.length} 个条目）`);
        },
      },
      formula: {
        run: () => {
          setFormulaError(null);
          setFormulaInput('x^2+y^2=z^2');
          setFormulaOpen(true);
        },
      },
      link: {
        run: () => {
          const prev = editor.getAttributes('link').href as string | undefined;
          setLinkInput(prev ?? '');
          setLinkOpen(true);
        },
        state: () => ({ active: editor.isActive('link'), disabled: false }),
      },
      image: {
        run: () => imageInputRef.current?.click(),
      },
      'header-footer': {
        run: () => setHfOpen(true),
      },
      // —— 引用：脚注 / 尾注（WPS 对齐）——
      'insert-footnote': { run: () => insertNote('footnote') },
      'insert-endnote': { run: () => insertNote('endnote') },
      notes: { run: () => setNotesOpen(true) },
      // —— 页面布局：分栏（WPS 对齐）——
      columns: {
        run: () => openColumns(),
        state: () => ({ value: String(columnsRef.current?.count ?? 1) }),
      },
      // —— 审阅：新建批注（WPS 对齐协作功能）——
      comment: {
        run: () => {
          if (!editor) return;
          const sel = editor.state.selection;
          if (sel.empty) {
            toast.warning('请先选中要批注的文本');
            return;
          }
          // 固定当前选区：Modal 获焦后 ProseMirror 选区可能变化
          pendingCommentRangeRef.current = { from: sel.from, to: sel.to };
          setCommentInput('');
          setCommentOpen(true);
        },
      },
      // —— 审阅：修订（track changes）——
      'track-changes': {
        run: () => {
          // 切换修订模式：开启后新输入标记为插入、删除内容保留为删除标记（见 jkRevision 插件）
          const next = !revisionModeRef.current;
          revisionModeRef.current = next;
          setRevisionMode(next);
          notifyEditorChange();
          toast.success(next ? '已开启修订模式' : '已关闭修订模式');
        },
        state: () => ({ active: revisionModeRef.current, disabled: false }),
      },
      'accept-revisions': {
        // 接受所有修订：删除所有删除修订、清除插入修订标记
        run: () => applyRevisionsRef.current('accept'),
      },
      'reject-revisions': {
        // 拒绝所有修订：移除插入修订、清除删除修订标记并还原文本
        run: () => applyRevisionsRef.current('reject'),
      },
      // —— 编辑 / 文件 ——
      undo: {
        run: () => editor.chain().focus().undo().run(),
        state: () => ({ disabled: !editor.can().undo() }),
      },
      redo: {
        run: () => editor.chain().focus().redo().run(),
        state: () => ({ disabled: !editor.can().redo() }),
      },
      replace: {
        run: () => {
          setFindMode('replace');
          setShowFind(true);
        },
      },
      open: {
        run: () => onOpenFile(),
      },
      save: {
        run: () => saveRef.current(),
      },
      // —— 文件：导出 PDF（WPS 对齐批2：统一走 Electron 打印管线）——
      'export-pdf': {
        run: () => exportPdfRef.current(),
      },
    };
    return registerEditorCommands(commands);
  }, [editor]);

  // 缩放：纸张按 transform scale 呈现，包裹层尺寸同步为 宽 794*z / 高 内容高*z，
  // 保证滚动区与光标定位正确（不用 CSS zoom，避免 ProseMirror 坐标计算错乱）
  const paperRef = useRef<HTMLDivElement>(null);
  const [paperHeight, setPaperHeight] = useState(0);
  useEffect(() => {
    const el = paperRef.current;
    if (!el) return;
    const measure = () => setPaperHeight(el.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [editor]);

  // 打开页眉页脚对话框时，把当前 hfRef 内容经 jkToHtml 转为 HTML 渲染到对应编辑器
  useEffect(() => {
    if (!hfOpen) return;
    const headerHtml = jkToHtml({ body: hfRef.current.header } as unknown as JkDocument);
    const footerHtml = jkToHtml({ body: hfRef.current.footer } as unknown as JkDocument);
    hfHeaderEditor?.commands.setContent(headerHtml, false);
    hfFooterEditor?.commands.setContent(footerHtml, false);
    setHfTab('header');
  }, [hfOpen, hfHeaderEditor, hfFooterEditor]);

  /** 取得当前页签对应的编辑器实例 */
  const activeHfEditor = () => (hfTab === 'header' ? hfHeaderEditor : hfFooterEditor);

  /** 在活动编辑器插入页码域（type='page' 的 JkField） */
  const insertHfPageNumber = () => {
    activeHfEditor()?.chain().focus()
      .insertContent({ type: 'jkField', attrs: { instr: 'PAGE', result: '1' } })
      .run();
  };
  const toggleHfBold = () => activeHfEditor()?.chain().focus().toggleBold().run();
  const toggleHfItalic = () => activeHfEditor()?.chain().focus().toggleItalic().run();
  const toggleHfUnderline = () => activeHfEditor()?.chain().focus().toggleUnderline().run();

  /** 确定：把两个编辑器 HTML 经 htmlToJk 写回 hfRef（取 .body 作为 Block[]） */
  const applyHeaderFooter = () => {
    const headerHtml = hfHeaderEditor?.getHTML() ?? '';
    const footerHtml = hfFooterEditor?.getHTML() ?? '';
    const headerJk = htmlToJk(headerHtml);
    const footerJk = htmlToJk(footerHtml);
    hfRef.current = { header: headerJk.body, footer: footerJk.body };
    setHfOpen(false);
  };

  // —— 样式管理器渲染派生的数据（styleTick 变化时随重渲染刷新）——
  const styleGroups = groupStyles(styleDefsRef.current);
  const selectedStyleDef = styleDefsRef.current.styles.find((s) => s.styleId === styleSelectedId);
  const selectedAttrs = resolveParagraphAttrs(styleDefsRef.current, styleSelectedId);

  return (
    <div className="relative flex h-full w-full min-h-0 flex-col">
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

      {/* 修订模式提示条：开启时给出清晰反馈（关闭时完全不出现） */}
      {revisionMode && (
        <div className="flex items-center gap-2 border-b border-border bg-accent/10 px-3 py-1 text-tiny text-fg">
          <span className="font-medium text-accent">修订模式已开启</span>
          <span className="text-muted">
            新输入将标记为插入，删除内容保留为删除标记；用「审阅 → 接受/拒绝所有修订」处理。
          </span>
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

      {/* 纸张区 + 批注面板（横向两栏，面板可折叠） */}
      <div className="relative flex min-h-0 flex-1">
        {/* 纸张区（文档区最大化：无重复工具栏，内边距收紧） */}
        <div className="relative min-h-0 flex-1 overflow-auto bg-muted-bg/40 p-5">
          {/* Ctrl+F/H 查找替换条 */}
          {editor && showFind && (
            <FindReplaceBar editor={editor} initialMode={findMode} onClose={() => setShowFind(false)} />
          )}
          {/* 缩放包裹层：宽度按 794*z，高度按纸张实测高*z */}
          <div
            className="mx-auto"
            style={{
              width: PAGE_WIDTH_PX * writerZoom,
              height: paperHeight > 0 ? paperHeight * writerZoom : undefined,
            }}
          >
            <div
              ref={paperRef}
              className="w-[794px] min-h-[1123px] rounded-sm bg-surface px-12 py-10 shadow-card"
              style={{ transform: `scale(${writerZoom})`, transformOrigin: 'top left' }}
            >
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>

        {/* 折叠态：右侧「批注」浮标（含数量），点击展开面板 */}
        {!commentPanelOpen && (
          <button
            type="button"
            className="absolute right-0 top-2 z-10 flex items-center gap-1 rounded-l border border-r-0 border-border bg-surface px-1.5 py-1 text-tiny text-fg transition-colors hover:bg-hover"
            onClick={() => setCommentPanelOpen(true)}
            title="显示批注面板"
            aria-label="显示批注面板"
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
            {commentsRef.current.length > 0 ? (
              <span className="tabular-nums">{commentsRef.current.length}</span>
            ) : null}
          </button>
        )}

        {/* 右侧批注面板：作者 + 时间 + 正文 + 定位/已解决/删除（可折叠，不常驻占宽） */}
        {commentPanelOpen && (
          <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-surface">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
              <span className="text-tiny font-medium text-fg">
                批注（{commentsRef.current.length}）
              </span>
              <button
                type="button"
                className="rounded px-1 leading-none text-muted transition-colors hover:bg-hover hover:text-fg"
                onClick={() => setCommentPanelOpen(false)}
                title="收起批注面板"
                aria-label="收起批注面板"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2" data-comment-tick={commentTick}>
              {commentsRef.current.length === 0 ? (
                <p className="p-2 text-tiny text-muted">
                  暂无批注。选中文本后点「审阅 → 新建批注」添加。
                </p>
              ) : (
                commentsRef.current.map((c) => (
                  <div
                    key={c.id}
                    className={`mb-2 rounded border border-border p-2 text-tiny ${
                      c.resolved ? 'opacity-60' : ''
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-fg">{c.author ?? '我'}</span>
                      <span className="shrink-0 text-muted">{formatCommentTime(c.date)}</span>
                    </div>
                    <div
                      className={`mb-2 whitespace-pre-wrap ${
                        c.resolved ? 'text-muted line-through' : 'text-fg'
                      }`}
                    >
                      {c.text}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
                        onClick={() => locateComment(c.id)}
                        title="定位批注"
                        aria-label="定位批注"
                      >
                        定位
                      </button>
                      <button
                        type="button"
                        className="rounded px-1.5 py-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
                        onClick={() => toggleResolvedComment(c.id)}
                        title={c.resolved ? '取消已解决' : '标记已解决'}
                        aria-label="切换已解决"
                      >
                        {c.resolved ? '取消解决' : '已解决'}
                      </button>
                      <button
                        type="button"
                        className="ml-auto rounded px-1.5 py-0.5 text-warning transition-colors hover:bg-hover"
                        onClick={() => removeComment(c.id)}
                        title="删除批注"
                        aria-label="删除批注"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>

      {/* 状态栏：字数统计（WPS 口径） */}
      {editor && <EditorStatusBar editor={editor} />}

      {/* T4.4 选中浮动 AI 工具条（选区非空时浮出） */}
      {editor && <FloatingAiBar editor={editor} />}

      {/* 插入公式对话框：实时校验 + 生成 OMML */}
      <Modal
        open={formulaOpen}
        onClose={() => setFormulaOpen(false)}
        title="插入公式"
        width={420}
        footer={
          <Button
            variant="primary"
            size="sm"
            icon={<Sigma size={13} />}
            onClick={() => {
              if (!editor) return;
              const text = formulaInput.trim();
              if (!text) return;
              const check = validateLinearFormula(text);
              if (!check.ok) {
                setFormulaError(check.error ?? '公式语法错误');
                return;
              }
              // 生成器校验可产出合法 OMML（模型存线性文本，导出时落 m:oMath）
              linearToOmml(text);
              editor
                .chain()
                .focus()
                .insertContent({ type: 'jkFormula', attrs: { text } })
                .run();
              setFormulaOpen(false);
              setFormulaError(null);
              toast.success('已插入公式（Word/WPS 中可编辑）');
            }}
          >
            插入
          </Button>
        }
      >
        <div className="flex flex-col gap-2 p-1">
          <Input
            autoFocus
            placeholder="线性公式，如 x^2+y^2=z^2、a/b、sqrt(x)"
            value={formulaInput}
            onChange={(e) => {
              setFormulaInput(e.target.value);
              setFormulaError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // 复用插入逻辑：点击等价（简化：回车触发校验并插入）
                const text = formulaInput.trim();
                if (!editor || !text) return;
                const check = validateLinearFormula(text);
                if (!check.ok) {
                  setFormulaError(check.error ?? '公式语法错误');
                  return;
                }
                linearToOmml(text);
                editor.chain().focus().insertContent({ type: 'jkFormula', attrs: { text } }).run();
                setFormulaOpen(false);
                toast.success('已插入公式（Word/WPS 中可编辑）');
              }
            }}
          />
          <p className="text-tiny text-muted">
            支持 ＋ − × ÷、^ 上标（a^b）、a/b 分数、sqrt() 根号、括号；保存后为 Word/WPS 原生公式对象。
          </p>
          {formulaError && <p className="text-tiny text-warning">语法错误：{formulaError}</p>}
        </div>
      </Modal>

      {/* 插入超链接对话框：Modal 输入 URL（不用 window.prompt —— 原生弹窗阻断自动化），空值取消链接 */}
      <Modal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="插入超链接"
        width={420}
        footer={
          <Button variant="primary" size="sm" icon={<LinkIcon size={13} />} onClick={applyLink}>
            应用
          </Button>
        }
      >
        <div className="flex flex-col gap-2 p-1">
          <Input
            autoFocus
            placeholder="https://example.com（留空则取消链接）"
            value={linkInput}
            onChange={(e) => setLinkInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                applyLink();
              }
            }}
          />
          <p className="text-tiny text-muted">
            链接将应用到当前选区（选区为空时作用于光标处后续输入）；留空点「应用」可移除已有链接。
          </p>
        </div>
      </Modal>

      {/* 页眉页脚对话框（WPS 对齐）：双页签（页眉/页脚）各自独立 TipTap 实例；严禁 window.prompt/alert */}
      <Modal
        open={hfOpen}
        onClose={() => setHfOpen(false)}
        title="页眉页脚"
        width={540}
        footer={
          <Button variant="primary" size="sm" onClick={applyHeaderFooter}>
            确定
          </Button>
        }
      >
        <div className="flex flex-col gap-2 p-1">
          {/* 页签：页眉 / 页脚 */}
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setHfTab('header')}
              className={`flex items-center gap-1 rounded px-3 py-1.5 text-tiny transition-colors ${
                hfTab === 'header' ? 'bg-accent/15 text-accent' : 'hover:bg-black/5'
              }`}
            >
              <PanelTop size={14} /> 页眉
            </button>
            <button
              type="button"
              onClick={() => setHfTab('footer')}
              className={`flex items-center gap-1 rounded px-3 py-1.5 text-tiny transition-colors ${
                hfTab === 'footer' ? 'bg-accent/15 text-accent' : 'hover:bg-black/5'
              }`}
            >
              <PanelBottom size={14} /> 页脚
            </button>
          </div>
          {/* 工具条：插入页码 + 基础格式（可选，至少给「插入页码」） */}
          <div className="flex items-center gap-1 border-y border-border py-1.5">
            <Button variant="ghost" size="sm" icon={<Hash size={13} />} onClick={insertHfPageNumber}>
              插入页码
            </Button>
            <span className="mx-1 h-4 w-px bg-border" />
            <Button variant="ghost" size="sm" onClick={toggleHfBold} aria-label="加粗">
              <Bold size={13} />
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleHfItalic} aria-label="斜体">
              <Italic size={13} />
            </Button>
            <Button variant="ghost" size="sm" onClick={toggleHfUnderline} aria-label="下划线">
              <UnderlineIcon size={13} />
            </Button>
          </div>
          {/* 编辑区：仅显示当前页签对应编辑器，另一实例隐藏以保留内容 */}
          <div className="min-h-[160px] rounded border border-border p-2">
            <div style={{ display: hfTab === 'header' ? 'block' : 'none' }}>
              <EditorContent editor={hfHeaderEditor} />
            </div>
            <div style={{ display: hfTab === 'footer' ? 'block' : 'none' }}>
              <EditorContent editor={hfFooterEditor} />
            </div>
          </div>
          <p className="text-tiny text-muted">
            提示：页眉/页脚支持文本、基础格式与页码域；保存后写入 word/headerN.xml 与 word/footerN.xml。
          </p>
        </div>
      </Modal>

      {/* 新建批注对话框（WPS 对齐协作功能）：Modal + Textarea，严禁 window.prompt/alert */}
      <Modal
        open={commentOpen}
        onClose={() => setCommentOpen(false)}
        title="新建批注"
        width={420}
        footer={
          <Button
            variant="primary"
            size="sm"
            icon={<MessageSquarePlus size={13} />}
            onClick={applyComment}
          >
            确定
          </Button>
        }
      >
        <div className="flex flex-col gap-2 p-1">
          <textarea
            autoFocus
            className="min-h-[96px] w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 text-ui text-fg outline-none transition-colors placeholder:text-muted hover:border-accent focus-visible:border-accent"
            placeholder="输入批注内容…"
            value={commentInput}
            onChange={(e) => setCommentInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                applyComment();
              }
            }}
          />
          <p className="text-tiny text-muted">
            批注将锚定到当前选区文本；保存后写入 Word 原生批注（word/comments.xml）。Ctrl+Enter 快速确定。
          </p>
        </div>
      </Modal>

      {/* 脚注 / 尾注编辑对话框（WPS 对齐：引用）：列出全部脚注/尾注逐条编辑；严禁 window.prompt/alert */}
      <Modal
        open={notesOpen}
        onClose={() => setNotesOpen(false)}
        title="脚注 / 尾注"
        width={520}
        footer={
          <Button
            variant="primary"
            size="sm"
            icon={<Footprints size={13} />}
            onClick={() => setNotesOpen(false)}
          >
            完成
          </Button>
        }
      >
        <div className="flex flex-col gap-3 p-1" data-notes-tick={notesTick}>
          {notesRef.current.footnotes.length === 0 && notesRef.current.endnotes.length === 0 ? (
            <p className="text-tiny text-muted">
              暂无脚注或尾注。用「引用 → 插入脚注 / 插入尾注」在光标处添加。
            </p>
          ) : null}
          {notesRef.current.footnotes.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-tiny font-medium text-fg">脚注</span>
              {notesRef.current.footnotes.map((n) => (
                <div key={`fn-${n.id}`} className="flex flex-col gap-1">
                  <label className="text-tiny text-muted">脚注 {n.id}</label>
                  <textarea
                    className="min-h-[64px] w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 text-ui text-fg outline-none transition-colors placeholder:text-muted hover:border-accent focus-visible:border-accent"
                    placeholder="输入脚注内容…"
                    value={noteToText(n)}
                    onChange={(e) => updateNoteText('footnote', n.id, e.target.value)}
                  />
                </div>
              ))}
            </div>
          ) : null}
          {notesRef.current.endnotes.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-tiny font-medium text-fg">尾注</span>
              {notesRef.current.endnotes.map((n) => (
                <div key={`en-${n.id}`} className="flex flex-col gap-1">
                  <label className="text-tiny text-muted">尾注 {n.id}</label>
                  <textarea
                    className="min-h-[64px] w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 text-ui text-fg outline-none transition-colors placeholder:text-muted hover:border-accent focus-visible:border-accent"
                    placeholder="输入尾注内容…"
                    value={noteToText(n)}
                    onChange={(e) => updateNoteText('endnote', n.id, e.target.value)}
                  />
                </div>
              ))}
            </div>
          ) : null}
          <p className="text-tiny text-muted">
            脚注/尾注正文在此编辑；保存后写入 word/footnotes.xml 与 word/endnotes.xml，Word/WPS 可继续编辑。
          </p>
        </div>
      </Modal>

      {/* 分栏对话框（WPS 对齐：页面布局）：选择栏数与分隔线；写入当前节 Section.columns，导出为 sectPr/w:cols */}
      <Modal
        open={columnsOpen}
        onClose={() => setColumnsOpen(false)}
        title="分栏"
        width={360}
        footer={
          <Button variant="primary" size="sm" icon={<Columns2 size={13} />} onClick={applyColumns}>
            确定
          </Button>
        }
      >
        <div className="flex flex-col gap-3 p-1">
          <div className="flex items-center gap-2">
            <span className="text-tiny text-muted">栏数</span>
            {[1, 2, 3].map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColCount(c)}
                aria-pressed={colCount === c}
                className={`h-7 w-9 rounded-sm border text-tiny transition-colors ${
                  colCount === c
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-border hover:bg-hover'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-tiny text-fg">
            <input type="checkbox" checked={colSep} onChange={(e) => setColSep(e.target.checked)} />
            显示分隔线
          </label>
          <p className="text-tiny text-muted">
            作用于当前节；1 栏且无分隔线即恢复单栏。保存后写入 sectPr 的 w:cols。
          </p>
        </div>
      </Modal>

      {/* 样式管理器（WPS 对齐：样式）：左分组列表 + 右属性摘要/编辑；严禁 window.prompt/alert */}
      <Modal
        open={styleOpen}
        onClose={() => setStyleOpen(false)}
        title="样式管理器"
        width={640}
        footer={
          <>
            <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={createStyleFromForm}>
              新建样式
            </Button>
            <Button variant="ghost" size="sm" onClick={overwriteSelectedStyle}>
              保存修改
            </Button>
            <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={deleteSelectedStyle}>
              删除样式
            </Button>
            <Button variant="primary" size="sm" icon={<Check size={13} />} onClick={applySelectedStyle}>
              应用
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setStyleOpen(false)}>
              关闭
            </Button>
          </>
        }
      >
        <div className="flex gap-3" data-style-tick={styleTick}>
          {/* 左：按 styleType 分组的样式列表（groupStyles 已排序） */}
          <div className="max-h-[380px] w-[210px] shrink-0 overflow-auto rounded border border-border">
            {styleGroups.length === 0 ? (
              <p className="p-2 text-tiny text-muted">暂无样式，点「新建样式」创建。</p>
            ) : (
              styleGroups.map((g) => (
                <div key={g.group} className="border-b border-border last:border-b-0">
                  <div className="bg-muted-bg px-2 py-1 text-tiny font-medium text-muted">
                    {g.group}
                  </div>
                  {g.styles.map((s) => (
                    <button
                      key={s.styleId}
                      type="button"
                      onClick={() => loadStyleToForm(s)}
                      aria-pressed={s.styleId === styleSelectedId}
                      title={s.name ?? s.styleId}
                      className={`flex w-full items-center px-2 py-1 text-left text-tiny transition-colors ${
                        s.styleId === styleSelectedId
                          ? 'bg-accent/15 text-accent'
                          : 'text-fg hover:bg-hover'
                      }`}
                    >
                      <span className="truncate">{s.name ?? s.styleId}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* 右：属性摘要 + 编辑表单 */}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="rounded-sm border border-border bg-muted-bg px-2 py-1.5 text-tiny text-muted">
              {selectedStyleDef
                ? `样式「${selectedStyleDef.name ?? selectedStyleDef.styleId}」 · ${styleAttrSummary(selectedAttrs)}`
                : '未选择样式'}
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-tiny text-muted">样式名</span>
              <Input
                value={styleName}
                onChange={(e) => setStyleName(e.target.value)}
                placeholder="样式名称"
              />
            </label>

            <div className="flex gap-2">
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-tiny text-muted">类型</span>
                <select
                  className="h-8 rounded-sm border border-border bg-surface px-2 text-tiny text-fg outline-none"
                  value={styleType}
                  onChange={(e) => setStyleType(e.target.value as StyleDef['styleType'])}
                >
                  <option value="paragraph">段落样式</option>
                  <option value="character">字符样式</option>
                  <option value="table">表格样式</option>
                </select>
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-tiny text-muted">字号</span>
                <select
                  className="h-8 rounded-sm border border-border bg-surface px-2 text-tiny text-fg outline-none"
                  value={styleFontSize}
                  onChange={(e) => setStyleFontSize(e.target.value)}
                >
                  <option value="">默认</option>
                  {FONT_SIZES.map((s) => (
                    <option key={s} value={String(s)}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-tiny text-muted">字体</span>
              <Input
                value={styleFontFamily}
                onChange={(e) => setStyleFontFamily(e.target.value)}
                placeholder="如 宋体 / Microsoft YaHei（留空为默认）"
              />
            </label>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-tiny text-fg">
                <input
                  type="checkbox"
                  checked={styleBold}
                  onChange={(e) => setStyleBold(e.target.checked)}
                />
                加粗
              </label>
              <label className="flex items-center gap-1.5 text-tiny text-fg">
                <input
                  type="checkbox"
                  checked={styleItalic}
                  onChange={(e) => setStyleItalic(e.target.checked)}
                />
                斜体
              </label>
              <label className="flex items-center gap-1.5 text-tiny text-fg">
                颜色
                <input
                  type="color"
                  aria-label="样式颜色"
                  value={/^#[0-9a-fA-F]{6}$/.test(styleColor) ? styleColor : '#000000'}
                  onChange={(e) => setStyleColor(e.target.value)}
                />
              </label>
            </div>

            <label className="flex items-center gap-2">
              <span className="text-tiny text-muted">对齐</span>
              <select
                className="h-8 flex-1 rounded-sm border border-border bg-surface px-2 text-tiny text-fg outline-none"
                value={styleAlign}
                onChange={(e) => setStyleAlign(e.target.value)}
              >
                <option value="">默认</option>
                <option value="left">左对齐</option>
                <option value="center">居中</option>
                <option value="right">右对齐</option>
                <option value="justify">两端对齐</option>
              </select>
            </label>

            <p className="text-tiny text-muted">
              选择左侧样式后点「应用」套用到当前段落；「新建样式」按上方名称与属性创建；「保存修改」覆盖当前样式。保存后写入 word/styles.xml（w:style）并在段落写入 w:pStyle。
            </p>
          </div>
        </div>
      </Modal>

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
