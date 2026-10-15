/**
 * SlideEditor —— 基于 Konva（react-konva）的幻灯片编辑器（T3.2）。
 *
 * 职责：
 *  - 左侧幻灯片缩略列表（切换/新增/删除页）
 *  - 中央 Konva 舞台：按 EMU→px 比例渲染 文本框/预设形状/图片，可选中、拖拽移动、双击改文字
 *  - 工具栏：添加文本框/矩形/椭圆/图片、删除、打开/保存 .pptx（经 @jareking/presentation 数据层）
 *  - 图片：插入文件 → dataURL 展示 + 字节存入 media（键 `${slideIdx}:${relId}`）→ 保存落盘
 *
 * v1 范围：基础编辑（移动/文字/增删）；缩放变换手柄、多选、动画后续迭代。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Image as KImage, Layer, Line, Rect, Stage, Text as KText, Ellipse } from 'react-konva';
import type Konva from 'konva';
import {
  Circle,
  Copy,
  Download,
  FolderOpen,
  ImageIcon,
  Link,
  Play,
  Plus,
  Sparkles,
  Square,
  Table2,
  Timer,
  TimerOff,
  Trash2,
  Type,
  BarChart3,
} from 'lucide-react';
import { createAiAdapter, createPresentationPlanner, type PresentationOp } from '@jareking/ai';
import {
  exportPptx,
  type JkPresentation,
  type JkShape,
  type JkSlide,
  type JkTableCell,
  type JkTableShape,
  type TextParagraph,
} from '@jareking/presentation';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { toast } from '../stores/toastStore';
import { renderChartToPng, type ChartType } from '../lib/chartRenderer';
import { Modal } from '../components/Modal';
import { LoadingOverlay } from '../components/LoadingOverlay';
import { parseInWorker } from '../lib/parseClient';
import { downloadBlob } from '../lib/download';
import { takePendingOpen } from '../stores/pendingOpenStore';
import { largeFileHint } from '../lib/largeFile';
import { useAiStore } from '../stores/aiStore';
import { registerEditorCommands } from '../stores/editorCommands';
import { presentationToPrintBody, SLIDE_PRINT_CSS } from './presentationToHtml';
import { buildPrintDocument } from '../lib/printHtml';
import { exportHtmlToPdf } from '../lib/pdfExport';
import { SlideshowOverlay } from './SlideshowOverlay';
import {
  MAX_ADVANCE_MS,
  MIN_ADVANCE_MS,
  applyRehearsalTimings,
  clearRehearsalTimings,
  createRehearsal,
  hasRehearsalTimings,
  recordSlideTime,
  rehearsalSummary,
  type RehearsalRecord,
} from './rehearse';

/** 舞台像素宽（画布 EMU 宽按比例缩放） */
const STAGE_W = 896;
const STAGE_H = 504;

/** 缩略图列表项高度（含间距），用于虚拟滚动窗口化 */
const THUMB_ITEM_H = 66;

/** 便捷构造：带唯一 id */
let idSeq = 0;
const nextId = () => `shp-${Date.now().toString(36)}-${idSeq++}`;

function withIds(slide: JkSlide): JkSlide {
  return { ...slide, shapes: slide.shapes.map((s) => ({ ...s, id: s.id ?? nextId() })) };
}

/** 演示文稿（首载） */
function demoPresentation(): JkPresentation {
  return {
    slides: [
      {
        shapes: [
          {
            type: 'text',
            id: nextId(),
            name: '标题',
            x: 914400,
            y: 685800,
            w: 7315200,
            h: 1143000,
            paragraphs: [
              {
                runs: [{ text: 'jareking 演示文稿', bold: true, fontSize: 40, color: '#1F3864' }],
                align: 'center',
              },
            ],
          },
          {
            type: 'shape',
            id: nextId(),
            name: '强调块',
            geom: 'roundRect',
            x: 1371600,
            y: 2377440,
            w: 2743200,
            h: 914400,
            fill: '#4472C4',
            paragraphs: [
              { runs: [{ text: 'Konva 画布', bold: true, fontSize: 18, color: '#FFFFFF' }], align: 'center' },
            ],
          },
          {
            type: 'text',
            id: nextId(),
            name: '要点',
            x: 4800600,
            y: 2377440,
            w: 3200400,
            h: 1828800,
            paragraphs: [
              { runs: [{ text: '大纲级别 1', fontSize: 18 }], level: 1, bullet: true },
              { runs: [{ text: '大纲级别 2', fontSize: 16 }], level: 2, bullet: true },
            ],
          },
          {
            type: 'table',
            id: nextId(),
            name: '示例表格',
            x: 914400,
            y: 4434840,
            w: 7315200,
            h: 1143000,
            colWidths: [2438400, 2438400, 2438400],
            rows: [
              {
                cells: [
                  { text: '项目', bold: true, fontSize: 16 },
                  { text: 'Q1', bold: true, fontSize: 16 },
                  { text: 'Q2', bold: true, fontSize: 16 },
                ],
                height: 381000,
              },
              {
                cells: [
                  { text: '营收', fontSize: 16 },
                  { text: '120', fontSize: 16, align: 'right' },
                  { text: '158', fontSize: 16, align: 'right' },
                ],
                height: 381000,
              },
              {
                cells: [
                  { text: '利润', fontSize: 16 },
                  { text: '24', fontSize: 16, align: 'right' },
                  { text: '31', fontSize: 16, align: 'right' },
                ],
                height: 381000,
              },
            ],
            height: 1143000,
          },
        ],
      },
      {
        shapes: [
          {
            type: 'text',
            id: nextId(),
            name: '第二页',
            x: 2743200,
            y: 2286000,
            w: 3657600,
            h: 914400,
            paragraphs: [{ runs: [{ text: '第二页：待你编辑', fontSize: 28 }], align: 'center' }],
          },
        ],
      },
    ],
    slideWidth: 9144000,
    slideHeight: 6858000,
    media: {},
  };
}

/** 文本形状 → 纯文本（编辑用） */
function paragraphsToText(shape: JkShape): string {
  if (shape.type === 'image' || shape.type === 'table') return '';
  return (shape.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join('')).join('\n');
}

/** 纯文本 → 段落（沿用首个 run 的格式） */
function textToParagraphs(text: string, shape: JkShape): TextParagraph[] | undefined {
  if (shape.type === 'image' || shape.type === 'table') return undefined;
  const first = shape.paragraphs?.[0];
  const style = first?.runs?.[0];
  const base = style ? { ...style } : { text: '' };
  return text.split('\n').map((line, i) => ({
    runs: [{ ...base, text: line }],
    align: first?.align,
    level: i === 0 ? first?.level : undefined,
    bullet: i === 0 ? first?.bullet : undefined,
  }));
}

/** 表格行/列数允许区间（对齐 WPS 插入表格 1~10） */
const TABLE_MIN = 1;
const TABLE_MAX = 10;

/** 构造等分列宽/行高的表格形状（EMU）；行列数经钳制，位置居中 */
function makeTableShape(rows: number, cols: number, slideW: number, slideH: number): JkTableShape {
  const r = Math.min(TABLE_MAX, Math.max(TABLE_MIN, Math.round(rows) || 3));
  const c = Math.min(TABLE_MAX, Math.max(TABLE_MIN, Math.round(cols) || 3));
  const totalW = Math.min(Math.round(slideW * 0.7), 5486400); // ≈6 英寸，且不超画布 70%
  const rowH = 370840; // ≈0.4 英寸
  const colW = Math.round(totalW / c);
  const w = colW * c;
  const h = rowH * r;
  const x = Math.round((slideW - w) / 2);
  const y = Math.round((slideH - h) / 2);
  return {
    type: 'table',
    id: nextId(),
    name: '表格',
    x,
    y,
    w,
    h,
    colWidths: Array.from({ length: c }, () => colW),
    rows: Array.from({ length: r }, () => ({
      cells: Array.from({ length: c }, (): JkTableCell => ({ text: '', fontSize: 18 })),
      height: rowH,
    })),
    height: h,
  };
}

/** media 字节 → dataURL */
function bytesToDataUrl(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(bin)}`;
}

/** dataURL → media 字节（图表/图片插入用） */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(',')[1] ?? '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 加载 dataURL → HTMLImageElement（Konva.Image 需要） */
function useLoadedImages(urls: string[]): Record<string, HTMLImageElement> {
  const [loaded, setLoaded] = useState<Record<string, HTMLImageElement>>({});
  const key = urls.join('|');
  useEffect(() => {
    let alive = true;
    const next: Record<string, HTMLImageElement> = {};
    void Promise.all(
      urls.map(
        (u) =>
          new Promise<void>((res) => {
            const img = new window.Image();
            img.onload = () => {
              next[u] = img;
              res();
            };
            img.onerror = () => res();
            img.src = u;
          }),
      ),
    ).then(() => {
      if (alive) setLoaded(next);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return loaded;
}

/**
 * 超链接角标（Konva）：置于形状右下角的小徽标，标识该形状带外部超链接。
 * 用纯 Rect/Line 绘制（不依赖图片/字体），不影响形状本身样式；listening=false 不拦截点击。
 */
function LinkBadge({ x, y }: { x: number; y: number }) {
  return (
    <Group x={x} y={y} listening={false}>
      <Rect width={16} height={16} cornerRadius={3} fill="#2563EB" opacity={0.92} />
      {/* 白色外链箭头（斜线 + 箭头折线） */}
      <Line points={[4, 12, 12, 4]} stroke="#FFFFFF" strokeWidth={1.6} lineCap="round" />
      <Line points={[7, 4, 12, 4, 12, 9]} stroke="#FFFFFF" strokeWidth={1.6} lineCap="round" lineJoin="round" />
    </Group>
  );
}

export function SlideEditor() {
  const [pres, setPres] = useState<JkPresentation>(demoPresentation);
  const [slideIdx, setSlideIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const [playing, setPlaying] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [thumbScrollTop, setThumbScrollTop] = useState(0);
  const thumbScrollRef = useRef<HTMLDivElement>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  /** 可回退：AI 执行前的演示文稿快照（含媒体字节），撤销即整份恢复 */
  const aiUndoRef = useRef<JkPresentation | null>(null);
  const [aiCanUndo, setAiCanUndo] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const aiInstructionRef = useRef('');
  const configs = useAiStore((st) => st.configs);
  const aiLoaded = useAiStore((st) => st.loaded);
  const loadAiConfigs = useAiStore((st) => st.load);
  const resolveKey = useAiStore((st) => st.resolveKey);

  // 图表插入（用户反馈：PPT 数据页可视化难）——复用 lib/chartRenderer（公共能力）+ 图片管线
  const [chartOpen, setChartOpen] = useState(false);
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [chartTitle, setChartTitle] = useState('季度营收');
  const [chartLabels, setChartLabels] = useState('Q1,Q2,Q3,Q4');
  const [chartSeries, setChartSeries] = useState('营收|120,158,203,241');

  // 表格：插入弹窗 + 单元格文本编辑 + 当前选中单元格（增删行列锚点）
  const [tableOpen, setTableOpen] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableCols, setTableCols] = useState(3);
  const [cellEditOpen, setCellEditOpen] = useState(false);
  const [cellEditId, setCellEditId] = useState<string | null>(null);
  const [cellEditRow, setCellEditRow] = useState(0);
  const [cellEditCol, setCellEditCol] = useState(0);
  const [cellEditText, setCellEditText] = useState('');
  const [selCell, setSelCell] = useState<{ row: number; col: number } | null>(null);

  // 演讲者备注面板折叠态 + 文字编辑弹窗状态（WPS 对齐批3续）
  const [notesOpen, setNotesOpen] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  // 对象超链接（WPS 对齐：给形状/图片/文本加外部超链接，放映时点击跳转）
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState('');

  // 排练计时（WPS 对齐：幻灯片放映 → 排练计时）——以放映层计时，结束后询问是否保留为自动换片时间
  const [rehearsing, setRehearsing] = useState(false);
  const [rehearsalResult, setRehearsalResult] = useState<RehearsalRecord | null>(null);
  const [rehearseConfirmOpen, setRehearseConfirmOpen] = useState(false);

  useEffect(() => {
    if (!aiLoaded) void loadAiConfigs();
  }, [aiLoaded, loadAiConfigs]);

  // F5 放映（拦截浏览器默认刷新）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        setPlaying(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const slide: JkSlide | undefined = pres.slides[slideIdx];
  const scale = STAGE_W / pres.slideWidth;

  // 当前选中的表格（用于显示增删行列操作入口）
  const selectedShape = slide?.shapes.find((s) => s.id === selectedId);
  const selectedTable: JkTableShape | null = selectedShape?.type === 'table' ? selectedShape : null;

  // 图片 dataURL（当前页）
  const imageUrls = useMemo(() => {
    if (!slide) return [];
    return slide.shapes
      .filter((s) => s.type === 'image')
      .map((s) => `${s.relId}`)
      .map((key) => {
        const bytes = pres.media?.[`${slideIdx}:${key}`];
        return bytes ? bytesToDataUrl(bytes) : '';
      });
  }, [slide, pres.media, slideIdx]);
  const loadedImages = useLoadedImages(imageUrls.filter(Boolean));

  /** 更新当前页形状（不可变） */
  const updateShapes = (fn: (shapes: JkShape[]) => JkShape[]) => {
    setPres((prev) => {
      const slides = [...prev.slides];
      slides[slideIdx] = { ...slides[slideIdx], shapes: fn(slides[slideIdx].shapes) };
      return { ...prev, slides };
    });
  };

  /** 更新当前页演讲者备注（不可变；WPS 对齐批3续） */
  const updateNotes = (text: string) => {
    setPres((prev) => {
      const slides = [...prev.slides];
      slides[slideIdx] = { ...slides[slideIdx], notes: text };
      return { ...prev, slides };
    });
  };

  const onSelect = (id: string | null) => {
    setSelectedId(id);
    // 切换选中的非表格形状时清空表格单元格选择（避免残留增删锚点）
    const shape = id ? slide?.shapes.find((s) => s.id === id) : undefined;
    if (shape?.type !== 'table') setSelCell(null);
  };

  const onDragEnd = (id: string, x: number, y: number) => {
    updateShapes((shapes) =>
      shapes.map((s) =>
        s.id === id ? { ...s, x: Math.round(x / scale), y: Math.round(y / scale) } : s,
      ),
    );
  };

  const onEditText = (id: string) => {
    const shape = slide?.shapes.find((s) => s.id === id);
    if (!shape || shape.type === 'image') return;
    // CDP 阻断遗留修复：弃用 window.prompt（会阻断 Electron CDP 自动化），
    // 改用 Modal + Textarea（与现有 Modal 用法一致）
    setEditId(id);
    setEditText(paragraphsToText(shape));
    setEditOpen(true);
  };

  /** 弹窗「应用」：将临时文本写回形状段落 */
  const applyEditText = () => {
    if (editId === null) return;
    const id = editId;
    const text = editText;
    updateShapes((shapes) =>
      shapes.map((s) => (s.id === id ? ({ ...s, paragraphs: textToParagraphs(text, s) } as JkShape) : s)),
    );
    setEditOpen(false);
    setEditId(null);
  };

  /** 工具栏「超链接」：需先选中一个形状，打开弹窗并预填当前链接（无 window.prompt） */
  const openHyperlink = () => {
    if (!selectedId) {
      toast.warning('请先选中一个形状');
      return;
    }
    const shape = slide?.shapes.find((s) => s.id === selectedId);
    if (!shape) {
      toast.warning('请先选中一个形状');
      return;
    }
    setLinkId(selectedId);
    setLinkUrl(shape.hyperlink ?? '');
    setLinkOpen(true);
  };

  /** 弹窗「应用」：写入/更新目标形状的 hyperlink（空串视为不修改内容，交由「移除」处理） */
  const applyHyperlink = () => {
    if (linkId === null) return;
    const id = linkId;
    const url = linkUrl.trim();
    if (!url) {
      toast.warning('请输入链接地址，或点击「移除链接」');
      return;
    }
    updateShapes((shapes) => shapes.map((s) => (s.id === id ? { ...s, hyperlink: url } : s)));
    setLinkOpen(false);
    setLinkId(null);
    toast.success('已设置超链接');
  };

  /** 弹窗「移除链接」：清空目标形状的 hyperlink */
  const removeHyperlink = () => {
    if (linkId === null) return;
    const id = linkId;
    updateShapes((shapes) => shapes.map((s) => (s.id === id ? { ...s, hyperlink: undefined } : s)));
    setLinkOpen(false);
    setLinkId(null);
    toast.success('已移除超链接');
  };

  const addShape = (kind: 'text' | 'rect' | 'ellipse') => {
    const cx = (pres.slideWidth - 2743200) / 2;
    const cy = (pres.slideHeight - 914400) / 2;
    let shape: JkShape;
    if (kind === 'text') {
      shape = {
        type: 'text',
        id: nextId(),
        name: '文本框',
        x: cx,
        y: cy,
        w: 2743200,
        h: 914400,
        paragraphs: [{ runs: [{ text: '新建文本', fontSize: 20 }] }],
      };
    } else if (kind === 'rect') {
      shape = { type: 'shape', id: nextId(), name: '矩形', geom: 'rect', x: cx, y: cy, w: 1828800, h: 1143000, fill: '#4472C4' };
    } else {
      shape = { type: 'shape', id: nextId(), name: '椭圆', geom: 'ellipse', x: cx, y: cy, w: 1828800, h: 1828800, fill: '#ED7D31' };
    }
    updateShapes((shapes) => [...shapes, shape]);
    setSelectedId(shape.id!);
  };

  const addImage = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const relId = `img-${Date.now().toString(36)}`;
    const cx = (pres.slideWidth - 2743200) / 2;
    const cy = (pres.slideHeight - 1828800) / 2;
    setPres((prev) => {
      const slides = [...prev.slides];
      slides[slideIdx] = {
        ...slides[slideIdx],
        shapes: [
          ...slides[slideIdx].shapes,
          { type: 'image', id: nextId(), relId, x: cx, y: cy, w: 2743200, h: 1828800 },
        ],
      };
      return {
        ...prev,
        slides,
        media: { ...prev.media, [`${slideIdx}:${relId}`]: bytes },
      };
    });
    toast.success('已插入图片');
  };

  /** 插入图表：复用图表渲染器生成 PNG → 走图片插入管线 */
  const addChart = () => {
    const labels = chartLabels.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (!labels.length) {
      toast.warning('请填写类别（逗号分隔）');
      return;
    }
    const series = chartSeries
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line, i) => {
        const idx = line.search(/[|｜]/);
        const name = idx >= 0 ? line.slice(0, idx).trim() : `系列${i + 1}`;
        const vals = (idx >= 0 ? line.slice(idx + 1) : line)
          .split(/[,，]/)
          .map((s) => Number(s.trim()))
          .filter((v) => Number.isFinite(v));
        return { name, values: vals };
      });
    if (!series.length || series.some((s) => !s.values.length)) {
      toast.warning('请填写数据（每行：名称|值1,值2,…）');
      return;
    }
    const dataUrl = renderChartToPng(chartType, labels, series, chartTitle.trim());
    if (!dataUrl) {
      toast.warning('图表渲染失败');
      return;
    }
    const bytes = dataUrlToBytes(dataUrl);
    const relId = `img-${Date.now().toString(36)}`;
    const w = 2743200;
    const h = Math.round((w * 520) / 880);
    const cx = (pres.slideWidth - w) / 2;
    const cy = (pres.slideHeight - h) / 2;
    setPres((prev) => {
      const slides = [...prev.slides];
      slides[slideIdx] = {
        ...slides[slideIdx],
        shapes: [
          ...slides[slideIdx].shapes,
          { type: 'image', id: nextId(), relId, x: cx, y: cy, w, h },
        ],
      };
      return {
        ...prev,
        slides,
        media: { ...prev.media, [`${slideIdx}:${relId}`]: bytes },
      };
    });
    toast.success('已插入图表');
    setChartOpen(false);
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    updateShapes((shapes) => shapes.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  };

  const duplicateSelected = () => {
    const shape = slide?.shapes.find((s) => s.id === selectedId);
    if (!shape) return;
    const copy = { ...shape, id: nextId(), name: `${shape.name ?? '形状'} 副本`, x: shape.x + 228600, y: shape.y + 228600 };
    updateShapes((shapes) => [...shapes, copy]);
    setSelectedId(copy.id!);
  };

  /* —— 表格：插入 / 单元格编辑 / 增删行列（WPS 对齐）—— */

  /** 插入表格：按弹窗所选行列数生成等分表格，追加当前页并选中 */
  const addTable = () => {
    const shape = makeTableShape(tableRows, tableCols, pres.slideWidth, pres.slideHeight);
    updateShapes((shapes) => [...shapes, shape]);
    setSelectedId(shape.id!);
    setSelCell({ row: 0, col: 0 });
    setTableOpen(false);
    toast.success(`已插入 ${shape.rows.length}×${shape.colWidths.length} 表格`);
  };

  /** 打开单元格文本编辑弹窗（双击单元格触发） */
  const onEditCell = (id: string, row: number, col: number) => {
    const shape = slide?.shapes.find((s) => s.id === id);
    if (!shape || shape.type !== 'table') return;
    const cell = shape.rows[row]?.cells[col];
    setCellEditId(id);
    setCellEditRow(row);
    setCellEditCol(col);
    setCellEditText(cell?.text ?? '');
    setSelCell({ row, col });
    setSelectedId(id);
    setCellEditOpen(true);
  };

  /** 弹窗「应用」：将临时文本写回目标单元格 */
  const applyEditCell = () => {
    if (cellEditId === null) return;
    const id = cellEditId;
    const { row, col } = { row: cellEditRow, col: cellEditCol };
    const text = cellEditText;
    updateShapes((shapes) =>
      shapes.map((s) => {
        if (s.id !== id || s.type !== 'table') return s;
        const rows = s.rows.map((r, ri) => {
          if (ri !== row) return r;
          const cells = r.cells.map((cell, ci) => (ci === col ? { ...cell, text } : cell));
          return { ...r, cells };
        });
        return { ...s, rows };
      }),
    );
    setCellEditOpen(false);
    setCellEditId(null);
  };

  /** 以选中表格为对象做不可变变更 */
  const mutateSelectedTable = (fn: (t: JkTableShape) => JkTableShape) => {
    if (!selectedId) return;
    updateShapes((shapes) =>
      shapes.map((s) => (s.id === selectedId && s.type === 'table' ? fn(s) : s)),
    );
  };

  /** 新增行（在选中行之后；无选中则追加到末尾），行高沿用首行或均分 */
  const addTableRow = () => {
    mutateSelectedTable((t) => {
      const colCount = t.colWidths.length;
      const rowH = t.rows[0]?.height ?? Math.round((t.height ?? t.h) / Math.max(1, t.rows.length));
      const at = selCell ? Math.min(selCell.row + 1, t.rows.length) : t.rows.length;
      const rows = [...t.rows];
      rows.splice(at, 0, {
        cells: Array.from({ length: colCount }, (): JkTableCell => ({ text: '', fontSize: 18 })),
        height: rowH,
      });
      const height = rows.reduce((sum, r) => sum + (r.height ?? rowH), 0);
      return { ...t, rows, height, h: height };
    });
  };

  /** 新增列（在选中列之后；无选中则追加到末尾），列宽沿用首列或均分 */
  const addTableCol = () => {
    mutateSelectedTable((t) => {
      const colW = t.colWidths[0] ?? Math.round(t.w / Math.max(1, t.colWidths.length));
      const at = selCell ? Math.min(selCell.col + 1, t.colWidths.length) : t.colWidths.length;
      const colWidths = [...t.colWidths];
      colWidths.splice(at, 0, colW);
      const rows = t.rows.map((r) => {
        const cells = [...r.cells];
        cells.splice(at, 0, { text: '', fontSize: 18 });
        return { ...r, cells };
      });
      return { ...t, colWidths, rows, w: colWidths.reduce((a, b) => a + b, 0) };
    });
  };

  /** 删除选中行（至少保留一行） */
  const deleteTableRow = () => {
    if (!selCell) {
      toast.warning('请先点选一个单元格');
      return;
    }
    const targetRow = selCell.row;
    mutateSelectedTable((t) => {
      if (t.rows.length <= 1) return t;
      const rowH = t.rows[targetRow]?.height ?? 0;
      const rows = t.rows.filter((_, i) => i !== targetRow);
      const height = Math.max(0, (t.height ?? t.h) - rowH);
      return { ...t, rows, height, h: height };
    });
    setSelCell((sc) => (sc ? { row: Math.max(0, sc.row - 1), col: sc.col } : sc));
  };

  /** 删除选中列（至少保留一列） */
  const deleteTableCol = () => {
    if (!selCell) {
      toast.warning('请先点选一个单元格');
      return;
    }
    const targetCol = selCell.col;
    mutateSelectedTable((t) => {
      if (t.colWidths.length <= 1) return t;
      const colWidths = t.colWidths.filter((_, i) => i !== targetCol);
      const rows = t.rows.map((r) => ({ ...r, cells: r.cells.filter((_, i) => i !== targetCol) }));
      return { ...t, colWidths, rows, w: colWidths.reduce((a, b) => a + b, 0) };
    });
    setSelCell((sc) => (sc ? { row: sc.row, col: Math.max(0, sc.col - 1) } : sc));
  };

  const addSlide = () => {
    setPres((prev) => {
      const slides = [...prev.slides];
      slides.splice(slideIdx + 1, 0, { shapes: [] });
      return { ...prev, slides };
    });
    setSlideIdx((i) => i + 1);
  };

  const deleteSlide = () => {
    if (pres.slides.length <= 1) {
      toast.warning('至少保留一页');
      return;
    }
    setPres((prev) => ({ ...prev, slides: prev.slides.filter((_, i) => i !== slideIdx) }));
    setSlideIdx((i) => Math.max(0, i - 1));
  };

  /** T4.6：大纲 → 成稿（Presentation Planner → addSlide ops → 追加幻灯片） */
  const runPresentationAi = async (instruction: string) => {
    if (!instruction || aiBusy) return;
    const config = configs.find((c) => c.enabled);
    if (!config) {
      toast.warning('请先在「设置 → AI 服务商」配置并启用一个服务商');
      return;
    }
    setAiBusy(true);
    setAiNote('AI 生成中…');
    try {
      const key = await resolveKey(config.id);
      const adapter = createAiAdapter(config, key);
      const planner = createPresentationPlanner({ adapter });
      const plan = await planner.planPresentation(instruction, {
        slideCount: pres.slides.length,
        outline: pres.slides
          .map((sl, i) => `第${i + 1}页：${sl.shapes.find((x) => x.type === 'text' && (x as JkShape & { paragraphs?: unknown }).paragraphs)?.name ?? ''}`)
          .join('；'),
      });
      if (!plan.ops.length) {
        setAiNote(plan.explanation || '（无生成内容）');
        return;
      }
      const newSlides = plan.ops
        .filter((o): o is Extract<PresentationOp, { op: 'addSlide' }> => o.op === 'addSlide')
        .map(buildSlideFromOp);
      // 可回退：执行前整份快照（含媒体）
      aiUndoRef.current = structuredClone(pres);
      setPres((prev) => ({ ...prev, slides: [...prev.slides, ...newSlides] }));
      setSlideIdx(pres.slides.length);
      setAiCanUndo(true);
      setAiNote(`${plan.explanation || '已生成'} · 新增 ${newSlides.length} 页`);
      toast.success(`AI 已生成 ${newSlides.length} 页幻灯片（可撤销）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAiNote(`失败：${msg}`);
      toast.warning(`AI 生成失败：${msg}`);
    } finally {
      setAiBusy(false);
    }
  };

  /** 调试钩子（--jk-debug）：供自动化冒烟断言与触发 */
  const aiRunRef = useRef(runPresentationAi);
  aiRunRef.current = runPresentationAi;
  const addChartRunRef = useRef(addChart);
  addChartRunRef.current = addChart;

  /**
   * 导出 PDF（WPS 对齐批2）：演示文稿 → 逐页打印 HTML → Electron 打印管线 → downloadBlob。
   * mediaMap：遍历 pres.media，键 `${slideIndex}:${relId}` → data URL（复用 bytesToDataUrl）。
   * landscape 由画布宽高自动判定（slideWidth > slideHeight 视为横向）。
   */
  const onExportPdf = async () => {
    try {
      const mediaMap = new Map<string, string>();
      for (const [key, bytes] of Object.entries(pres.media ?? {})) {
        mediaMap.set(key, bytesToDataUrl(bytes));
      }
      const body = presentationToPrintBody(pres, mediaMap);
      const landscape = pres.slideWidth > pres.slideHeight;
      const html = buildPrintDocument({
        title: '导出',
        bodyHtml: body,
        extraCss: SLIDE_PRINT_CSS,
        landscape,
      });
      await exportHtmlToPdf({ html, fileName: '导出.pdf', pageSize: 'A4', landscape });
      toast.success('已导出「导出.pdf」');
    } catch (err) {
      toast.warning('导出 PDF 失败：' + (err instanceof Error ? err.message : String(err)));
    }
  };

  /**
   * Ribbon「插入 → 表格」与「文件 → 导出 PDF」按钮经命令总线（editorCommands）驱动本编辑器：
   * 挂载时注册 `table` / `export-pdf` 命令。
   */
  const openTableRef = useRef(() => {});
  openTableRef.current = () => setTableOpen(true);
  const exportPdfRef = useRef(() => {});
  exportPdfRef.current = () => void onExportPdf();
  useEffect(
    () =>
      registerEditorCommands({
        table: { run: () => openTableRef.current() },
        'export-pdf': { run: () => exportPdfRef.current() },
      }),
    [],
  );

  /** 最近文档直达（WPS 对齐 N5）：消费首页「最近使用」点击 */
  useEffect(() => {
    const p = takePendingOpen();
    if (!p || p.module !== 'slide' || !/\.pptx$/i.test(p.path)) return;
    void (async () => {
      try {
        setFileLoading(true);
        const bytes = await window.jareking.invoke<Uint8Array | null>('doc:read-file', { path: p.path });
        if (!bytes) {
          toast.warning('文件已不存在或无法读取');
          return;
        }
        const loaded = await parseInWorker('pptx', new Uint8Array(bytes));
        setPres({ ...loaded, slides: loaded.slides.map(withIds) });
        setSlideIdx(0);
        toast.success(`已打开 ${p.name}`);
      } catch (err) {
        toast.warning(`打开失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setFileLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('jk-debug')) {
      (window as unknown as Record<string, unknown>).__jkSlideDebug = {
        runPresentationAi: (instruction: string) => aiRunRef.current(instruction),
        // #46-C 压测钩子：解析级直调（transfer 会 neuter buf.buffer）
        parseInWorker: (kind: 'xlsx' | 'pptx', buf: Uint8Array) => parseInWorker(kind, buf),
        // T3.3：各页切换效果（断言工具栏设置生效）
        transitions: () => pres.slides.map((s) => s.transition ?? 'none'),
        // 排练计时：每页自动换片时间（advTm），无/非法则 null
        advanceTimings: () =>
          pres.slides.map((s) =>
            typeof s.advanceAfterMs === 'number' && Number.isFinite(s.advanceAfterMs)
              ? s.advanceAfterMs
              : null,
          ),
        // 排练计时探针：内部走 applyRehearsalTimings 写回，再校验结果与预期一致（一致则应用）
        rehearsalProbe: (slideMs: number[]) => {
          let rec = createRehearsal(pres.slides.length);
          slideMs.forEach((ms, i) => {
            rec = recordSlideTime(rec, i, ms);
          });
          const applied = applyRehearsalTimings(pres, rec);
          const actual = applied.slides.map((s) =>
            typeof s.advanceAfterMs === 'number' && Number.isFinite(s.advanceAfterMs)
              ? s.advanceAfterMs
              : null,
          );
          const expected = pres.slides.map((_, i) => {
            const ms = slideMs[i];
            if (ms === undefined || !Number.isFinite(ms) || ms < MIN_ADVANCE_MS) return null;
            return Math.min(Math.max(ms, MIN_ADVANCE_MS), MAX_ADVANCE_MS);
          });
          const ok = JSON.stringify(actual) === JSON.stringify(expected);
          if (ok) setPres(applied);
          return ok;
        },
        slideCount: () => pres.slides.length,
        imageCount: () =>
          pres.slides.flatMap((s) => s.shapes).filter((sh) => sh.type === 'image').length,
        mediaCount: () => Object.keys(pres.media ?? {}).length,
        insertChart: () => addChartRunRef.current(),
        renderChartTest: () =>
          renderChartToPng('bar', ['A', 'B'], [{ name: 'x', values: [1, 2] }], 't')?.length ?? -1,
        // 导出 PDF 探针（QA 冒烟）：与 onExportPdf 同路径构建 HTML，不下载，直接返回 { size, head }
        pdfProbe: async () => {
          const mediaMap = new Map<string, string>();
          for (const [key, bytes] of Object.entries(pres.media ?? {})) {
            mediaMap.set(key, bytesToDataUrl(bytes));
          }
          const html = buildPrintDocument({
            title: '导出',
            bodyHtml: presentationToPrintBody(pres, mediaMap),
            extraCss: SLIDE_PRINT_CSS,
            landscape: pres.slideWidth > pres.slideHeight,
          });
          const bytes = await window.jareking.invoke<Uint8Array>(
            window.jareking.IPC.PDF_EXPORT_HTML,
            { html, fileName: '导出.pdf', pageSize: 'A4', landscape: pres.slideWidth > pres.slideHeight },
          );
          return { size: bytes.length, head: String.fromCharCode(...bytes.slice(0, 5)) };
        },
      };
    }
  });

  /** T4.6：addSlide op → 排版为标题 + 要点文本框 */
  const buildSlideFromOp = (op: Extract<PresentationOp, { op: 'addSlide' }>): JkSlide => ({
    shapes: [
      {
        type: 'text',
        id: nextId(),
        name: op.title.slice(0, 12) || '标题',
        x: 914400,
        y: 457200,
        w: 7315200,
        h: 914400,
        paragraphs: [{ runs: [{ text: op.title, bold: true, fontSize: 32, color: '#1F3864' }], align: 'center' }],
      },
      ...(op.bullets.length
        ? [
            {
              type: 'text' as const,
              id: nextId(),
              name: '要点',
              x: 1143000,
              y: 1828800,
              w: 6858000,
              h: 3657600,
              paragraphs: op.bullets.map((b) => ({
                runs: [{ text: b, fontSize: 20 }],
                level: 1,
                bullet: true,
              })),
            },
          ]
        : []),
    ],
  });

  const onOpenFile = () => fileInputRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setFileLoading(true);
      // 让遮罩先绘制，避免大文件解析期间 UI 冻结错觉
      await new Promise((r) => setTimeout(r, 0));
      const buf = new Uint8Array(await file.arrayBuffer());
      const loaded = await parseInWorker('pptx', buf);
      setPres({ ...loaded, slides: loaded.slides.map(withIds) });
      setSlideIdx(0);
      setSelectedId(null);
      setThumbScrollTop(0);
      if (thumbScrollRef.current) thumbScrollRef.current.scrollTop = 0;
      const hint = largeFileHint(file.size, 'ppt');
      if (hint) toast.warning(hint);
      toast.success(`已打开 ${file.name}`);
    } catch (err) {
      console.error('打开 pptx 失败:', err);
      toast.warning('打开失败：文件可能不是有效的 .pptx');
    } finally {
      setFileLoading(false);
    }
  };

  const onSave = async () => {
    try {
      const buf = await exportPptx(pres);
      downloadBlob(
        buf,
        '导出.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
      toast.success('已导出「导出.pptx」');
    } catch {
      toast.warning('导出失败');
    }
  };

  /**
   * 渲染表格形状（Konva）：Group 定位到表格左上角，单元格用 Rect（底/边框）+ Text。
   * 按 colWidths 累加列左边界、按行高累加行上边界；复用与其它形状一致的缩放体系。
   * 单击单元格选中表格并记录单元格；双击单元格打开文本编辑弹窗。
   */
  const renderTable = (shape: JkTableShape) => {
    const selected = shape.id === selectedId;
    const rows = shape.rows;
    const cols = shape.colWidths;
    const totalH = shape.height ?? shape.h;
    const rowHpx = (i: number) => {
      const rh = rows[i]?.height ?? totalH / Math.max(1, rows.length);
      return rh * scale;
    };
    let accY = 0;
    const rowTops = rows.map((_, i) => {
      const top = accY;
      accY += rowHpx(i);
      return top;
    });
    let accX = 0;
    const colLefts = cols.map((w) => {
      const left = accX;
      accX += w * scale;
      return left;
    });
    const totalWpx = cols.reduce((a, b) => a + b, 0) * scale;
    const totalHpx = accY; // 各行高之和（px）

    return (
      <Group
        key={shape.id}
        x={shape.x * scale}
        y={shape.y * scale}
        rotation={shape.rotation}
        draggable
        onClick={() => onSelect(shape.id!)}
        onTap={() => onSelect(shape.id!)}
        onDragEnd={(e: Konva.KonvaEventObject<DragEvent>) =>
          onDragEnd(shape.id!, e.target.x(), e.target.y())
        }
      >
        {/* 外框（底色），置于单元格之下 */}
        <Rect
          width={totalWpx}
          height={totalHpx}
          fill="#FFFFFF"
          stroke={selected ? '#2563EB' : '#9CA3AF'}
          strokeWidth={selected ? 2 : 1}
        />
        {rows.map((row, r) =>
          colLefts.map((left, c) => {
            const cell = row.cells[c] ?? { text: '' };
            const cw = cols[c] * scale;
            const ch = rowHpx(r);
            const isCellSel = selCell !== null && selCell.row === r && selCell.col === c;
            return (
              <Group
                key={`${r}-${c}`}
                x={left}
                y={rowTops[r]}
                onClick={() => {
                  setSelCell({ row: r, col: c });
                  onSelect(shape.id!);
                }}
                onTap={() => {
                  setSelCell({ row: r, col: c });
                  onSelect(shape.id!);
                }}
                onDblClick={() => onEditCell(shape.id!, r, c)}
              >
                <Rect
                  width={cw}
                  height={ch}
                  fill="#FFFFFF"
                  stroke="#9CA3AF"
                  strokeWidth={1}
                  strokeScaleEnabled={false}
                />
                {isCellSel ? (
                  <Rect
                    width={cw}
                    height={ch}
                    stroke="#2563EB"
                    strokeWidth={2}
                    strokeScaleEnabled={false}
                  />
                ) : null}
                <KText
                  text={cell.text}
                  width={cw}
                  height={ch}
                  padding={4}
                  align={cell.align ?? 'left'}
                  verticalAlign="middle"
                  fontSize={(cell.fontSize ?? 18) * 1.333 * scale}
                  fontStyle={cell.bold ? 'bold' : 'normal'}
                  fill={cell.color ?? '#1F2937'}
                  wrap="word"
                  listening={false}
                />
              </Group>
            );
          }),
        )}
        {/* 超链接标识：右下角小链角标 */}
        {shape.hyperlink ? <LinkBadge x={totalWpx - 18} y={totalHpx - 18} /> : null}
      </Group>
    );
  };

  /** 渲染单个形状（Konva 节点） */
  const renderShape = (shape: JkShape, idx: number) => {
    if (shape.type === 'table') return renderTable(shape);
    const x = shape.x * scale;
    const y = shape.y * scale;
    const w = shape.w * scale;
    const h = shape.h * scale;
    const selected = shape.id === selectedId;
    const common = {
      x,
      y,
      rotation: shape.rotation,
      draggable: true,
      onClick: () => onSelect(shape.id!),
      onTap: () => onSelect(shape.id!),
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) =>
        onDragEnd(shape.id!, e.target.x(), e.target.y()),
      onDblClick: () => onEditText(shape.id!),
    };

    if (shape.type === 'image') {
      const url = imageUrls[idx] || '';
      const el = loadedImages[url];
      return (
        <Group key={shape.id} {...common}>
          {el ? (
            <KImage image={el} width={w} height={h} stroke={selected ? '#2563EB' : undefined} strokeWidth={selected ? 2 : 0} />
          ) : (
            <Rect width={w} height={h} fill="#E5E7EB" />
          )}
          {shape.hyperlink ? <LinkBadge x={w - 18} y={h - 18} /> : null}
        </Group>
      );
    }

    if (shape.type === 'shape') {
      const fill = shape.fill ?? '#94A3B8';
      const body =
        shape.geom === 'ellipse' ? (
          <Ellipse x={w / 2} y={h / 2} radiusX={w / 2} radiusY={h / 2} fill={fill} stroke={selected ? '#2563EB' : undefined} strokeWidth={selected ? 2 : 0} />
        ) : (
          <Rect width={w} height={h} cornerRadius={shape.geom === 'roundRect' ? 8 : 0} fill={fill} stroke={selected ? '#2563EB' : undefined} strokeWidth={selected ? 2 : 0} />
        );
      const plain = paragraphsToText(shape);
      return (
        <Group key={shape.id} {...common}>
          {body}
          {plain ? (
            <KText
              text={plain}
              width={w}
              height={h}
              align="center"
              verticalAlign="middle"
              fontSize={(shape.paragraphs?.[0]?.runs?.[0]?.fontSize ?? 18) * 1.333 * scale}
              fill={shape.paragraphs?.[0]?.runs?.[0]?.color ?? '#FFFFFF'}
              listening={false}
            />
          ) : null}
          {shape.hyperlink ? <LinkBadge x={w - 18} y={h - 18} /> : null}
        </Group>
      );
    }

    // text
    const plain = paragraphsToText(shape);
    const firstRun = shape.paragraphs?.[0]?.runs?.[0];
    const align = shape.paragraphs?.[0]?.align ?? 'left';
    const bulletLines = shape.paragraphs?.map((p) => (p.bullet ? '• ' : '')).join('');
    void bulletLines;
    const lines = shape.paragraphs?.map((p) => {
      const txt = p.runs.map((r) => r.text).join('');
      return p.bullet ? `• ${txt}` : txt;
    });
    return (
      <Group key={shape.id} {...common}>
        {selected ? <Rect width={w} height={h} stroke="#2563EB" dash={[4, 4]} strokeWidth={1.5} /> : null}
        <KText
          text={(lines ?? [plain]).join('\n')}
          width={w}
          align={align}
          fontSize={(firstRun?.fontSize ?? 18) * 1.333 * scale}
          fontStyle={`${firstRun?.bold ? 'bold ' : ''}${firstRun?.italic ? 'italic' : ''}`.trim() || 'normal'}
          fill={firstRun?.color ?? '#1F2937'}
        />
        {shape.hyperlink ? <LinkBadge x={w - 18} y={h - 18} /> : null}
      </Group>
    );
  };

  return (
    <div className="relative flex h-full w-full min-h-0">
      {/* 左：幻灯片列表（缩略图虚拟滚动，避免上千页时 DOM 爆炸） */}
      <div className="flex w-40 shrink-0 flex-col border-r border-border bg-surface p-2">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-tiny text-muted">幻灯片</span>
          <button type="button" className="rounded p-1 hover:bg-muted" title="新增幻灯片" onClick={addSlide}>
            <Plus size={14} />
          </button>
        </div>
        <div
          ref={thumbScrollRef}
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(e) => setThumbScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ position: 'relative', height: pres.slides.length * THUMB_ITEM_H }}>
            {(() => {
              const viewportH = thumbScrollRef.current?.clientHeight ?? 480;
              const buffer = 5;
              const start = Math.max(0, Math.floor(thumbScrollTop / THUMB_ITEM_H) - buffer);
              const end = Math.min(
                pres.slides.length,
                Math.ceil((thumbScrollTop + viewportH) / THUMB_ITEM_H) + buffer,
              );
              const items: React.ReactNode[] = [];
              for (let i = start; i < end; i++) {
                items.push(
                  <button
                    key={i}
                    type="button"
                    className={`flex w-full items-center justify-center rounded border text-tiny ${
                      i === slideIdx
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border text-muted hover:bg-muted'
                    }`}
                    style={{
                      position: 'absolute',
                      top: i * THUMB_ITEM_H,
                      left: 0,
                      right: 0,
                      height: THUMB_ITEM_H - 4,
                    }}
                    onClick={() => {
                      setSlideIdx(i);
                      setSelectedId(null);
                    }}
                  >
                    第 {i + 1} 页
                  </button>,
                );
              }
              return items;
            })()}
          </div>
        </div>
        <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={deleteSlide} className="mt-1">
          删除本页
        </Button>
      </div>

      {/* 右：工具栏 + 画布 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-2">
          <Button variant="secondary" size="sm" icon={<FolderOpen size={13} />} onClick={onOpenFile}>
            打开
          </Button>
          <Button variant="primary" size="sm" icon={<Download size={13} />} onClick={onSave}>
            保存
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" icon={<Type size={13} />} onClick={() => addShape('text')}>
            文本框
          </Button>
          <Button variant="ghost" size="sm" icon={<Square size={13} />} onClick={() => addShape('rect')}>
            矩形
          </Button>
          <Button variant="ghost" size="sm" icon={<Circle size={13} />} onClick={() => addShape('ellipse')}>
            椭圆
          </Button>
          <Button variant="ghost" size="sm" icon={<ImageIcon size={13} />} onClick={() => imgInputRef.current?.click()}>
            图片
          </Button>
          <Button variant="ghost" size="sm" icon={<BarChart3 size={13} />} onClick={() => setChartOpen(true)}>
            图表
          </Button>
          <Button variant="ghost" size="sm" icon={<Table2 size={13} />} onClick={() => setTableOpen(true)}>
            表格
          </Button>
          {/* 对象超链接：需先选中形状；未选中则 toast 提示（内部用 Modal，无 window.prompt） */}
          <Button
            variant="ghost"
            size="sm"
            icon={<Link size={13} />}
            aria-label="超链接"
            title="超链接"
            onClick={openHyperlink}
          >
            超链接
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="ghost" size="sm" icon={<Copy size={13} />} disabled={!selectedId} onClick={duplicateSelected}>
            复制
          </Button>
          <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} disabled={!selectedId} onClick={deleteSelected}>
            删除
          </Button>
          {/* 表格操作：选中表格后出现，锚点为当前选中单元格所在行/列 */}
          {selectedTable && (
            <>
              <span className="mx-1 h-5 w-px bg-border" />
              <span className="text-tiny text-muted">表格</span>
              <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={addTableRow} title="在当前行后插入一行">
                加行
              </Button>
              <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={addTableCol} title="在当前列后插入一列">
                加列
              </Button>
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={deleteTableRow} title="删除当前行">
                删行
              </Button>
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={deleteTableCol} title="删除当前列">
                删列
              </Button>
            </>
          )}
          <span className="mx-1 h-5 w-px bg-border" />
          <Sparkles size={14} className="shrink-0 text-accent" aria-hidden="true" />
          <Input
            className="w-64"
            placeholder="AI：如「生成一份产品发布会 PPT」"
            disabled={aiBusy}
            value={aiInstruction}
            onChange={(e) => {
              aiInstructionRef.current = e.target.value;
              setAiInstruction(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && aiInstructionRef.current.trim()) {
                e.preventDefault();
                void runPresentationAi(aiInstructionRef.current.trim());
                aiInstructionRef.current = '';
                setAiInstruction('');
              }
            }}
          />
          {aiNote && (
            <span className="max-w-64 truncate text-tiny text-muted" title={aiNote}>
              {aiNote}
            </span>
          )}
          {aiCanUndo && (
            <button
              type="button"
              title="恢复到本次 AI 生成前的幻灯片状态"
              className="rounded border border-border px-1.5 py-0.5 text-tiny text-muted transition-colors hover:border-accent hover:text-accent"
              onClick={() => {
                const snap = aiUndoRef.current;
                if (!snap) return;
                setPres(snap);
                setSlideIdx(0);
                aiUndoRef.current = null;
                setAiCanUndo(false);
                setAiNote('已撤销本次 AI 生成');
                toast.success('已撤销本次 AI 生成');
              }}
            >
              ↩ 撤销
            </button>
          )}
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="secondary" size="sm" icon={<Play size={13} />} onClick={() => setPlaying(true)} title="F5">
            放映
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Timer size={13} />}
            onClick={() => setRehearsing(true)}
            title="排练计时：以放映方式预演并记录每页用时"
          >
            排练计时
          </Button>
          {hasRehearsalTimings(pres) && (
            <Button
              variant="ghost"
              size="sm"
              icon={<TimerOff size={13} />}
              onClick={() => {
                setPres((prev) => clearRehearsalTimings(prev));
                toast.success('已清除排练计时');
              }}
              title="清除全部页的自动换片时间"
            >
              清除计时
            </Button>
          )}
          <select
            className="h-7 rounded border border-border bg-surface px-1 text-xs text-text outline-none"
            value={slide?.transition ?? 'none'}
            title="切换效果"
            onChange={(e) => {
              const v = e.target.value as 'none' | 'fade' | 'slide';
              setPres((prev) => {
                const slides = [...prev.slides];
                slides[slideIdx] = { ...slides[slideIdx], transition: v };
                return { ...prev, slides };
              });
            }}
          >
            <option value="none">无切换</option>
            <option value="fade">淡入</option>
            <option value="slide">滑动</option>
          </select>
          {/* 版式（母版/版式）：只读展示当前页版式名；有版式清单时可轻量切换（仅改 JkSlide.layout，不动形状） */}
          {(() => {
            const layoutList = pres.layouts ?? [];
            const curPart = slide?.layout ?? '';
            const curName = layoutList.find((l) => l.partName === curPart)?.name ?? curPart;
            if (!layoutList.length) {
              return (
                <span className="text-tiny text-muted" title={curPart || '未关联版式'}>
                  版式：{curName || '默认'}
                </span>
              );
            }
            return (
              <label
                className="flex items-center gap-1 text-tiny text-muted"
                title="切换当前页版式（仅记录，不改变形状）"
              >
                版式
                <select
                  className="h-7 rounded border border-border bg-surface px-1 text-xs text-text outline-none"
                  value={curPart}
                  onChange={(e) => {
                    const v = e.target.value || undefined;
                    setPres((prev) => {
                      const slides = [...prev.slides];
                      slides[slideIdx] = { ...slides[slideIdx], layout: v };
                      return { ...prev, slides };
                    });
                  }}
                >
                  <option value="">（未指定）</option>
                  {layoutList.map((l) => (
                    <option key={l.partName} value={l.partName}>
                      {l.name ?? l.partName}
                    </option>
                  ))}
                </select>
              </label>
            );
          })()}
          <span className="ml-2 text-xs text-text-secondary">拖拽移动 · 双击改文字 · 单击选中 · F5 放映</span>
        </div>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted-bg/60 p-4">
          <div
            className="rounded bg-white shadow-card"
            style={{ width: STAGE_W, height: STAGE_H }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSelectedId(null);
            }}
          >
            <Stage
              ref={stageRef}
              width={STAGE_W}
              height={STAGE_H}
              onMouseDown={(e) => {
                if (e.target === e.target.getStage()) setSelectedId(null);
              }}
            >
              <Layer>
                {slide?.shapes.map((shape, idx) => renderShape(shape, idx))}
              </Layer>
            </Stage>
          </div>

          {/* 演讲者备注面板（WPS 对齐批3续）：可折叠，放映时不显示，仅编辑态可见 */}
          <div className="flex shrink-0 flex-col border-t border-border bg-surface">
            <button
              type="button"
              className="flex h-7 items-center justify-between px-3 text-tiny text-muted hover:bg-hover"
              onClick={() => setNotesOpen((v) => !v)}
              title={notesOpen ? '折叠备注面板' : '展开备注面板'}
            >
              <span className="font-medium text-fg">演讲者备注</span>
              <span aria-hidden="true">{notesOpen ? '▾' : '▸'}</span>
            </button>
            {notesOpen && (
              <textarea
                className="mx-3 mb-2 rounded border border-border bg-surface p-2 text-tiny text-fg outline-none focus-visible:border-accent"
                style={{ height: 120 }}
                value={slide?.notes ?? ''}
                onChange={(e) => updateNotes(e.target.value)}
                placeholder="在此输入演讲者备注（放映时不显示）"
              />
            )}
          </div>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept=".pptx" className="hidden" onChange={onFileChange} />
      <input
        ref={imgInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void addImage(f);
        }}
      />

      {(playing || rehearsing) && (
        <SlideshowOverlay
          pres={pres}
          // 排练计时从第 1 页开始（保证每页都被访问并录入，避免删除前面各页既有 advTm）；
          // 普通放映仍从当前页开始，行为不变。
          startIndex={rehearsing ? 0 : slideIdx}
          onClose={() => {
            setPlaying(false);
            setRehearsing(false);
          }}
          rehearse={rehearsing}
          onRehearsalFinish={(rec) => {
            // 排练结束：结束放映层并弹出确认对话框（是否保留本次排练时间）
            setRehearsing(false);
            setRehearsalResult(rec);
            setRehearseConfirmOpen(true);
          }}
        />
      )}

      {/* 排练计时结果确认：保留 → 写回自动换片时间；不保留 → 丢弃（严禁原生弹窗） */}
      <Modal
        open={rehearseConfirmOpen}
        onClose={() => setRehearseConfirmOpen(false)}
        title="排练计时"
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setRehearsalResult(null);
                setRehearseConfirmOpen(false);
              }}
            >
              不保留
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const rec = rehearsalResult;
                if (rec) {
                  setPres((prev) => applyRehearsalTimings(prev, rec));
                  toast.success('已保留排练计时（自动换片时间）');
                }
                setRehearseConfirmOpen(false);
              }}
            >
              保留
            </Button>
          </>
        }
      >
        {rehearsalResult ? (
          (() => {
            const sum = rehearsalSummary(rehearsalResult);
            return (
              <div className="flex flex-col gap-3">
                <p className="text-ui text-fg">是否保留本次排练时间？</p>
                <p className="text-tiny text-muted">
                  总用时 {sum.totalText} · 平均每页 {sum.averageText} · 共 {sum.slideTexts.length} 页
                </p>
                <div className="max-h-48 overflow-auto rounded border border-border">
                  {sum.slideTexts.map((t, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between px-2 py-1 text-tiny even:bg-hover"
                    >
                      <span className="text-muted">第 {i + 1} 页</span>
                      {/* NaN = 本次排练未访问（结算产物），文本为 0:00 不足以区分，故显式标注「未排练」 */}
                      <span className="text-fg">
                        {Number.isNaN(rehearsalResult.slideMs[i]) ? '未排练' : t}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-tiny text-muted">
                  低于 {(MIN_ADVANCE_MS / 1000).toFixed(1)} 秒的页面视为「点击换片」，不写入自动换片时间。
                </p>
              </div>
            );
          })()
        ) : null}
      </Modal>

      <Modal
        open={chartOpen}
        onClose={() => setChartOpen(false)}
        title="插入图表"
        footer={<Button variant="primary" size="sm" onClick={addChart}>插入</Button>}
      >
        <div className="flex flex-col gap-3 p-1">
          <div className="flex items-center gap-2">
            <span className="w-10 text-tiny text-muted">类型</span>
            <div className="flex gap-1">
              {(['bar', 'line', 'pie'] as ChartType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setChartType(t)}
                  className={`rounded border px-2 py-1 text-tiny ${chartType === t ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:bg-hover'}`}
                >
                  {t === 'bar' ? '柱状' : t === 'line' ? '折线' : '饼图'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-10 text-tiny text-muted">标题</span>
            <Input className="flex-1" value={chartTitle} onChange={(e) => setChartTitle(e.target.value)} placeholder="图表标题" />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-10 text-tiny text-muted">类别</span>
            <Input className="flex-1" value={chartLabels} onChange={(e) => setChartLabels(e.target.value)} placeholder="Q1,Q2,Q3（逗号分隔）" />
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-1 w-10 text-tiny text-muted">数据</span>
            <textarea
              className="flex-1 rounded border border-border bg-surface p-2 text-body text-fg outline-none"
              rows={4}
              value={chartSeries}
              onChange={(e) => setChartSeries(e.target.value)}
              placeholder={'每行一个系列：名称|值1,值2,…\n例：营收|120,158,203,241'}
            />
          </div>
          <p className="text-tiny leading-relaxed text-muted">
            图表以图片形式插入当前页，可拖动调整位置与大小，并随 .pptx 一并保存。
          </p>
        </div>
      </Modal>

      {/* 插入表格弹窗（Modal 选择行列数，替代 window.prompt，避免阻断 Electron CDP 自动化） */}
      <Modal
        open={tableOpen}
        onClose={() => setTableOpen(false)}
        title="插入表格"
        footer={<Button variant="primary" size="sm" onClick={addTable}>插入</Button>}
      >
        <div className="flex flex-col gap-3 p-1">
          <div className="flex items-center gap-3">
            <span className="w-14 text-tiny text-muted">行数</span>
            <Input
              className="w-20"
              type="number"
              min={TABLE_MIN}
              max={TABLE_MAX}
              value={String(tableRows)}
              onChange={(e) => setTableRows(Number(e.target.value))}
            />
            <span className="w-14 text-tiny text-muted">列数</span>
            <Input
              className="w-20"
              type="number"
              min={TABLE_MIN}
              max={TABLE_MAX}
              value={String(tableCols)}
              onChange={(e) => setTableCols(Number(e.target.value))}
            />
          </div>
          <p className="text-tiny leading-relaxed text-muted">
            行/列范围 {TABLE_MIN}–{TABLE_MAX}（默认 3×3）。插入后双击单元格编辑文本，
            选中表格后可在工具栏增删行列，并随 .pptx 一并保存。
          </p>
        </div>
      </Modal>

      {/* 单元格文本编辑弹窗（双击单元格触发） */}
      <Modal
        open={cellEditOpen}
        onClose={() => setCellEditOpen(false)}
        title={`编辑单元格（第 ${cellEditRow + 1} 行 · 第 ${cellEditCol + 1} 列）`}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCellEditOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={applyEditCell}>
              应用
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 p-1">
          <textarea
            className="w-full rounded border border-border bg-surface p-2 text-body text-fg outline-none focus-visible:border-accent"
            rows={4}
            value={cellEditText}
            onChange={(e) => setCellEditText(e.target.value)}
            placeholder="单元格内容（换行分段）"
          />
          <p className="text-tiny leading-relaxed text-muted">多行文本以换行分段。</p>
        </div>
      </Modal>

      {/* 文字编辑弹窗（替代旧的 window.prompt，避免阻断 Electron CDP 自动化） */}
      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="编辑文字"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={applyEditText}>
              应用
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 p-1">
          <textarea
            className="w-full rounded border border-border bg-surface p-2 text-body text-fg outline-none focus-visible:border-accent"
            rows={6}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            placeholder="换行分段"
          />
          <p className="text-tiny leading-relaxed text-muted">多行文本以换行分段。</p>
        </div>
      </Modal>

      {/* 对象超链接弹窗（替代 window.prompt，避免阻断 Electron CDP 自动化） */}
      <Modal
        open={linkOpen}
        onClose={() => {
          setLinkOpen(false);
          setLinkId(null);
        }}
        title="超链接"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={removeHyperlink}>
              移除链接
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setLinkOpen(false);
                setLinkId(null);
              }}
            >
              取消
            </Button>
            <Button variant="primary" size="sm" onClick={applyHyperlink}>
              应用
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 p-1">
          <span className="text-tiny text-muted">链接地址（外部 URL）</span>
          <Input
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            placeholder="https://…"
            aria-label="超链接地址"
          />
          <p className="text-tiny leading-relaxed text-muted">
            为选中形状设置外部超链接，放映时点击该形状即可跳转；「移除链接」可清空。
          </p>
        </div>
      </Modal>

      {fileLoading && <LoadingOverlay text="正在加载演示文稿…" />}
    </div>
  );
}
