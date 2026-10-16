/**
 * autosave —— 渲染进程「自动保存 + 崩溃恢复」调度器（纯逻辑，便于单测）。
 *
 * 语义（对标 WPS 的自动备份/文档恢复）：
 *  - 编辑中的文档按「防抖」调度：默认 {@link AUTOSAVE_DEBOUNCE_MS}（15 秒）内无新变更才落盘，
 *    期间重复调用只保留「最后一次」序列化闭包；
 *  - 落盘内容是**文件字节快照**（docx/xlsx/pptx），经 IPC 交给主进程写入本地备份目录；
 *  - 序列化 / 落盘的任何失败都在本模块内被捕获（后台能力不得打扰用户，也不得产生
 *    未捕获 Promise rejection）；
 *  - 三编辑器在「保存成功」后调用 {@link discardAutosave} 清除备份；关闭标签前
 *    调用 {@link flushAutosave} 把未落盘快照补落盘。
 *
 * 本模块不直接依赖 electron：传输层可被测试注入替身（{@link __setAutosaveTransport}）。
 */
import type { DocModule } from '../stores/tabStore';
import { MODULE_META } from '../stores/tabStore';

/** 自动保存防抖间隔（毫秒）：默认 15 秒内无新变更才落盘 */
export const AUTOSAVE_DEBOUNCE_MS = 15_000;

/** 未命名文档自增序号（同进程内唯一，保证多份未命名文档互不覆盖） */
let untitledSeq = 0;

/** 字符串 → 稳定短哈希（FNV-1a，base36），用于「有路径文档」生成稳定 documentId */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * 生成文档标识（备份文件名的主键）。
 *  - 有路径 → 基于模块 + 路径的**稳定** id（同一文件始终映射到同一备份）；
 *  - 无路径 → `<module>-untitled-<自增>`（同进程内唯一）。
 */
export function makeDocumentId(module: DocModule, filePath?: string | null): string {
  const p = filePath?.trim();
  if (p) return `${module}-file-${stableHash(p)}`;
  return `${module}-untitled-${++untitledSeq}`;
}

/**
 * 生成备份展示标题。
 *  - 有路径 → 文件名（含扩展名，如「报告.docx」）；
 *  - 无路径 → 该模块的默认标题（如「文档」）。
 */
export function makeBackupTitle(module: DocModule, filePath?: string | null): string {
  const p = filePath?.trim();
  if (p) {
    const base = p.split(/[\\/]/).pop()?.trim();
    if (base) return base;
  }
  return MODULE_META[module].defaultTitle;
}

/** 落盘 payload（与主进程 doc:autosave:save-backup 通道约定一致） */
export interface AutosaveBackupPayload {
  documentId: string;
  module: DocModule;
  title: string;
  bytes: Uint8Array;
}

/** 自动保存传输层（默认走 IPC；测试可注入替身） */
export interface AutosaveTransport {
  saveBackup: (payload: AutosaveBackupPayload) => Promise<unknown>;
  discardBackup: (documentId: string) => Promise<boolean>;
}

/** 默认传输层：经 preload 暴露的 jareking API 调用主进程通道 */
const defaultTransport: AutosaveTransport = {
  saveBackup: (payload) => {
    const api = window.jareking;
    return api.invoke(api.IPC.DOC_BACKUP_SAVE, payload);
  },
  discardBackup: (documentId) => {
    const api = window.jareking;
    return api.invoke<boolean>(api.IPC.DOC_BACKUP_DISCARD, { documentId });
  },
};

let transport: AutosaveTransport = defaultTransport;

/** 测试用：注入 / 还原（传 null）传输层替身 */
export function __setAutosaveTransport(next: AutosaveTransport | null): void {
  transport = next ?? defaultTransport;
}

/** 调度入参 */
export interface ScheduleAutosaveInput {
  documentId: string;
  module: DocModule;
  title: string;
  /** 序列化回调：返回文件字节（docx/xlsx/pptx），可同步或异步 */
  serialize: () => Uint8Array | Promise<Uint8Array>;
}

/** 待落盘条目（持有防抖计时器与最近一次序列化闭包） */
interface PendingEntry extends ScheduleAutosaveInput {
  timer: ReturnType<typeof setTimeout> | null;
}

/** 待落盘队列（documentId → 最近一次调度） */
const pending = new Map<string, PendingEntry>();

/**
 * 序列化并落盘。失败静默（仅 console.warn）：自动保存属后台能力，
 * 不得冒泡为未捕获异常、不得打扰用户。
 *
 * @returns 已落盘的字节；失败返回 null
 */
async function persist(entry: PendingEntry): Promise<Uint8Array | null> {
  try {
    const raw = await entry.serialize();
    const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw as ArrayLike<number>);
    await transport.saveBackup({
      documentId: entry.documentId,
      module: entry.module,
      title: entry.title,
      bytes,
    });
    return bytes;
  } catch (err) {
    console.warn('[autosave] 备份落盘失败（已忽略）：', err);
    return null;
  }
}

/**
 * 调度自动保存：防抖 {@link AUTOSAVE_DEBOUNCE_MS}；
 * 期间对同一 documentId 重复调用会重置计时器并**只保留最后一次** serialize 闭包。
 */
export function scheduleAutosave(input: ScheduleAutosaveInput): void {
  const existing = pending.get(input.documentId);
  if (existing?.timer) clearTimeout(existing.timer);
  const entry: PendingEntry = { ...input, timer: null };
  entry.timer = setTimeout(() => {
    pending.delete(entry.documentId);
    void persist(entry);
  }, AUTOSAVE_DEBOUNCE_MS);
  pending.set(input.documentId, entry);
}

/**
 * 立即落盘指定文档的待存快照（取消其防抖计时器）。
 *
 * @returns 已落盘的字节；无待存内容或落盘失败返回 null
 */
export async function flushAutosave(documentId: string): Promise<Uint8Array | null> {
  const entry = pending.get(documentId);
  if (!entry) return null;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  pending.delete(documentId);
  return persist(entry);
}

/** 立即落盘全部待存快照（用于退出 / 批量场景） */
export async function flushAllAutosaves(): Promise<void> {
  await Promise.all([...pending.keys()].map((id) => flushAutosave(id)));
}

/**
 * 丢弃指定文档的备份：先取消本地待存调度，再通知主进程删除已落盘的备份。
 *
 * @returns 主进程是否删除了对应记录
 */
export async function discardAutosave(documentId: string): Promise<boolean> {
  const entry = pending.get(documentId);
  if (entry?.timer) clearTimeout(entry.timer);
  pending.delete(documentId);
  try {
    return await transport.discardBackup(documentId);
  } catch (err) {
    console.warn('[autosave] 备份删除失败（已忽略）：', err);
    return false;
  }
}

/** 测试用：清空调度队列 / 计时器并还原默认传输层 */
export function __resetAutosave(): void {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  pending.clear();
  transport = defaultTransport;
}
