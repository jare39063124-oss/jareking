import {
  AArrowDown,
  AlignCenter,
  AlignLeft,
  AlignRight,
  BarChart3,
  Bold,
  BookOpen,
  Bookmark,
  ChevronDown,
  ClipboardPaste,
  Columns2,
  Copy,
  Droplet,
  FileDown,
  FilePlus2,
  FolderOpen,
  Footprints,
  Grid2x2,
  Image as ImageIcon,
  Italic,
  Layout,
  Link2,
  List,
  ListOrdered,
  Lock,
  Maximize,
  MessageSquare,
  PaintBucket,
  Printer,
  Replace,
  Save,
  Scissors,
  Shapes,
  ShieldCheck,
  SquarePen,
  Table2,
  TextCursorInput,
  Type,
  Underline,
  ZoomIn,
  ZoomOut,
  FileCog,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Tabs } from './Tabs';
import { toastNotImplemented } from '../stores/toastStore';
import { useUiStore } from '../stores/uiStore';
import { useUiStore, type RibbonTabId } from '../stores/uiStore';

/** Ribbon 占位工具按钮 */
interface RibbonTool {
  id: string;
  label: string;
  icon: LucideIcon;
}

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

/** 菜单标签与占位工具定义（布局对标 WPS：文件/开始/插入/页面布局/引用/视图/审阅） */
const RIBBON_TABS: RibbonTabDef[] = [
  {
    id: 'file',
    label: '文件',
    groups: [
      {
        name: '文档',
        tools: [
          { id: 'new', label: '新建', icon: FilePlus2 },
          { id: 'open', label: '打开', icon: FolderOpen },
          { id: 'save', label: '保存', icon: Save },
        ],
      },
      {
        name: '导出',
        tools: [
          { id: 'export-pdf', label: '导出 PDF', icon: FileDown },
          { id: 'print', label: '打印', icon: Printer },
        ],
      },
      {
        name: 'PDF 工具',
        tools: [{ id: 'pdf-toolbox', label: 'PDF 工具箱', icon: FileCog }],
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
          { id: 'paste', label: '粘贴', icon: ClipboardPaste },
          { id: 'cut', label: '剪切', icon: Scissors },
          { id: 'copy', label: '复制', icon: Copy },
        ],
      },
      {
        name: '字体',
        tools: [
          { id: 'font', label: '字体', icon: Type },
          { id: 'font-size', label: '字号', icon: AArrowDown },
          { id: 'bold', label: '加粗', icon: Bold },
          { id: 'italic', label: '斜体', icon: Italic },
          { id: 'underline', label: '下划线', icon: Underline },
        ],
      },
      {
        name: '段落',
        tools: [
          { id: 'align-left', label: '左对齐', icon: AlignLeft },
          { id: 'align-center', label: '居中', icon: AlignCenter },
          { id: 'align-right', label: '右对齐', icon: AlignRight },
          { id: 'bullet', label: '项目符号', icon: List },
          { id: 'numbering', label: '编号', icon: ListOrdered },
        ],
      },
      {
        name: '编辑',
        tools: [{ id: 'replace', label: '查找替换', icon: Replace }],
      },
    ],
  },
  {
    id: 'insert',
    label: '插入',
    groups: [
      {
        name: '插图',
        tools: [
          { id: 'picture', label: '图片', icon: ImageIcon },
          { id: 'shape', label: '形状', icon: Shapes },
          { id: 'chart', label: '图表', icon: BarChart3 },
        ],
      },
      {
        name: '表格',
        tools: [{ id: 'table', label: '表格', icon: Table2 }],
      },
      {
        name: '链接',
        tools: [{ id: 'link', label: '超链接', icon: Link2 }],
      },
      {
        name: '文本',
        tools: [{ id: 'textbox', label: '文本框', icon: TextCursorInput }],
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
          { id: 'margin', label: '页边距', icon: Layout },
          { id: 'orientation', label: '纸张方向', icon: Columns2 },
        ],
      },
      {
        name: '页面背景',
        tools: [
          { id: 'page-color', label: '页面颜色', icon: PaintBucket },
          { id: 'watermark', label: '水印', icon: Droplet },
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
          { id: 'toc', label: '目录', icon: BookOpen },
          { id: 'footnote', label: '脚注', icon: Footprints },
          { id: 'bookmark', label: '书签', icon: Bookmark },
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
          { id: 'gridlines', label: '网格线', icon: Grid2x2 },
          { id: 'zoom-in', label: '放大', icon: ZoomIn },
          { id: 'zoom-out', label: '缩小', icon: ZoomOut },
          { id: 'fullscreen', label: '全屏', icon: Maximize },
        ],
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
          { id: 'spell', label: '拼写检查', icon: SquarePen },
          { id: 'comment', label: '批注', icon: MessageSquare },
        ],
      },
      {
        name: '保护',
        tools: [
          { id: 'protect', label: '保护文档', icon: ShieldCheck },
          { id: 'restrict', label: '限制编辑', icon: Lock },
        ],
      },
    ],
  },
];

/** Ribbon 工具栏骨架：菜单标签行（可切换）+ 当前标签下的占位工具组 */
export function Ribbon() {
  const setPdfToolboxOpen = useUiStore((state) => state.setPdfToolboxOpen);
  const activeRibbonTab = useUiStore((state) => state.activeRibbonTab);
  const setActiveRibbonTab = useUiStore((state) => state.setActiveRibbonTab);

  const activeTabDef = RIBBON_TABS.find((tab) => tab.id === activeRibbonTab) ?? RIBBON_TABS[1];

  return (
    <div className="flex shrink-0 flex-col border-b border-border bg-surface">
      {/* 菜单标签行（可切换） */}
      <div className="flex items-center px-1 pt-0.5">
        <Tabs
          items={RIBBON_TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
          value={activeRibbonTab}
          onChange={(id) => setActiveRibbonTab(id as RibbonTabId)}
        />
        {/* 折叠 Ribbon 的占位按钮（对齐 WPS 右侧 ^ 按钮） */}
        <button
          type="button"
          title="折叠功能区"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-sm text-muted transition-colors hover:bg-hover hover:text-fg"
          onClick={() => toastNotImplemented('折叠功能区')}
        >
          <ChevronDown size={15} />
        </button>
      </div>

      {/* 工具组行 */}
      <div className="flex h-[86px] items-stretch gap-0.5 overflow-x-auto px-2 pb-1.5">
        {activeTabDef.groups.map((group, groupIndex) => (
          <div key={group.name} className="flex items-stretch">
            {/* 组间分隔线 */}
            {groupIndex > 0 ? <div className="mx-1 w-px shrink-0 bg-border" aria-hidden="true" /> : null}
            <div className="flex flex-col items-center rounded-sm px-1.5 py-1 transition-colors hover:bg-muted-bg">
              {/* 工具按钮 */}
              <div className="flex flex-1 items-start gap-0.5">
                {group.tools.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    title={tool.label}
                    className="flex w-[52px] flex-col items-center gap-1 rounded-sm p-1.5 text-tiny text-fg transition-colors hover:bg-active"
                    onClick={() => {
                      if (tool.id === 'pdf-toolbox') setPdfToolboxOpen(true);
                      else toastNotImplemented(tool.label);
                    }}
                  >
                    <tool.icon size={18} aria-hidden="true" />
                    <span className="w-full text-center leading-tight">{tool.label}</span>
                  </button>
                ))}
              </div>
              {/* 组名（底部） */}
              <span className="select-none pt-1 text-tiny text-muted">{group.name}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
