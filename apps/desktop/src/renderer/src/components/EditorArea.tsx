import { BookOpen, Cloud, FolderOpen, Plus } from 'lucide-react';
import { Button } from './Button';
import { Tree } from './Tree';
import type { TreeNode } from './Tree';
import { MODULE_META, selectActiveTab, useTabStore, type DocModule } from '../stores/tabStore';
import { toast } from '../stores/toastStore';
import { SheetEditor } from '../sheet/SheetEditor';
import { SlideEditor } from '../slide/SlideEditor';
import { WriterEditor } from '../writer/WriterEditor';

/** 云文件占位数据（右侧树） */
const CLOUD_FILES: TreeNode[] = [
  {
    id: 'my-docs',
    label: '我的文档',
    defaultExpanded: true,
    children: [
      { id: 'd1', label: '工作报告.docx' },
      { id: 'd2', label: '会议纪要.docx' },
    ],
  },
  {
    id: 'work',
    label: '工作',
    children: [
      { id: 'w1', label: '预算表.xlsx' },
      { id: 'w2', label: '项目计划.pptx' },
    ],
  },
  {
    id: 'download',
    label: '下载',
    children: [{ id: 'dl1', label: '说明书.pdf' }],
  },
];

/** 文档编辑区：无标签时显示空状态引导，否则按当前 tab 的模块显示占位画面 */
export function EditorArea() {
  const activeTab = useTabStore(selectActiveTab);

  if (!activeTab) return <EmptyState />;
  return <ModulePlaceholder module={activeTab.module} />;
}

/** 空状态：新建文档引导 + 云文件（占位） */
function EmptyState() {
  const openTab = useTabStore((state) => state.openTab);
  const modules = Object.keys(MODULE_META) as DocModule[];

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左：新建文档引导 */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="text-display font-semibold text-fg">新建文档</span>
          <p className="text-body text-muted">选择模块开始创作，或按 Ctrl+Shift+P 打开命令面板</p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          {modules.map((module) => {
            const meta = MODULE_META[module];
            const ModuleIcon = meta.icon;
            return (
              <button
                key={module}
                type="button"
                className="flex w-28 flex-col items-center gap-2 rounded-lg border border-border bg-surface p-4 transition-shadow hover:shadow-card"
                onClick={() => openTab(module)}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">
                  <ModuleIcon size={22} aria-hidden="true" />
                </span>
                <span className="text-ui text-fg">{meta.defaultTitle}</span>
                <span className="text-tiny text-muted">{meta.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右：云文件（占位） */}
      <div className="w-64 shrink-0 overflow-auto border-l border-border bg-surface p-3">
        <div className="mb-2 flex items-center gap-1.5 px-1 text-ui font-medium text-fg">
          <Cloud size={14} className="text-muted" aria-hidden="true" />
          云文件（占位）
        </div>
        <Tree
          nodes={CLOUD_FILES}
          onSelect={(node) => toast.info(`打开「${node.label}」功能建设中`)}
        />
      </div>
    </div>
  );
}

/** 模块占位画面：文档头（打开文件等）+ 画布 */
function ModulePlaceholder({ module }: { module: DocModule }) {
  const meta = MODULE_META[module];
  const openTab = useTabStore((state) => state.openTab);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 文档头 */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-2 text-ui font-medium text-fg">
          <meta.icon size={15} className="text-accent" aria-hidden="true" />
          {meta.label}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<FolderOpen size={13} />}
            onClick={() => toast.info('打开文件功能建设中')}
          >
            打开文件
          </Button>
          <Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={() => openTab(module)}>
            新建{meta.shortLabel}
          </Button>
        </div>
      </div>

      {/* 画布区：Sheet/Slide 用无内边距全幅容器（引擎需要真实尺寸）；其余模块居中展示 */}
      {module === 'sheet' ? (
        <div className="flex min-h-0 flex-1 overflow-hidden bg-muted-bg/40">
          <SheetEditor />
        </div>
      ) : module === 'slide' ? (
        <div className="flex min-h-0 flex-1 overflow-hidden bg-muted-bg/40">
          <SlideEditor />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted-bg/40 p-8">
          {renderCanvas(module)}
        </div>
      )}
    </div>
  );
}

/** 按模块渲染占位画布 */
function renderCanvas(module: DocModule) {
  switch (module) {
    case 'writer':
      return <WriterEditor />;
    case 'pdf':
      return <PdfCanvas />;
    case 'sheet':
    case 'slide':
      return null; // Sheet/Slide 走上方全幅分支
  }
}

/** PDF 占位画布：单页 */
function PdfCanvas() {
  return (
    <div className="flex h-[680px] w-[480px] flex-col items-center justify-center gap-2 rounded-sm bg-surface shadow-card">
      <BookOpen size={28} className="text-muted" aria-hidden="true" />
      <span className="text-ui text-muted">PDF 阅读区（占位）</span>
    </div>
  );
}
