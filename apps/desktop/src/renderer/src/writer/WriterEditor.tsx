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

import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from "@tiptap/react";
import { setActiveEditor } from "./editorRef";
import { FloatingAiBar } from "./FloatingAiBar";
import { FindReplaceBar, EditorStatusBar } from "./FindReplaceBar";
import { buildTocEntries, buildTocContent } from "./tocBuilder";
import { takePendingOpen, peekPendingOpen } from "../stores/pendingOpenStore";
import { JkFormula } from "./jkFormula";
import { JK_COMMENT_MARK } from "./jkComment";
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
import type { Block, JkComment, JkDocument } from '@jareking/writer';
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
import { Link as LinkIcon, Sigma, Hash, PanelTop, PanelBottom, Bold, Italic, Underline as UnderlineIcon, MessageSquarePlus } from 'lucide-react';

import { Button } from '../components/Button';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { toast } from '../stores/toastStore';
import { htmlToJk } from './htmlToJk';
import { jkToHtml, extToMime } from './jkToHtml';
import { writerExtensions } from './writerExtensions';
import { MediaRegistry } from './mediaRegistry';
import { largeFileHint } from '../lib/largeFile';
import { downloadBlob } from '../lib/download';
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

  // 表格底纹（单元格/表头/行/表格四级）保真逻辑与统一扩展集合见 ./writerExtensions。
  // 主编辑器与「页眉页脚」Modal 共用 writerExtensions，避免重复声明。

  const editor = useEditor({
    immediatelyRender: false,
    extensions: writerExtensions,
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
    // 回填当前文档的页眉/页脚内容（缺省为空数组）
    hfRef.current = {
      header: jk.sections?.[0]?.header ?? [],
      footer: jk.sections?.[0]?.footer ?? [],
    };
    // 回填当前文档的批注列表（深拷贝，避免污染解析结果）
    commentsRef.current = (jk.comments ?? []).map((c) => ({ ...c }));
    setCommentTick((t) => t + 1);
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
      if (chunkModeRef.current && fullDocRef.current) {
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
      // 注入页眉/页脚（两路保存都注入）：确保非分块模式也能保留页眉页脚，
      // 并顺带修复非分块模式丢失 sections 的潜在问题（仅动 header/footer，不改 sections 其它字段）。
      if (!jk.sections || jk.sections.length === 0) {
        jk.sections = [{ type: 'section' }];
      }
      jk.sections[0].header = hfRef.current.header;
      jk.sections[0].footer = hfRef.current.footer;
      // 注入批注（两路保存都注入）：正文锚点由 htmlToJk/jkToHtml 往返，批注正文来自 ref
      jk.comments = commentsRef.current.length ? commentsRef.current : undefined;
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

  // 保存命令要读到最新闭包（命令只在 editor 变化时注册），用 ref 同步
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveRef.current = () => void onSave();
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
