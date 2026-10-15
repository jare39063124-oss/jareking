/**
 * Ribbon —— 功能区（对标 WPS 布局）。
 *
 * 与初版骨架的区别：这里不再是"占位图标"，而是真正驱动编辑器的命令面板：
 *  - 按钮经 `runEditorCommand(id)` 走命令总线（writer/editorCommands.ts），
 *    由当前挂载的编辑器（WriterEditor）执行；未注册说明当前模块无该能力 → 占位提示；
 *  - 控件的取值/激活态经 `getEditorCommandState(id)` 实时读取，并用
 *    `useEditorRevision()` 订阅编辑器的事务通知（加粗高亮、字体下拉值实时刷新）；
 *  - 「PDF 工具」升级为一级标签页（用户诉求：PDF 是卖点，不该藏在「文件」里）。
 */

import {
  AlignCenter,
  AlignLeft,
  AlignJustify,
  AlignRight,
  BarChart3,
  Bold,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Combine,
  Columns2,
  Copy,
  Droplet,
  FileCog,
  FileDown,
  FileImage,
  FileInput,
  FileOutput,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  FileType,
  FolderOpen,
  Footprints,
  Grid2x2,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Layout,
  Link2,
  List,
  ListOrdered,
  ListTree,
  Lock,
  PanelTop,
  Maximize,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  PaintBucket,
  PanelsTopLeft,
  Printer,
  Presentation,
  Redo2,
  Replace,
  RotateCcw,
  RotateCw,
  Save,
  ScanText,
  Scissors,
  Search,
  SeparatorHorizontal,
  Shapes,
  ShieldCheck,
  ShieldOff,
  Sigma,
  Split,
  SquarePen,
  Stamp,
  Strikethrough,
  Table2,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  Code2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Tabs } from './Tabs';
import { toast, toastNotImplemented } from '../stores/toastStore';
import {
  useUiStore,
  type PdfToolboxMode,
  type RibbonTabId,
} from '../stores/uiStore';
import {
  getEditorCommandState,
  hasEditorCommand,
  runEditorCommand,
  useEditorRevision,
  type EditorCommandState,
} from '../stores/editorCommands';
import { FONT_GROUPS, FONT_SIZES } from '../lib/fonts';
// OfficeKind 与主进程共用同一类型（单一事实源 shared/officePdfScript.ts）
import type { OfficeKind } from '../../../shared/officePdfScript';

/**
 * 工具项类型：
 *  - button：普通按钮（图标 + 文字）
 *  - fontFamily / fontSize / color：取值型控件（供「字体」组第一排使用）
 */
type RibbonTool =
  | {
      kind: 'button';
      id: string;
      label: string;
      icon: LucideIcon;
      pdfMode?: PdfToolboxMode;
      /** 「Office 转 PDF」按钮：点选本机文件后用 WPS/Office COM 转为 PDF */
      officeKind?: OfficeKind;
    }
  | { kind: 'fontFamily'; id: 'font-family'; label: '字体' }
  | { kind: 'fontSize'; id: 'font-size'; label: '字号' }
  | { kind: 'color'; id: 'font-color'; label: '字体颜色' };

/** Ribbon 工具组（组名显示在组底部，对标 WPS） */
interface RibbonToolGroup {
  name: string;
  tools: RibbonTool[];
}

interface RibbonTabDef {
  id: RibbonTabId;
  label: string;
  groups: RibbonToolGroup[];
}

/** 合法的 #rrggbb 颜色（字体颜色控件只接受该格式，其余按黑色兜底） */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * 菜单标签与工具定义（布局对标 WPS）。
 * 说明：`pdfMode` 表示该按钮直达 PDF 工具箱的某个模式（已实现能力）；
 * 未标注且命令总线中也未注册的按钮点击后给出「功能建设中」提示。
 */
const RIBBON_TABS: RibbonTabDef[] = [
  {
    id: 'file',
    label: '文件',
    groups: [
      {
        name: '文档',
        tools: [
          { kind: 'button', id: 'new', label: '新建', icon: FilePlus2 },
          { kind: 'button', id: 'open', label: '打开', icon: FolderOpen },
          { kind: 'button', id: 'save', label: '保存', icon: Save },
        ],
      },
      {
        name: '导出',
        tools: [
          { kind: 'button', id: 'export-pdf', label: '导出 PDF', icon: FileDown },
          { kind: 'button', id: 'print', label: '打印', icon: Printer },
        ],
      },
      {
        name: 'PDF 工具',
        tools: [{ kind: 'button', id: 'pdf-toolbox', label: 'PDF 工具箱', icon: FileCog, pdfMode: 'extract' }],
      },
    ],
  },
  {
    id: 'home',
    label: '开始',
    groups: [
      {
        name: '剪贴板',
        tools: [
          { kind: 'button', id: 'paste', label: '粘贴', icon: ClipboardPaste },
          { kind: 'button', id: 'cut', label: '剪切', icon: Scissors },
          { kind: 'button', id: 'copy', label: '复制', icon: Copy },
        ],
      },
      {
        name: '字体',
        tools: [
          { kind: 'fontFamily', id: 'font-family', label: '字体' },
          { kind: 'fontSize', id: 'font-size', label: '字号' },
          { kind: 'color', id: 'font-color', label: '字体颜色' },
          { kind: 'button', id: 'bold', label: '加粗', icon: Bold },
          { kind: 'button', id: 'italic', label: '斜体', icon: Italic },
          { kind: 'button', id: 'underline', label: '下划线', icon: Underline },
          { kind: 'button', id: 'strike', label: '删除线', icon: Strikethrough },
        ],
      },
      {
        name: '段落',
        tools: [
          { kind: 'button', id: 'align-left', label: '左对齐', icon: AlignLeft },
          { kind: 'button', id: 'align-center', label: '居中', icon: AlignCenter },
          { kind: 'button', id: 'align-right', label: '右对齐', icon: AlignRight },
          { kind: 'button', id: 'align-justify', label: '两端对齐', icon: AlignJustify },
          { kind: 'button', id: 'bullet', label: '项目符号', icon: List },
          { kind: 'button', id: 'numbering', label: '编号', icon: ListOrdered },
        ],
      },
      {
        name: '样式',
        tools: [
          { kind: 'button', id: 'h1', label: '标题 1', icon: Heading1 },
          { kind: 'button', id: 'h2', label: '标题 2', icon: Heading2 },
          { kind: 'button', id: 'h3', label: '标题 3', icon: Heading3 },
          { kind: 'button', id: 'body', label: '正文', icon: Type },
          // 样式管理器（WPS 对齐）：打开样式列表 / 新建 / 应用 / 删除（命令总线 id 与编辑器逐字一致）
          { kind: 'button', id: 'style-manager', label: '样式管理器', icon: PaintBucket },
        ],
      },
      {
        name: '编辑',
        tools: [
          { kind: 'button', id: 'undo', label: '撤销', icon: Undo2 },
          { kind: 'button', id: 'redo', label: '重做', icon: Redo2 },
          { kind: 'button', id: 'replace', label: '查找替换', icon: Replace },
        ],
      },
    ],
  },
  {
    id: 'insert',
    label: '插入',
    groups: [
      {
        name: '页面',
        tools: [
          { kind: 'button', id: 'page-break', label: '分页符', icon: SeparatorHorizontal },
          { kind: 'button', id: 'page-number', label: '插入页码', icon: Hash },
          { kind: 'button', id: 'header-footer', label: '页眉页脚', icon: PanelTop },
        ],
      },
      {
        name: '目录与符号',
        tools: [
          { kind: 'button', id: 'toc', label: '插入目录', icon: ListTree },
          { kind: 'button', id: 'formula', label: '插入公式', icon: Sigma },
        ],
      },
      {
        name: '插图',
        tools: [
          { kind: 'button', id: 'image', label: '图片', icon: ImageIcon },
          { kind: 'button', id: 'shape', label: '形状', icon: Shapes },
          { kind: 'button', id: 'chart', label: '图表', icon: BarChart3 },
        ],
      },
      {
        name: '表格',
        tools: [{ kind: 'button', id: 'table', label: '表格', icon: Table2 }],
      },
      {
        name: '链接',
        tools: [{ kind: 'button', id: 'link', label: '超链接', icon: Link2 }],
      },
      {
        name: '文本',
        tools: [{ kind: 'button', id: 'textbox', label: '文本框', icon: TextCursorInput }],
      },
    ],
  },
  {
    id: 'layout',
    label: '页面布局',
    groups: [
      {
        name: '页面设置',
        tools: [
          { kind: 'button', id: 'margin', label: '页边距', icon: Layout },
          { kind: 'button', id: 'orientation', label: '纸张方向', icon: Columns2 },
          { kind: 'button', id: 'columns', label: '分栏', icon: Columns2 },
        ],
      },
      {
        name: '页面背景',
        tools: [
          { kind: 'button', id: 'page-color', label: '页面颜色', icon: PaintBucket },
          { kind: 'button', id: 'watermark', label: '水印', icon: Droplet },
        ],
      },
    ],
  },
  {
    id: 'reference',
    label: '引用',
    groups: [
      {
        name: '目录',
        tools: [
          { kind: 'button', id: 'toc', label: '目录', icon: BookOpen },
          { kind: 'button', id: 'bookmark', label: '书签', icon: Bookmark },
        ],
      },
      {
        name: '脚注与尾注',
        tools: [
          { kind: 'button', id: 'insert-footnote', label: '插入脚注', icon: Footprints },
          { kind: 'button', id: 'insert-endnote', label: '插入尾注', icon: Bookmark },
          { kind: 'button', id: 'notes', label: '脚注/尾注', icon: ListTree },
        ],
      },
    ],
  },
  {
    id: 'view',
    label: '视图',
    groups: [
      {
        name: '显示',
        tools: [
          { kind: 'button', id: 'zoom-out', label: '缩小', icon: ZoomOut },
          { kind: 'button', id: 'zoom-in', label: '放大', icon: ZoomIn },
          { kind: 'button', id: 'zoom-reset', label: '100%', icon: RotateCcw },
          { kind: 'button', id: 'fullscreen', label: '全屏', icon: Maximize },
        ],
      },
      {
        name: '显示辅助',
        tools: [{ kind: 'button', id: 'gridlines', label: '网格线', icon: Grid2x2 }],
      },
      {
        name: '工具',
        tools: [{ kind: 'button', id: 'macro', label: '宏', icon: Code2 }],
      },
    ],
  },
  {
    id: 'review',
    label: '审阅',
    groups: [
      {
        name: '校对',
        tools: [
          { kind: 'button', id: 'spell', label: '拼写检查', icon: SquarePen },
          { kind: 'button', id: 'comment', label: '新建批注', icon: MessageSquarePlus },
        ],
      },
      {
        name: '修订',
        tools: [
          { kind: 'button', id: 'track-changes', label: '修订', icon: Replace },
          { kind: 'button', id: 'accept-revisions', label: '接受所有修订', icon: Check },
          { kind: 'button', id: 'reject-revisions', label: '拒绝所有修订', icon: X },
        ],
      },
      {
        name: '保护',
        tools: [
          { kind: 'button', id: 'protect', label: '保护文档', icon: ShieldCheck },
          { kind: 'button', id: 'restrict', label: '限制编辑', icon: Lock },
        ],
      },
    ],
  },
  {
    id: 'pdf',
    label: 'PDF 工具',
    groups: [
      {
        name: 'PDF 转其他',
        tools: [
          { kind: 'button', id: 'pdf-to-word', label: 'PDF转Word', icon: FileText },
          { kind: 'button', id: 'pdf-to-excel', label: 'PDF转Excel', icon: FileSpreadsheet },
          { kind: 'button', id: 'pdf-to-ppt', label: 'PDF转PPT', icon: Presentation },
          { kind: 'button', id: 'pdf-to-image', label: 'PDF转图片', icon: FileImage, pdfMode: 'toImages' },
          { kind: 'button', id: 'pdf-to-txt', label: 'PDF转TXT', icon: FileType, pdfMode: 'toText' },
        ],
      },
      {
        name: 'Office 转 PDF',
        tools: [
          { kind: 'button', id: 'word-to-pdf', label: 'Word转PDF', icon: FileOutput, officeKind: 'word' },
          {
            kind: 'button',
            id: 'excel-to-pdf',
            label: 'Excel转PDF',
            icon: FileSpreadsheet,
            officeKind: 'excel',
          },
          { kind: 'button', id: 'ppt-to-pdf', label: 'PPT转PDF', icon: Presentation, officeKind: 'ppt' },
          { kind: 'button', id: 'pdf-images', label: '图片转PDF', icon: FileImage, pdfMode: 'images' },
        ],
      },
      {
        name: '页面编辑',
        tools: [
          { kind: 'button', id: 'pdf-merge', label: '合并PDF', icon: Combine, pdfMode: 'merge' },
          { kind: 'button', id: 'pdf-split', label: '拆分PDF', icon: Split, pdfMode: 'extract' },
          { kind: 'button', id: 'pdf-extract', label: '提取页面', icon: Scissors, pdfMode: 'extract' },
          { kind: 'button', id: 'pdf-delete', label: '删除页面', icon: Trash2, pdfMode: 'extract' },
          { kind: 'button', id: 'pdf-rotate', label: '旋转页面', icon: RotateCw, pdfMode: 'rotate' },
          { kind: 'button', id: 'pdf-insert', label: '插入页面', icon: FileInput, pdfMode: 'insert' },
          { kind: 'button', id: 'pdf-replace', label: '替换页面', icon: Replace, pdfMode: 'replace' },
          { kind: 'button', id: 'pdf-toolbox', label: 'PDF 工具箱', icon: FileCog, pdfMode: 'extract' },
        ],
      },
      {
        name: '安全与美化',
        tools: [
          { kind: 'button', id: 'pdf-encrypt', label: '加密PDF', icon: Lock },
          { kind: 'button', id: 'pdf-decrypt', label: '移除密码', icon: ShieldOff },
          { kind: 'button', id: 'pdf-watermark', label: '添加水印', icon: Stamp, pdfMode: 'watermark' },
          { kind: 'button', id: 'pdf-header-footer', label: '页眉页脚', icon: PanelsTopLeft },
          { kind: 'button', id: 'pdf-compress', label: '压缩PDF', icon: Minimize2 },
        ],
      },
      {
        name: '阅读与批注',
        tools: [
          { kind: 'button', id: 'pdf-open', label: '打开PDF', icon: FolderOpen },
          { kind: 'button', id: 'pdf-search', label: '全文搜索', icon: Search },
          { kind: 'button', id: 'pdf-annotate', label: '批注', icon: MessageSquare },
          { kind: 'button', id: 'pdf-ocr', label: 'OCR识别', icon: ScanText },
        ],
      },
    ],
  },
];

/** 字体族下拉：值来自编辑器当前选区，变更经命令总线回写 */
function FontFamilyControl({ state, disabled }: { state: EditorCommandState; disabled: boolean }) {
  return (
    <select
      aria-label="字体"
      title="字体"
      className="h-[24px] w-[108px] shrink-0 rounded border border-border bg-surface px-1 text-tiny text-fg outline-none disabled:opacity-50"
      value={state.value ?? ''}
      disabled={disabled}
      onChange={(e) => runEditorCommand('font-family', e.target.value)}
    >
      <option value="">字体</option>
      {FONT_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label} title={group.note}>
          {group.fonts.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** 字号下拉（磅） */
function FontSizeControl({ state, disabled }: { state: EditorCommandState; disabled: boolean }) {
  return (
    <select
      aria-label="字号"
      title="字号"
      className="h-[24px] w-[54px] shrink-0 rounded border border-border bg-surface px-1 text-tiny text-fg outline-none disabled:opacity-50"
      value={state.value ?? ''}
      disabled={disabled}
      onChange={(e) => runEditorCommand('font-size', e.target.value)}
    >
      <option value="">字号</option>
      {FONT_SIZES.map((size) => (
        <option key={size} value={String(size)}>
          {size}
        </option>
      ))}
    </select>
  );
}

/** 字体颜色取色器：色块显示当前颜色，点击弹出系统取色面板 */
function FontColorControl({ state, disabled }: { state: EditorCommandState; disabled: boolean }) {
  const raw = state.value ?? '';
  const swatch = raw || '#000000';
  const hex = HEX_COLOR_RE.test(raw) ? raw : '#000000';
  return (
    <label
      className="relative flex h-[24px] w-8 shrink-0 cursor-pointer items-center justify-center rounded border border-border disabled:opacity-50"
      title="字体颜色"
    >
      <span
        className="h-3.5 w-3.5 rounded-sm border border-border"
        style={{ backgroundColor: swatch }}
        aria-hidden="true"
      />
      <input
        type="color"
        aria-label="字体颜色"
        className="absolute inset-0 cursor-pointer opacity-0"
        value={hex}
        disabled={disabled}
        onChange={(e) => runEditorCommand('font-color', e.target.value)}
      />
    </label>
  );
}

/** 工具按钮：图标 + 文字（compact 用于「字体」组第二排，压缩高度） */
function ToolButton({
  tool,
  compact,
  state,
  disabled,
  onClick,
}: {
  tool: Extract<RibbonTool, { kind: 'button' }>;
  compact?: boolean;
  state: EditorCommandState;
  disabled: boolean;
  onClick: () => void;
}) {
  const active = state.active === true;
  return (
    <button
      type="button"
      // 冒烟脚本按 aria-label 匹配工具（如「加粗」「插入目录」）
      aria-label={tool.label}
      title={tool.label}
      disabled={disabled}
      className={`flex shrink-0 flex-col items-center rounded-sm text-tiny transition-colors hover:bg-active disabled:cursor-not-allowed disabled:opacity-40 ${
        compact ? 'w-[42px] gap-0 py-0.5' : 'w-[52px] gap-0.5 p-1.5'
      } ${active ? 'bg-accent/15 text-accent' : 'text-fg'}`}
      onClick={onClick}
    >
      <tool.icon size={compact ? 14 : 18} aria-hidden="true" />
      <span className={`w-full text-center ${compact ? 'leading-none' : 'leading-tight'}`}>{tool.label}</span>
    </button>
  );
}

/** 「Office 转 PDF」文件选择器的扩展名过滤（按文档大类） */
const OFFICE_ACCEPT: Record<OfficeKind, string> = {
  word: '.doc,.docx,.docm',
  excel: '.xls,.xlsx,.xlsm,.csv',
  ppt: '.ppt,.pptx,.pptm',
};

/**
 * 选择本机 Office 文件并触发「Office → PDF」转换。
 *
 * 用动态创建的 `<input type="file">` 取文件磁盘路径，**绝不使用 window.prompt /
 * window.alert**（原生弹窗会阻断 Electron CDP 自动化）。拿到路径后经 IPC 交给主进程，
 * 由本机 WPS/Office 的 COM 组件完成转换。
 */
async function pickOfficeFileAndConvert(kind: OfficeKind): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = OFFICE_ACCEPT[kind];
  input.style.display = 'none';

  // 用户选中文件 → change；取消对话框 → cancel（Chromium 原生支持），二者都会收敛 Promise
  const filePicked = new Promise<File | null>((resolve) => {
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
  });

  document.body.appendChild(input);
  input.click();

  try {
    const file = await filePicked;
    if (!file) return; // 用户取消选择
    // 取真实磁盘路径：Electron 32+ 已移除 File.path，改用 preload 暴露的
    // webUtils.getPathForFile；对旧版 Electron 回退到 File.path 以保持兼容。
    const filePath =
      window.jareking.getPathForFile?.(file) ?? (file as File & { path?: string }).path;
    if (!filePath) {
      toast.warning('未能读取文件路径，请在桌面端中选择本地文件');
      return;
    }

    const res = await window.jareking.invoke<{ outputPath: string }>(
      window.jareking.IPC.PDF_OFFICE_TO_PDF,
      { kind, inputPath: filePath },
    );
    toast.success(`已转换为 PDF：${res.outputPath}`);
  } catch (err) {
    toast.warning(`转换失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    input.remove();
  }
}

/** Ribbon 工具栏：菜单标签行（可切换 + 双击折叠）+ 当前标签下的工具组 */
export function Ribbon() {
  const setPdfToolboxOpen = useUiStore((state) => state.setPdfToolboxOpen);
  const setPdfToolboxMode = useUiStore((state) => state.setPdfToolboxMode);
  const activeRibbonTab = useUiStore((state) => state.activeRibbonTab);
  const setActiveRibbonTab = useUiStore((state) => state.setActiveRibbonTab);
  const ribbonCollapsed = useUiStore((state) => state.ribbonCollapsed);
  const setRibbonCollapsed = useUiStore((state) => state.setRibbonCollapsed);
  const toggleRibbonCollapsed = useUiStore((state) => state.toggleRibbonCollapsed);
  const writerZoom = useUiStore((state) => state.writerZoom);
  const setWriterZoom = useUiStore((state) => state.setWriterZoom);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);

  // 订阅命令总线修订号：编辑器事务/选区变化后重读控件取值与激活态
  const revision = useEditorRevision();

  const activeTabDef = RIBBON_TABS.find((tab) => tab.id === activeRibbonTab) ?? RIBBON_TABS[1];

  // Ctrl+F1 切换功能区折叠（与 Office/WPS 一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        toggleRibbonCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleRibbonCollapsed]);

  /** 切换标签：折叠态下点标签即展开（Office/WPS 的"点标签预览"行为） */
  const handleTabChange = (id: string) => {
    setActiveRibbonTab(id as RibbonTabId);
    if (ribbonCollapsed) setRibbonCollapsed(false);
  };

  /** 工具点击：命令总线 → PDF 工具箱 → 缩放 → 占位提示 */
  const handleToolClick = (tool: Extract<RibbonTool, { kind: 'button' }>) => {
    // 缩放（视图标签）：真实生效，作用于 Writer 纸张区
    if (tool.id === 'zoom-in') {
      setWriterZoom(writerZoom + 0.1);
      return;
    }
    if (tool.id === 'zoom-out') {
      setWriterZoom(writerZoom - 0.1);
      return;
    }
    if (tool.id === 'macro') {
      setSettingsOpen(true);
      return;
    }
    if (tool.id === 'zoom-reset') {
      setWriterZoom(1);
      return;
    }
    if (runEditorCommand(tool.id)) return;
    if (tool.pdfMode) {
      setPdfToolboxMode(tool.pdfMode);
      setPdfToolboxOpen(true);
      return;
    }
    // Office 转 PDF（Word/Excel/PPT → PDF）：选择本机文件 → 主进程用 WPS/Office COM 转换
    if (tool.officeKind) {
      void pickOfficeFileAndConvert(tool.officeKind);
      return;
    }
    toastNotImplemented(tool.label);
  };

  return (
    <div className="flex shrink-0 flex-col border-b border-border bg-surface">
      {/* 菜单标签行（可切换；双击标签区折叠/展开，对齐 WPS） */}
      <div
        className="flex items-center px-1 pt-0.5"
        onDoubleClick={toggleRibbonCollapsed}
        title="双击折叠/展开功能区 (Ctrl+F1)"
      >
        <Tabs
          items={RIBBON_TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
          value={activeRibbonTab}
          onChange={handleTabChange}
        />
        {/* 折叠/展开功能区（对齐 WPS 右侧 ^ 按钮） */}
        <button
          type="button"
          title={ribbonCollapsed ? '展开功能区 (Ctrl+F1)' : '折叠功能区 (Ctrl+F1)'}
          aria-pressed={ribbonCollapsed}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-sm text-muted transition-colors hover:bg-hover hover:text-fg"
          onClick={toggleRibbonCollapsed}
        >
          {ribbonCollapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>

      {/* 工具组行（折叠时隐藏，给文档更多显示空间） */}
      {!ribbonCollapsed && (
        <div
          className="flex h-[86px] items-stretch gap-0.5 overflow-x-auto px-2 pb-1.5"
          data-editor-revision={revision}
        >
          {activeTabDef.groups.map((group, groupIndex) => (
            <div key={group.name} className="flex items-stretch">
              {/* 组间分隔线 */}
              {groupIndex > 0 ? <div className="mx-1 w-px shrink-0 bg-border" aria-hidden="true" /> : null}
              <div className="flex flex-col items-center rounded-sm px-1.5 py-1 transition-colors hover:bg-muted-bg">
                {/* 含取值控件的组（如「字体」）分两排：控件排 + 按钮排 */}
                {group.tools.some((tool) => tool.kind !== 'button') ? (
                  <>
                    <div className="flex items-center gap-1">
                      {group.tools
                        .filter((tool) => tool.kind !== 'button')
                        .map((tool) => {
                          const registered = hasEditorCommand(tool.id);
                          const state = getEditorCommandState(tool.id) ?? {};
                          const disabled = !registered || state.disabled === true;
                          if (tool.kind === 'fontFamily') {
                            return <FontFamilyControl key={tool.id} state={state} disabled={disabled} />;
                          }
                          if (tool.kind === 'fontSize') {
                            return <FontSizeControl key={tool.id} state={state} disabled={disabled} />;
                          }
                          return <FontColorControl key={tool.id} state={state} disabled={disabled} />;
                        })}
                    </div>
                    <div className="mt-0.5 flex items-start gap-0.5">
                      {group.tools
                        .filter((tool): tool is Extract<RibbonTool, { kind: 'button' }> => tool.kind === 'button')
                        .map((tool) => {
                          const state = getEditorCommandState(tool.id) ?? {};
                          const registered = hasEditorCommand(tool.id);
                          const disabled = registered && state.disabled === true;
                          return (
                            <ToolButton
                              key={tool.id}
                              tool={tool}
                              compact
                              state={state}
                              disabled={disabled}
                              onClick={() => handleToolClick(tool)}
                            />
                          );
                        })}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-1 items-start gap-0.5">
                    {group.tools
                      .filter((tool): tool is Extract<RibbonTool, { kind: 'button' }> => tool.kind === 'button')
                      .map((tool) => {
                        const state = getEditorCommandState(tool.id) ?? {};
                        const registered = hasEditorCommand(tool.id);
                        const disabled = registered && state.disabled === true;
                        return (
                          <ToolButton
                            key={tool.id}
                            tool={tool}
                            state={state}
                            disabled={disabled}
                            onClick={() => handleToolClick(tool)}
                          />
                        );
                      })}
                  </div>
                )}
                {/* 组名（底部） */}
                <span className="mt-auto select-none pt-1 text-tiny text-muted">{group.name}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
