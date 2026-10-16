/**
 * RecoveryCenter —— 「文档备份中心」（崩溃恢复显性入口）。
 *
 * 列出待恢复的文件字节备份（模块图标 + 标题 + 保存时间 + 大小），支持：
 *  - 恢复：物化为临时真实文件 → 走既有 pendingOpen + openTab 直达打开；
 *  - 忽略单条 / 全部忽略：删除快照文件与库记录。
 *
 * 实现约束：使用项目 `Modal` 组件（portal 到 #root 内），零 `window.prompt/alert/confirm`；
 * 启动时执行一次 `checkOnStartup`（列表为空绝不自动弹窗）。
 */
import { useEffect } from 'react';
import { History, RotateCcw, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { MODULE_META } from '../stores/tabStore';
import { useRecoveryStore, type RecoveryItem } from '../stores/recoveryStore';

/** 相对时间（如「刚刚 / 3 分钟前 / 2 小时前 / 3 天前」） */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (!Number.isFinite(diff)) return '';
  const sec = Math.max(0, Math.round(diff / 1000));
  if (sec < 60) return '刚刚';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.round(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString();
}

/** 字节数 → 人类可读（B / KB / MB） */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 单个备份条目 */
function RecoveryRow({ item }: { item: RecoveryItem }) {
  const restore = useRecoveryStore((s) => s.restore);
  const discard = useRecoveryStore((s) => s.discard);
  const meta = MODULE_META[item.module] ?? MODULE_META.writer;
  const ModuleIcon = meta.icon;

  return (
    <div className="flex items-center gap-3 rounded border border-border bg-surface px-3 py-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent/10 text-accent">
        <ModuleIcon size={16} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-fg" title={item.title}>
            {item.title || meta.defaultTitle}
          </span>
          <span className="shrink-0 rounded bg-muted-bg px-1 text-tiny text-muted">{meta.shortLabel}</span>
        </div>
        <div className="text-tiny text-muted">
          {relativeTime(item.savedAt)} · {formatSize(item.sizeBytes)}
        </div>
      </div>
      <Button
        variant="primary"
        size="sm"
        icon={<RotateCcw size={13} />}
        onClick={() => void restore(item.documentId)}
      >
        恢复
      </Button>
      <Button
        variant="ghost"
        size="sm"
        icon={<Trash2 size={13} />}
        onClick={() => void discard(item.documentId)}
      >
        忽略
      </Button>
    </div>
  );
}

export function RecoveryCenter() {
  const open = useRecoveryStore((s) => s.open);
  const items = useRecoveryStore((s) => s.items);
  const loading = useRecoveryStore((s) => s.loading);
  const closeCenter = useRecoveryStore((s) => s.closeCenter);
  const discardAll = useRecoveryStore((s) => s.discardAll);
  const checkOnStartup = useRecoveryStore((s) => s.checkOnStartup);

  // 启动检查（仅一次；列表非空时才自动弹出）
  useEffect(() => {
    void checkOnStartup();
  }, [checkOnStartup]);

  // 全局探针（仅 jk-debug）：供自动化冒烟断言（只读 + 打开入口，不含破坏性能力）
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('jk-debug')) return;
    (window as unknown as Record<string, unknown>).__jkRecovery = {
      list: async () => {
        await useRecoveryStore.getState().load();
        return useRecoveryStore.getState().items;
      },
      openCenter: () => useRecoveryStore.getState().openCenter(),
      count: () => useRecoveryStore.getState().items.length,
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__jkRecovery;
    };
  }, []);

  return (
    <Modal
      open={open}
      onClose={closeCenter}
      title="文档备份中心"
      width={560}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 size={13} />}
            disabled={items.length === 0}
            onClick={() => void discardAll()}
          >
            全部忽略
          </Button>
          <Button variant="secondary" size="sm" onClick={closeCenter}>
            关闭
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-tiny text-muted">
          上次会话中未正常保存的文档备份如下，点击「恢复」可还原为文档（恢复后自动打开）。
        </p>
        {loading && items.length === 0 ? (
          <p className="text-tiny text-muted">加载中…</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-muted">
            <History size={28} aria-hidden="true" />
            <p className="text-tiny">暂无待恢复的文档备份</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <RecoveryRow key={item.documentId} item={item} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
