/**
 * PdfReader —— PDF 阅读器（MVP，Phase 5 T5.1）。
 *
 * 能力：
 *  - 用 pdf.js 渲染页面到 <canvas>（devicePixelRatio 缩放保证清晰）；
 *  - 工具栏：上一页 / 下一页 / 首页 / 末页 / 页码跳转 / 放大 / 缩小 / 适应宽度 /
 *    适应页面 / 单页 ↔ 连续 模式切换 / 打开 PDF；
 *  - 文本选择复制：叠加 pdf.js TextLayer（4.7 的 `pdfjsLib.TextLayer` 类）；
 *  - 目录书签：`doc.getOutline()` 存在时显示侧边栏，点击跳页；
 *  - 全文搜索：遍历各页 `getTextContent()` 匹配，列出结果 + 点击跳页
 *    （高亮见文件末尾「未做部分」说明）；
 *  - 打开入口：组件内「打开 PDF」按钮（<input type="file">）或经 pendingOpen
 *    由 Ribbon「打开PDF」/ 首页「最近使用」传入路径；
 *  - 卸载时 `doc.destroy()` 释放。
 *
 * 硬约束：严禁 window.prompt / window.alert；不引入新依赖。
 *
 * pdf.js 4.7 实际可用 API 结论见本文件底部注释。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  Maximize2,
  PanelLeft,
  Rows3,
  Search,
  StretchHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjsLib } from './pdfjs';
import {
  PDF_ZOOM_STEP,
  clampPdfZoom,
  fitScale,
  makeSnippet,
  parsePageInput,
  resolveVisiblePage,
  shouldWarnContinuous,
  type Size,
} from './pdfView';
import { takePendingOpen } from '../stores/pendingOpenStore';
import { toast } from '../stores/toastStore';

/** 阅读模式：单页 / 连续（纵向滚动） */
type ViewMode = 'single' | 'continuous';
/** 缩放拟合方式：none=自由缩放 width=适应宽度 page=适应页面 */
type FitMode = 'none' | 'width' | 'page';

/** 目录（书签）扁平化条目 */
interface OutlineItem {
  title: string;
  /** 目标页（1 基）；无法解析时为 null */
  page: number | null;
  depth: number;
}

/** 全文搜索命中的一条 */
interface SearchHit {
  page: number;
  snippet: string;
}

/** pdf.js OutlineNode 的本地最小化形状（其返回类型未作为具名类型导出）。 */
interface RawOutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: RawOutlineNode[];
}

/** 滚动容器内边距（px），用于「适应宽度/页面」计算可用空间 */
const SCROLL_PADDING = 32;

/** 文本层所需最小样式（pdf.js 4.x 的 TextLayer 依赖 `--scale-factor` 变量定位）。 */
const TEXT_LAYER_CSS = `
.jk-pdf-text-layer {
  position: absolute; inset: 0; overflow: clip; line-height: 1;
  text-align: initial; -webkit-text-size-adjust: none; text-size-adjust: none;
  forced-color-adjust: none; transform-origin: 0 0; caret-color: CanvasText; z-index: 2;
}
.jk-pdf-text-layer span, .jk-pdf-text-layer br {
  color: transparent; position: absolute; white-space: pre; cursor: text;
  transform-origin: 0% 0%; user-select: text;
}
.jk-pdf-text-layer ::selection { background: rgba(0, 96, 255, 0.28); }
`;

/** 取 File 的磁盘路径（Electron 32+ 无 File.path，改用 preload 代理的 webUtils）。 */
function pathOf(file: File): string {
  return window.jareking.getPathForFile?.(file) ?? (file as File & { path?: string }).path ?? '';
}

/**
 * 单页渲染：canvas（按 dpr 放大绘制）+ 叠加文本层。
 * scale 变化 / 页变化 / 文档变化都会重新渲染。
 */
function PdfPageView({
  doc,
  pageNumber,
  scale,
  onRendered,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  onRendered?: (page: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    let textLayer: InstanceType<typeof pdfjsLib.TextLayer> | null = null;

    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      if (!canvas) return;

      // devicePixelRatio 缩放：backing store 放大，CSS 尺寸保持 viewport（清晰且不溢出）
      const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      renderTask = page.render({
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      await renderTask.promise;
      if (cancelled) return;
      setSize({ width: viewport.width, height: viewport.height });

      // 文本层（可选中复制）：pdf.js 4.7 提供 TextLayer 类
      const container = textLayerRef.current;
      if (!container) return;
      container.textContent = '';
      container.style.setProperty('--scale-factor', String(scale));
      const textContent = await page.getTextContent();
      if (cancelled) return;
      textLayer = new pdfjsLib.TextLayer({ textContentSource: textContent, container, viewport });
      await textLayer.render();
      if (!cancelled) onRendered?.(pageNumber);
    })().catch(() => {
      // 取消渲染（renderTask.cancel）会抛出 RenderingCancelledException，忽略即可
    });

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        /* 已完成渲染时 cancel 会抛错，忽略 */
      }
      try {
        textLayer?.cancel();
      } catch {
        /* 同上 */
      }
    };
  }, [doc, pageNumber, scale, onRendered]);

  return (
    <div
      className="relative shrink-0 bg-white shadow-card"
      style={{ width: size?.width, height: size?.height }}
    >
      <canvas ref={canvasRef} className="block" />
      <div ref={textLayerRef} className="jk-pdf-text-layer" />
    </div>
  );
}

/**
 * 连续模式下的单页容器：用 IntersectionObserver 懒加载——
 * 仅在进入「视口附近」时才真正渲染，避免一次性渲染上百页导致卡顿。
 */
function ContinuousPage({
  doc,
  pageNumber,
  scale,
  rootRef,
  registerRef,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rootRef: React.RefObject<HTMLDivElement | null>;
  registerRef: (page: number, el: HTMLDivElement | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [base, setBase] = useState<Size | null>(null);

  // 基准尺寸（scale=1）：用于未渲染时的占位高度，避免滚动跳动
  useEffect(() => {
    let cancelled = false;
    void doc
      .getPage(pageNumber)
      .then((p) => {
        if (cancelled) return;
        const vp = p.getViewport({ scale: 1 });
        setBase({ width: vp.width, height: vp.height });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber]);

  // 登记 wrapper，供父级计算当前可见页
  useEffect(() => {
    registerRef(pageNumber, wrapRef.current);
    return () => registerRef(pageNumber, null);
  }, [pageNumber, registerRef]);

  // 懒加载：进入视口附近（上下各 800px）即渲染一次
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { root: rootRef.current ?? null, rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootRef]);

  return (
    <div ref={wrapRef} data-jk-page={pageNumber} className="flex justify-center pb-3">
      {visible && base ? (
        <PdfPageView doc={doc} pageNumber={pageNumber} scale={scale} />
      ) : (
        <div
          className="shrink-0 bg-white shadow-card"
          style={{ width: base ? base.width * scale : undefined, height: base ? base.height * scale : undefined }}
        />
      )}
    </div>
  );
}

/** PDF 阅读器主组件。 */
export function PdfReader() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const scrollRaf = useRef<number | null>(null);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<ViewMode>('single');
  const [fit, setFit] = useState<FitMode>('width');
  const [zoom, setZoom] = useState(1);
  const [baseSize, setBaseSize] = useState<Size | null>(null);
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [showOutline, setShowOutline] = useState(true);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [pageInput, setPageInput] = useState('1');

  // 记录最新文档，供卸载时释放
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  // 卸载释放 pdf.js 文档（销毁 worker 侧资源）并取消挂起的滚动回调
  useEffect(
    () => () => {
      if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
      try {
        void docRef.current?.destroy();
      } catch {
        /* 忽略 */
      }
    },
    [],
  );

  // 容器尺寸监听：用于「适应宽度 / 适应页面」计算
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      setContainer({ width: el.clientWidth - SCROLL_PADDING, height: el.clientHeight - SCROLL_PADDING });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 基准尺寸：单页取当前页；连续取第 1 页（假设文档页面尺寸基本一致）
  useEffect(() => {
    if (!doc) {
      setBaseSize(null);
      return;
    }
    const refPage = mode === 'continuous' ? 1 : page;
    let cancelled = false;
    void doc
      .getPage(refPage)
      .then((p) => {
        if (cancelled) return;
        const vp = p.getViewport({ scale: 1 });
        setBaseSize({ width: vp.width, height: vp.height });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, mode, page]);

  // 有效缩放：自由缩放直接用 zoom；拟合模式按容器与基准尺寸计算
  const effectiveScale = useMemo(() => {
    if (fit === 'none' || !baseSize) return clampPdfZoom(zoom);
    return fitScale(baseSize, container, fit);
  }, [fit, zoom, baseSize, container]);

  // 同步页码输入框显示
  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  /** 读取并扁平化目录书签；解析每项目标页。 */
  const loadOutline = useCallback(async (target: PDFDocumentProxy) => {
    try {
      const raw = (await target.getOutline()) as unknown as RawOutlineNode[];
      if (!raw || raw.length === 0) {
        setOutline([]);
        return;
      }
      const flat: OutlineItem[] = [];
      const walk = async (items: RawOutlineNode[], depth: number): Promise<void> => {
        for (const item of items) {
          let pageNo: number | null = null;
          try {
            // dest 可为命名目标（string）或显式目标数组；两种都要解析成页索引
            const dest = typeof item.dest === 'string' ? await target.getDestination(item.dest) : item.dest;
            if (Array.isArray(dest) && dest.length > 0) {
              const idx = await target.getPageIndex(dest[0] as never);
              pageNo = idx + 1;
            }
          } catch {
            pageNo = null;
          }
          flat.push({ title: item.title, page: pageNo, depth });
          if (Array.isArray(item.items) && item.items.length > 0) {
            await walk(item.items, depth + 1);
          }
        }
      };
      await walk(raw, 0);
      setOutline(flat);
    } catch {
      setOutline([]);
    }
  }, []);

  /** 加载 PDF 字节。会先释放旧文档。 */
  const loadBytes = useCallback(
    async (bytes: Uint8Array, name: string) => {
      setLoading(true);
      setError(null);
      setSearchHits([]);
      setOutline([]);
      try {
        // 释放旧文档
        if (docRef.current) {
          try {
            await docRef.current.destroy();
          } catch {
            /* 忽略 */
          }
          docRef.current = null;
          setDoc(null);
        }
        const task = pdfjsLib.getDocument({ data: bytes, useSystemFonts: true });
        const loaded = await task.promise;
        docRef.current = loaded;
        setDoc(loaded);
        setNumPages(loaded.numPages);
        setPage(1);
        setFileName(name);
        toast.success(`已打开 PDF：${name}（${loaded.numPages} 页）`);
        // 目录（异步，不阻塞首屏）
        void loadOutline(loaded);
        if (shouldWarnContinuous(loaded.numPages) && mode === 'continuous') {
          toast.warning(`该文档共 ${loaded.numPages} 页，连续模式已启用懒加载，仍可能占用较多内存`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        toast.warning(`打开 PDF 失败：${msg}`);
      } finally {
        setLoading(false);
      }
    },
    [mode, loadOutline],
  );

  /** 从磁盘路径打开（供 pendingOpen：Ribbon / 最近使用）。 */
  const openFromPath = useCallback(
    async (path: string, name: string) => {
      try {
        setLoading(true);
        const bytes = await window.jareking.invoke<Uint8Array | null>('doc:read-file', { path });
        if (!bytes) {
          toast.warning('文件已不存在或无法读取');
          setLoading(false);
          return;
        }
        await loadBytes(new Uint8Array(bytes), name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.warning(`打开失败：${msg}`);
        setLoading(false);
      }
    },
    [loadBytes],
  );

  // 挂载时消费待打开信号（Ribbon「打开PDF」/ 首页「最近使用」）
  useEffect(() => {
    const pending = takePendingOpen();
    if (!pending || pending.module !== 'pdf') return;
    void openFromPath(pending.path, pending.name);
    // 仅挂载时消费一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 工具栏「打开 PDF」：本机文件选择 → 磁盘路径 → 读取字节渲染。 */
  const openViaPicker = useCallback(async () => {
    fileInputRef.current?.click();
  }, []);

  const onFileChosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      e.target.value = '';
      if (!file) return;
      const path = pathOf(file);
      if (!path) {
        toast.warning('未能读取文件路径，请在桌面端中选择本地文件');
        return;
      }
      void openFromPath(path, file.name);
    },
    [openFromPath],
  );

  /** 跳转到指定页（钳制并滚动到该页）。 */
  const goToPage = useCallback(
    (target: number) => {
      if (numPages <= 0) return;
      const next = Math.min(numPages, Math.max(1, Math.round(target)));
      setPage(next);
      if (mode === 'continuous') {
        pageRefs.current.get(next)?.scrollIntoView({ block: 'start' });
      }
    },
    [numPages, mode],
  );

  const stepPage = useCallback(
    (delta: number) => {
      goToPage(page + delta);
    },
    [goToPage, page],
  );

  /** 手动缩放：切到自由缩放模式并缩放。 */
  const zoomBy = useCallback(
    (delta: number) => {
      setFit('none');
      setZoom((z) => clampPdfZoom(z + delta));
    },
    [],
  );

  /** 连续模式滚动：计算当前可见页（rAF 节流）。 */
  const onScroll = useCallback(() => {
    if (mode !== 'continuous') return;
    if (scrollRaf.current !== null) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = null;
      const cont = scrollRef.current;
      if (!cont) return;
      const contTop = cont.getBoundingClientRect().top;
      const tops: number[] = [];
      for (let i = 1; i <= numPages; i++) {
        const el = pageRefs.current.get(i);
        tops.push(el ? el.getBoundingClientRect().top - contTop : Number.POSITIVE_INFINITY);
      }
      const visible = resolveVisiblePage(tops, 0);
      setPage((prev) => (prev === visible ? prev : visible));
    });
  }, [mode, numPages]);

  const registerRef = useCallback((n: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(n, el);
    else pageRefs.current.delete(n);
  }, []);

  /** 全文搜索：遍历各页文本匹配（大小写不敏感），列出结果。 */
  const runSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!doc || !query) return;
    setSearching(true);
    setSearchHits([]);
    try {
      const needle = query.toLowerCase();
      const hits: SearchHit[] = [];
      const MAX_HITS = 500;
      for (let i = 1; i <= numPages && hits.length < MAX_HITS; i++) {
        const p = await doc.getPage(i);
        const content = await p.getTextContent();
        let text = '';
        for (const item of content.items) {
          if (item && typeof item === 'object' && 'str' in item) {
            text += (item as { str: string }).str;
          }
        }
        const lower = text.toLowerCase();
        let from = 0;
        for (;;) {
          const idx = lower.indexOf(needle, from);
          if (idx === -1) break;
          hits.push({ page: i, snippet: makeSnippet(text, idx, query.length) });
          from = idx + Math.max(1, needle.length);
          if (hits.length >= MAX_HITS) break;
        }
      }
      setSearchHits(hits);
      if (hits.length === 0) toast.info('未找到匹配内容');
      else toast.success(`找到 ${hits.length} 处匹配`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.warning(`搜索失败：${msg}`);
    } finally {
      setSearching(false);
    }
  }, [doc, numPages, searchQuery]);

  const zoomPercent = Math.round(effectiveScale * 100);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted-bg/40">
      {/* 文本层样式（pdf.js TextLayer 依赖 --scale-factor 定位） */}
      <style>{TEXT_LAYER_CSS}</style>

      {/* 工具栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface px-2 text-tiny">
        <button
          type="button"
          title="打开 PDF"
          aria-label="打开 PDF"
          className="flex h-7 items-center gap-1 rounded-sm px-2 text-fg transition-colors hover:bg-hover"
          onClick={() => void openViaPicker()}
        >
          <FolderOpen size={14} aria-hidden="true" />
          打开
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={onFileChosen}
        />

        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {/* 翻页 */}
        <button
          type="button"
          title="首页"
          aria-label="首页"
          disabled={page <= 1}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-fg transition-colors hover:bg-hover disabled:opacity-30"
          onClick={() => goToPage(1)}
        >
          <ChevronsLeft size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          title="上一页"
          aria-label="上一页"
          disabled={page <= 1}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-fg transition-colors hover:bg-hover disabled:opacity-30"
          onClick={() => stepPage(-1)}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <span className="flex items-center gap-1 px-1 text-muted">
          第
          <input
            aria-label="页码"
            className="h-6 w-12 rounded border border-border bg-surface px-1 text-center text-fg outline-none"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const n = parsePageInput(pageInput, numPages);
                if (n === null) {
                  setPageInput(String(page));
                } else {
                  goToPage(n);
                }
              }
            }}
          />
          / {numPages || '—'} 页
        </span>
        <button
          type="button"
          title="下一页"
          aria-label="下一页"
          disabled={page >= numPages}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-fg transition-colors hover:bg-hover disabled:opacity-30"
          onClick={() => stepPage(1)}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          title="末页"
          aria-label="末页"
          disabled={page >= numPages}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-fg transition-colors hover:bg-hover disabled:opacity-30"
          onClick={() => goToPage(numPages)}
        >
          <ChevronsRight size={14} aria-hidden="true" />
        </button>

        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {/* 缩放 */}
        <button
          type="button"
          title="缩小"
          aria-label="缩小"
          className="flex h-7 w-7 items-center justify-center rounded-sm text-fg transition-colors hover:bg-hover"
          onClick={() => zoomBy(-PDF_ZOOM_STEP)}
        >
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        <span className="w-10 text-center text-muted">{zoomPercent}%</span>
        <button
          type="button"
          title="放大"
          aria-label="放大"
          className="flex h-7 w-7 items-center justify-center rounded-sm text-fg transition-colors hover:bg-hover"
          onClick={() => zoomBy(PDF_ZOOM_STEP)}
        >
          <ZoomIn size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          title="适应宽度"
          aria-label="适应宽度"
          aria-pressed={fit === 'width'}
          className={`flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-hover ${
            fit === 'width' ? 'bg-accent/15 text-accent' : 'text-fg'
          }`}
          onClick={() => setFit('width')}
        >
          <StretchHorizontal size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          title="适应页面"
          aria-label="适应页面"
          aria-pressed={fit === 'page'}
          className={`flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-hover ${
            fit === 'page' ? 'bg-accent/15 text-accent' : 'text-fg'
          }`}
          onClick={() => setFit('page')}
        >
          <Maximize2 size={14} aria-hidden="true" />
        </button>

        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {/* 单页 / 连续 */}
        <button
          type="button"
          title="单页模式"
          aria-label="单页模式"
          aria-pressed={mode === 'single'}
          className={`flex h-7 items-center gap-1 rounded-sm px-2 transition-colors hover:bg-hover ${
            mode === 'single' ? 'bg-accent/15 text-accent' : 'text-fg'
          }`}
          onClick={() => setMode('single')}
        >
          <FileText size={14} aria-hidden="true" />
          单页
        </button>
        <button
          type="button"
          title="连续模式"
          aria-label="连续模式"
          aria-pressed={mode === 'continuous'}
          className={`flex h-7 items-center gap-1 rounded-sm px-2 transition-colors hover:bg-hover ${
            mode === 'continuous' ? 'bg-accent/15 text-accent' : 'text-fg'
          }`}
          onClick={() => setMode('continuous')}
        >
          <Rows3 size={14} aria-hidden="true" />
          连续
        </button>

        {/* 目录开关（有书签时显示） */}
        {outline.length > 0 && (
          <button
            type="button"
            title="显示/隐藏目录"
            aria-label="显示/隐藏目录"
            aria-pressed={showOutline}
            className={`flex h-7 w-7 items-center justify-center rounded-sm transition-colors hover:bg-hover ${
              showOutline ? 'bg-accent/15 text-accent' : 'text-fg'
            }`}
            onClick={() => setShowOutline((v) => !v)}
          >
            <PanelLeft size={14} aria-hidden="true" />
          </button>
        )}

        {/* 搜索 */}
        <div className="ml-auto flex items-center gap-1">
          <Search size={13} className="shrink-0 text-muted" aria-hidden="true" />
          <input
            aria-label="全文搜索"
            placeholder="全文搜索…"
            className="h-6 w-36 rounded border border-border bg-surface px-2 text-fg outline-none placeholder:text-muted"
            value={searchQuery}
            disabled={!doc}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
          />
          <button
            type="button"
            title="搜索"
            aria-label="搜索"
            disabled={!doc || searching || !searchQuery.trim()}
            className="flex h-7 items-center rounded-sm px-2 text-fg transition-colors hover:bg-hover disabled:opacity-30"
            onClick={() => void runSearch()}
          >
            {searching ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : '搜索'}
          </button>
        </div>
      </div>

      {/* 正文区：目录侧栏 + 滚动画布 */}
      <div className="flex min-h-0 flex-1">
        {doc && outline.length > 0 && showOutline && (
          <div className="w-52 shrink-0 overflow-auto border-r border-border bg-surface p-1.5">
            <div className="px-1.5 py-1 text-tiny font-medium text-muted">目录</div>
            <ul className="flex flex-col">
              {outline.map((item, i) => (
                <li key={`${item.title}-${i}`}>
                  <button
                    type="button"
                    disabled={item.page === null}
                    title={item.page ? `跳转到第 ${item.page} 页` : item.title}
                    style={{ paddingLeft: 6 + item.depth * 12 }}
                    className="w-full truncate rounded-sm py-1 pr-1.5 text-left text-tiny text-fg transition-colors hover:bg-hover disabled:cursor-default disabled:text-muted"
                    onClick={() => {
                      if (item.page !== null) goToPage(item.page);
                    }}
                  >
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 搜索结果 */}
          {searchHits.length > 0 && (
            <div className="max-h-40 shrink-0 overflow-auto border-b border-border bg-surface px-2 py-1.5">
              <div className="mb-1 text-tiny text-muted">{searchHits.length} 处匹配（点击跳页；高亮见后续迭代）</div>
              <ul className="flex flex-col gap-0.5">
                {searchHits.map((hit, i) => (
                  <li key={`${hit.page}-${i}`}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-tiny transition-colors hover:bg-hover"
                      onClick={() => goToPage(hit.page)}
                    >
                      <span className="shrink-0 text-accent">第 {hit.page} 页</span>
                      <span className="min-w-0 flex-1 truncate text-fg">{hit.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 画布滚动区 */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-4" onScroll={onScroll}>
            {!doc && !loading && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <BookOpen size={30} className="text-muted" aria-hidden="true" />
                <p className="text-body text-muted">尚未打开 PDF</p>
                <p className="max-w-xs text-tiny text-muted">
                  点击工具栏「打开」选择本地 PDF，或从「PDF 工具 → 打开PDF」入口打开。
                </p>
                <button
                  type="button"
                  className="rounded-sm border border-border bg-surface px-3 py-1.5 text-ui text-fg transition-colors hover:bg-hover"
                  onClick={() => void openViaPicker()}
                >
                  打开 PDF
                </button>
              </div>
            )}

            {loading && (
              <div className="flex h-full items-center justify-center gap-2 text-muted">
                <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                正在加载 PDF…
              </div>
            )}

            {error && !loading && (
              <div className="flex h-full items-center justify-center text-center">
                <p className="text-ui text-muted">打开失败：{error}</p>
              </div>
            )}

            {doc && !loading && mode === 'single' && (
              <div className="flex min-h-full items-start justify-center">
                <PdfPageView doc={doc} pageNumber={page} scale={effectiveScale} />
              </div>
            )}

            {doc && !loading && mode === 'continuous' && (
              <div className="flex flex-col items-center">
                {Array.from({ length: numPages }, (_, i) => (
                  <ContinuousPage
                    key={i + 1}
                    doc={doc}
                    pageNumber={i + 1}
                    scale={effectiveScale}
                    rootRef={scrollRef}
                    registerRef={registerRef}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底部状态栏 */}
      {doc && (
        <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-tiny text-muted">
          <span className="min-w-0 truncate" title={fileName}>
            {fileName}
          </span>
          <span className="ml-auto">
            {mode === 'single' ? '单页' : '连续'} · 共 {numPages} 页
          </span>
        </div>
      )}
    </div>
  );
}

/*
 * =========================================================================
 * pdf.js 4.7.76 实际可用 API 结论（本次核实，供后续迭代参考）
 * -------------------------------------------------------------------------
 * 渲染：pdfjsLib.getDocument({ data, useSystemFonts }) → task.promise → PDFDocumentProxy；
 *      page.getViewport({ scale }) → viewport（width/height 为 CSS 像素）；
 *      page.render({ canvasContext, viewport, transform }) → RenderTask（.promise / .cancel()）。
 *      ⚠️ 4.7 参数名为 canvasContext（v5 才改为 canvas）；dpr 放大用 transform 传 [dpr,0,0,dpr,0,0]。
 * 文本层：4.7 导出 `TextLayer` 类（非旧的 renderTextLayer）：
 *      new pdfjsLib.TextLayer({ textContentSource, container, viewport }).render()；
 *      container 需设 `--scale-factor`（= viewport.scale），容器尺寸由内部 setLayerDimensions
 *      以 `calc(var(--scale-factor)*Wpx)` 写入。取消用 .cancel()。
 * 目录：doc.getOutline() → OutlineNode[]（title / dest / items）；
 *      dest 为 string 时先 doc.getDestination(name)，再 doc.getPageIndex(ref) 得 0 基页索引。
 * 搜索：page.getTextContent() → { items: [{ str }] }（无内置匹配统计，自行遍历）。
 * 释放：doc.destroy()（卸载/换文档时调用）。
 * Worker：new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url) 由 Vite 打包注入。
 * =========================================================================
 */
