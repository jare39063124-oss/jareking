/**
 * recoveryStore —— 崩溃恢复「文档备份中心」的状态与动作。
 *
 * 与既有数据流一致：
 *  - 列表来自主进程 `doc:autosave:list`（文件字节备份，按保存时间倒序）；
 *  - 恢复：主进程把快照物化为临时真实文件（`doc:autosave:recover`），
 *    再走既有 `setPendingOpen + openTab` 机制直达打开（不改各编辑器打开路径）；
 *  - 忽略：单条 / 全部（删快照文件 + 库记录）；
 *  - `open`（可见性）由 `openCenter / closeCenter` 维护，并同步 `uiStore.recoveryCenterOpen`；
 *  - 启动检查 `checkOnStartup` 仅执行一次，且**列表为空时绝不自动弹窗**。
 */
import { create } from 'zustand';
import { MODULE_META, useTabStore, type DocModule } from './tabStore';
import { setPendingOpen } from './pendingOpenStore';
import { toast } from './toastStore';
import { useUiStore } from './uiStore';

/** 备份列表项（主进程 doc:autosave:list 返回结构） */
export interface RecoveryItem {
  documentId: string;
  module: DocModule;
  title: string;
  savedAt: number;
  sizeBytes: number;
  pending: boolean;
}

interface RecoveryState {
  items: RecoveryItem[];
  /** 备份中心模态是否打开 */
  open: boolean;
  loading: boolean;
  /** 是否已执行过启动检查（保证只执行一次） */
  checked: boolean;
  /** 重新拉取备份列表 */
  load: () => Promise<void>;
  /** 恢复指定备份（物化 → 待打开 → 新建标签直达打开） */
  restore: (documentId: string) => Promise<void>;
  /** 忽略单条备份 */
  discard: (documentId: string) => Promise<void>;
  /** 忽略全部备份 */
  discardAll: () => Promise<void>;
  /** 打开备份中心（并刷新列表） */
  openCenter: () => void;
  /** 关闭备份中心 */
  closeCenter: () => void;
  /** 启动检查：列表非空时打开备份中心（仅一次） */
  checkOnStartup: () => Promise<void>;
}

/** 模块字符串 → 合法 DocModule（未知值回落 writer），避免图标/打开路径异常 */
function toModule(value: string): DocModule {
  return (Object.keys(MODULE_META) as DocModule[]).includes(value as DocModule)
    ? (value as DocModule)
    : 'writer';
}

/** 读取备份列表（失败回落空数组，绝不抛） */
async function fetchItems(): Promise<RecoveryItem[]> {
  try {
    const api = window.jareking;
    const list = await api.invoke<RecoveryItem[]>(api.IPC.DOC_BACKUP_LIST);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn('[recovery] 读取备份列表失败：', err);
    return [];
  }
}

export const useRecoveryStore = create<RecoveryState>()((set, get) => ({
  items: [],
  open: false,
  loading: false,
  checked: false,

  load: async () => {
    set({ loading: true });
    const items = await fetchItems();
    set({ items, loading: false });
  },

  restore: async (documentId) => {
    const item = get().items.find((i) => i.documentId === documentId);
    try {
      const api = window.jareking;
      const resolved = await api.invoke<{ path: string; name: string; module: string } | null>(
        api.IPC.DOC_BACKUP_RECOVER,
        { documentId },
      );
      if (!resolved) {
        toast.warning('恢复失败：备份文件已丢失');
        await get().load();
        return;
      }
      const module = toModule(resolved.module);
      // 走既有「待打开 + 新建标签」机制：编辑器挂载时消费 pendingOpen 并解析该真实文件
      setPendingOpen({ module, path: resolved.path, name: resolved.name });
      useTabStore.getState().openTab(module, resolved.name);
      toast.success(`已恢复「${item?.title ?? resolved.name}」`);
      get().closeCenter();
      await get().load();
    } catch (err) {
      toast.warning(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
      await get().load();
    }
  },

  discard: async (documentId) => {
    try {
      const api = window.jareking;
      await api.invoke(api.IPC.DOC_BACKUP_DISCARD, { documentId });
      toast.info('已忽略该备份');
    } catch (err) {
      toast.warning(`忽略失败：${err instanceof Error ? err.message : String(err)}`);
    }
    await get().load();
  },

  discardAll: async () => {
    const items = get().items;
    if (!items.length) return;
    try {
      const api = window.jareking;
      await Promise.all(
        items.map((i) => api.invoke(api.IPC.DOC_BACKUP_DISCARD, { documentId: i.documentId })),
      );
      toast.info(`已忽略全部 ${items.length} 份备份`);
    } catch (err) {
      toast.warning(`忽略失败：${err instanceof Error ? err.message : String(err)}`);
    }
    await get().load();
  },

  openCenter: () => {
    useUiStore.getState().setRecoveryCenterOpen(true);
    set({ open: true });
    void get().load();
  },

  closeCenter: () => {
    useUiStore.getState().setRecoveryCenterOpen(false);
    set({ open: false });
  },

  checkOnStartup: async () => {
    if (get().checked) return;
    set({ checked: true });
    await get().load();
    // 列表为空时绝不自动弹窗（避免打扰）
    if (get().items.length > 0) get().openCenter();
  },
}));
