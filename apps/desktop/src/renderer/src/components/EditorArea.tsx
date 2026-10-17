import { Cloud, FolderOpen, History, Pin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tree } from './Tree';
import type { TreeNode } from './Tree';
import { MODULE_META, selectActiveTab, useTabStore, type DocModule } from '../stores/tabStore';
import { useRecoveryStore } from '../stores/recoveryStore';
import { toast } from '../stores/toastStore';
import { setPendingOpen } from '../stores/pendingOpenStore';
import { PdfReader } from '../pdf/PdfReader';
import { accelLabel } from '../lib/platform';
import { SheetEditor } from '../sheet/SheetEditor';
import { SlideEditor } from '../slide/SlideEditor';
import { WriterEditor } from '../writer/WriterEditor';

interface RecentFileRow {
  document: {
    id: string;
    module: string;
    title: string;
    filePath: string | null;
    format: string | null;
  };
  lastOpenedAt: number | string | null;
  pinned: number;
}

/**
 * 断言：模块可直接打开本地文件。
 * 说明：DocModule 取值为 writer/sheet/slide/pdf；四种编辑器均支持「最近使用」
 * 直达打开（消费 PendingOpen）：writer/sheet/slide 各自解析文档，PDF 阅读器
 * 直接渲染页面（PdfReader 挂载时消费 pendingOpen 读取字节）。
 * 注：PendingOpen.module 已统一为 DocModule（'slide'），不再使用 'presentation'。
 */
function isOpenableModule(module: DocModule): module is 'writer' | 'sheet' | 'slide' | 'pdf' {
  return module === 'writer' || module === 'sheet' || module === 'slide' || module === 'pdf';
}

/** 最近使用（WPS 首页体验）：点击直达打开，悬停可定位到系统文件管理器 */
function RecentDocs() {
  const openTab = useTabStore((state) => state.openTab);
  const [items, setItems] = useState<RecentFileRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await window.jareking.invoke<RecentFileRow[]>('doc:recent:list');
        if (!cancelled) {
          setItems((list ?? []).filter((r) => !!r.document?.filePath).slice(0, 8));
        }
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const open = (row: RecentFileRow) => {
    const module = row.document.module as DocModule;
    if (!isOpenableModule(module) || !row.document.filePath) {
      toast.warning('该文件暂不支持直接打开，请用「打开」按钮手动选择');
      return;
    }
    setPendingOpen({
      module,
      path: row.document.filePath,
      name: row.document.title,
    });
    openTab(module, row.document.title);
  };

  const reveal = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    void window.jareking.invoke('doc:reveal', { path });
  };

  return (
    <div className="w-[340px] shrink-0 border-l border-border p-4">
      <div className="mb-2 flex items-center gap-1.5 text-ui font-medium text-fg">
        <History size={14} className="text-muted" aria-hidden="true" />
        最近使用
      </div>
      {loading ? (
        <p className="text-tiny text-muted">加载中…</p>
      ) : items.length === 0 ? (
        <p className="text-tiny leading-relaxed text-muted">
          暂无最近文档。打开本地文件后会自动出现在这里（内置示例除外）。
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((r) => (
            <li key={r.document.id}>
              <button
                type="button"
                title={`${r.document.filePath}\n打开后可「在文件夹中显示」`}
                className="group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-hover"
                onClick={() => open(r)}
              >
                <FolderOpen size={13} className="shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-fg">{r.document.title}</span>
                  <span className="block truncate text-tiny text-muted">{r.document.format ?? ''}</span>
                </span>
                <Pin
                  size={12}
                  className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
                  aria-hidden="true"
                  onClick={(e) => reveal(e, r.document.filePath!)}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
  const recoveryItems = useRecoveryStore((state) => state.items);
  const openRecoveryCenter = useRecoveryStore((state) => state.openCenter);
  const modules = Object.keys(MODULE_META) as DocModule[];

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左：新建文档引导 */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
        {/* 崩溃恢复提示条：仅在检测到未保存备份时出现，否则不渲染任何多余元素 */}
        {recoveryItems.length > 0 ? (
          <button
            type="button"
            onClick={() => openRecoveryCenter()}
            className="flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-ui text-accent transition-colors hover:bg-accent/20"
          >
            <History size={16} aria-hidden="true" />
            检测到 {recoveryItems.length} 份未保存的文档备份 · 点击恢复
          </button>
        ) : null}
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="text-display font-semibold text-fg">新建文档</span>
          <p className="text-body text-muted">选择模块开始创作，或按 {accelLabel('P', true)} 打开命令面板</p>
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

      {/* 右：最近使用（本地文档库）+ 云文件（占位） */}
      <div className="flex shrink-0">
        <RecentDocs />
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
    </div>
  );
}

/**
 * 模块画布：直接占满编辑区（文档头已移除——入口由 TabBar 新建下拉、首页空状态、
 * Ctrl+Shift+P 命令面板覆盖，垂直空间全部还给文档）。
 * Sheet/Slide 用无内边距全幅容器（引擎需要真实尺寸）；其余模块居中展示。
 */
function ModulePlaceholder({ module }: { module: DocModule }) {
  if (module === 'sheet') {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden bg-muted-bg/40">
        <SheetEditor />
      </div>
    );
  }
  if (module === 'slide') {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden bg-muted-bg/40">
        <SlideEditor />
      </div>
    );
  }
  if (module === 'pdf') {
    // PDF 阅读器自管滚动/尺寸，用无内边距全幅容器
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <PdfReader />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted-bg/40 p-8">
      {renderCanvas(module)}
    </div>
  );
}

/** 按模块渲染占位画布（pdf 已在上方走全幅分支） */
function renderCanvas(module: Exclude<DocModule, 'pdf'>) {
  switch (module) {
    case 'writer':
      return <WriterEditor />;
    case 'sheet':
    case 'slide':
      return null; // Sheet/Slide 走上方全幅分支
  }
}
