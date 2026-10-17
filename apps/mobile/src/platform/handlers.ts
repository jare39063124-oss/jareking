/**
 * 移动端通道处理器（29 个 IPC 通道的 Android 实现）。
 *
 * 契约：通道名**不在本文件定义**——统一从 `apps/desktop/src/ipc/channels.ts` 导入，
 * 与桌面端共用同一份单一事实源（铁律 1.1）。
 * 渲染层看到的调用形状完全不变：`window.jareking.invoke(channel, payload)`，
 * 因此 desktop 的 105 个渲染层文件无需任何改动即可在移动端运行。
 *
 * 能力差异（已在 docs/mobile-spike-report.md 登记）：
 *  - `pdf:office-to-pdf`：Windows PowerShell + COM，Android 不可用 → 显式报错；
 *  - `pdf:export-html`：依赖 Electron `printToPDF`，Android 无等价能力 → 显式报错；
 *  - `doc:reveal`：Android 无「在文件夹中显示」概念 → 返回 false；
 *  - `system:openDataDir`：应用沙箱无文件管理器入口 → 返回 false。
 */
import { IPC } from '@ipc';
import {
  fileDel,
  fileGet,
  fileList,
  filePut,
  kvDel,
  kvGet,
  kvSet,
  usedBytes,
  type StoredFile,
} from '../storage/webStore';
import { classify, makePseudoPath, PSEUDO_SCHEME, parsePseudoPath } from './filePath';

/* ------------------------------ 类型 ------------------------------ */

type Payload = Record<string, unknown> | undefined;

/** 打开过的 File 句柄（同一会话内直接复用，避免重新读盘） */
const fileHandles = new Map<string, File>();

/** 最近文件条目（与 desktop `RecentFile` 形状一致） */
interface RecentRow {
  document: {
    id: string;
    module: string;
    title: string;
    filePath: string | null;
    format: string;
    fidelity: string;
    createdAt: number;
    updatedAt: number;
    sizeBytes: number;
  };
  lastOpenedAt: number;
  pinned: boolean;
}

/* ------------------------------ 工具 ------------------------------ */

function newId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

/** 扩展名 → 模块/格式（移动端打开的文件一定是这四类之一） */
function unsupported(feature: string): never {
  throw new Error(`[移动端不支持] ${feature}`);
}

/* ------------------------------ 文件注册 ------------------------------ */

/**
 * 把用户在系统文件选择器里选中的 File 注册成伪路径。
 * 对应桌面端 `webUtils.getPathForFile`。
 * 字节同时落库（IndexedDB），保证「最近使用」重启后仍可打开。
 */
export function registerPickedFile(file: File): string {
  const id = newId('f');
  const path = makePseudoPath(id, file.name);
  fileHandles.set(path, file);

  const { module, format } = classify(file.name);
  void (async () => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await filePut({ id, name: file.name, bytes, savedAt: Date.now(), meta: { module, format } });
      await upsertRecent({
        path,
        id,
        name: file.name,
        module,
        format,
        sizeBytes: bytes.length,
      });
    } catch (err) {
      console.warn('[jareking-mobile] 缓存选中文件失败：', err);
    }
  })();

  return path;
}

async function upsertRecent(info: {
  path: string;
  id: string;
  name: string;
  module: string;
  format: string;
  sizeBytes?: number;
}): Promise<void> {
  const rows = (await kvGet<RecentRow[]>('recent')) ?? [];
  const now = Date.now();
  const hit = rows.findIndex((r) => r.document.filePath === info.path);
  const row: RecentRow = {
    document: {
      id: info.id,
      module: info.module,
      title: info.name,
      filePath: info.path,
      format: info.format,
      fidelity: 'L2',
      createdAt: hit >= 0 ? rows[hit].document.createdAt : now,
      updatedAt: now,
      sizeBytes: info.sizeBytes ?? 0,
    },
    lastOpenedAt: now,
    pinned: hit >= 0 ? rows[hit].pinned : false,
  };
  if (hit >= 0) rows[hit] = row;
  else rows.unshift(row);
  // 置顶优先，其次按最近打开时间
  rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpenedAt - a.lastOpenedAt);
  await kvSet('recent', rows.slice(0, 50));
}

/* ------------------------------ 账户 / 积分 ------------------------------ */

interface LocalAccountRow {
  account: { id: string; deviceId: string; nickname: string; createdAt: number };
  balance: { balance: number; updatedAt: number };
  bonus: { id: string; delta: number; balanceAfter: number; reason: string; createdAt: number } | null;
}

/** 首次启动引导（幂等）：与桌面端一致，新用户赠送 1000 积分 */
async function bootstrapAccount(): Promise<LocalAccountRow> {
  const cached = await kvGet<LocalAccountRow>('account');
  if (cached) return cached;
  const now = Date.now();
  const row: LocalAccountRow = {
    account: { id: newId('acc-'), deviceId: newId('dev-'), nickname: '本地用户', createdAt: now },
    balance: { balance: 1000, updatedAt: now },
    bonus: { id: newId('pt-'), delta: 1000, balanceAfter: 1000, reason: 'signup', createdAt: now },
  };
  await kvSet('account', row);
  return row;
}

/* ------------------------------ 通道实现 ------------------------------ */

/** 待打开队列（对应桌面端「外部启动参数 / 单实例转发」的文件列表，取走即清空） */
const pendingOpenPaths: string[] = [];

/** 供原生层（Intent / 分享）投递待打开文件；MVP 阶段暂无调用方 */
export function enqueuePendingOpen(path: string): void {
  if (path) pendingOpenPaths.push(path);
}

type Handler = (payload: Payload) => unknown | Promise<unknown>;

const handlers: Record<string, Handler> = {
  /* ===== 账户 / 积分（本地，v1 零服务端） ===== */
  [IPC.ACCOUNT_GET]: () => bootstrapAccount(),
  [IPC.ACCOUNT_POINTS]: async (payload) => {
    const row = await bootstrapAccount();
    const limit = Number(payload?.limit ?? 20);
    const entries = ((await kvGet<unknown[]>('points:entries')) ?? []).slice(0, limit);
    return { balance: row.balance, entries };
  },

  /* ===== 设置（db:query 白名单） ===== */
  [IPC.DB_QUERY]: async (payload) => {
    const op = String(payload?.op ?? '');
    const params = (payload?.params as (string | number)[]) ?? [];
    if (op === 'settingsGet') return kvGet(`setting:${String(params[0] ?? '')}`);
    if (op === 'settingsSet') {
      await kvSet(`setting:${String(params[0])}`, params[1]);
      return true;
    }
    throw new Error(`未知的 db 操作: ${op}`);
  },

  /* ===== 文档库 / 最近使用 ===== */
  [IPC.DOC_RECENT_LIST]: async () => (await kvGet<RecentRow[]>('recent')) ?? [],
  /** 取走外部投递的待打开文件（桌面端来自 argv/单实例；移动端来自 Intent，MVP 为空） */
  [IPC.DOC_PENDING_TAKE]: () => pendingOpenPaths.splice(0, pendingOpenPaths.length),  [IPC.DOC_RECENT_PIN]: async (payload) => {
    const documentId = String(payload?.documentId ?? '');
    const pinned = Boolean(payload?.pinned);
    if (!documentId) return false;
    const rows = (await kvGet<RecentRow[]>('recent')) ?? [];
    const row = rows.find((r) => r.document.id === documentId);
    if (!row) return false;
    row.pinned = pinned;
    rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpenedAt - a.lastOpenedAt);
    await kvSet('recent', rows);
    return true;
  },

  /** 读文件字节：优先内存句柄 → IndexedDB 缓存（重启后仍可打开） */
  [IPC.DOC_READ_FILE]: async (payload) => {
    const path = String(payload?.path ?? '');
    const handle = fileHandles.get(path);
    if (handle) return new Uint8Array(await handle.arrayBuffer());
    const parsed = parsePseudoPath(path);
    if (!parsed) return null; // 非本端伪路径（如桌面遗留路径）→ 交由 UI 提示
    const rec = await fileGet(parsed.id);
    return rec ? new Uint8Array(rec.bytes) : null;
  },

  /** Android 无「在文件夹中显示」→ 明确返回 false，UI 静默 */
  [IPC.DOC_REVEAL]: () => false,

  /* ===== 自动保存快照 ===== */
  [IPC.DOC_AUTOSAVE_SAVE]: async (payload) => {
    const documentId = String(payload?.documentId ?? '');
    if (!documentId) return null;
    const snap = { documentId, savedAt: Date.now(), snapshotPath: `idb://autosave/${documentId}` };
    await kvSet(`autosave:${documentId}`, { ...snap, data: payload?.data });
    return snap;
  },
  [IPC.DOC_AUTOSAVE_PENDING]: async () => {
    const map = (await kvGet<Record<string, { savedAt: number }>>('autosave:index')) ?? {};
    return Object.entries(map).map(([documentId, v]) => ({
      documentId,
      savedAt: v.savedAt,
      snapshotPath: `idb://autosave/${documentId}`,
    }));
  },

  /* ===== 崩溃恢复中心（文件字节备份） ===== */
  [IPC.DOC_BACKUP_SAVE]: async (payload) => {
    const documentId = String(payload?.documentId ?? '');
    if (!documentId) return null;
    const bytes = payload?.bytes instanceof Uint8Array ? payload.bytes : new Uint8Array(0);
    const savedAt = Date.now();
    await filePut({
      id: `backup:${documentId}`,
      name: String(payload?.title ?? '未命名'),
      bytes,
      savedAt,
      meta: { module: payload?.module, documentId, kind: 'backup' },
    });
    return { documentId, savedAt, snapshotPath: `idb://backup/${documentId}` };
  },
  [IPC.DOC_BACKUP_LIST]: async () => {
    const rows = await fileList();
    return rows
      .filter((r) => r.meta?.kind === 'backup')
      .map((r) => ({
        documentId: String(r.meta?.documentId ?? r.id),
        module: String(r.meta?.module ?? 'writer'),
        title: r.name,
        sizeBytes: r.bytes.length,
        savedAt: r.savedAt,
      }));
  },
  /** 恢复：把备份还原成可打开的伪文件，交由渲染层「待打开」机制直达编辑器 */
  [IPC.DOC_BACKUP_RECOVER]: async (payload) => {
    const documentId = String(payload?.documentId ?? '');
    const rec = await fileGet(`backup:${documentId}`);
    if (!rec) return null;
    const id = newId('f');
    const path = makePseudoPath(id, rec.name);
    await filePut({ id, name: rec.name, bytes: rec.bytes, savedAt: Date.now(), meta: rec.meta });
    await upsertRecent({
      path,
      id,
      name: rec.name,
      module: String(rec.meta?.module ?? 'writer'),
      format: classify(rec.name).format,
      sizeBytes: rec.bytes.length,
    });
    return { path, name: rec.name, module: String(rec.meta?.module ?? 'writer') };
  },
  [IPC.DOC_BACKUP_DISCARD]: async (payload) => {
    const documentId = String(payload?.documentId ?? '');
    if (!documentId) return false;
    await fileDel(`backup:${documentId}`);
    return true;
  },

  /* ===== AI（配置与算力计量；调用本身由渲染层直接 fetch） ===== */
  [IPC.AI_CONFIG_LIST]: async () => (await kvGet<unknown[]>('ai:configs')) ?? [],
  [IPC.AI_CONFIG_SAVE]: async (payload) => {
    const configs = (await kvGet<Record<string, unknown>[]>('ai:configs')) ?? [];
    const input = { ...(payload ?? {}) } as Record<string, unknown>;
    const id = String(input.id ?? newId('cfg-'));
    const idx = configs.findIndex((c) => String(c.id) === id);
    const row = { ...input, id, updatedAt: Date.now() };
    if (idx >= 0) configs[idx] = row;
    else configs.push(row);
    await kvSet('ai:configs', configs);
    return row;
  },
  [IPC.AI_CONFIG_DELETE]: async (payload) => {
    const id = String(payload?.id ?? '');
    const configs = (await kvGet<Record<string, unknown>[]>('ai:configs')) ?? [];
    await kvSet(
      'ai:configs',
      configs.filter((c) => String(c.id) !== id),
    );
    return true;
  },
  [IPC.AI_KEY_RESOLVE]: async (payload) => {
    const id = String(payload?.id ?? '');
    const configs = (await kvGet<Record<string, unknown>[]>('ai:configs')) ?? [];
    const hit = configs.find((c) => String(c.id) === id);
    return String(hit?.apiKey ?? '');
  },
  [IPC.AI_METER_SUMMARY]: async () => {
    const usage = (await kvGet<unknown[]>('ai:usage')) ?? [];
    return {
      totalCalls: usage.length,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      points: 0,
    };
  },
  [IPC.AI_METER_RECORDS]: async (payload) => {
    const limit = Number(payload?.limit ?? 20);
    return ((await kvGet<unknown[]>('ai:usage')) ?? []).slice(0, limit);
  },

  /* ===== 系统 ===== */
  [IPC.SYSTEM_STORAGE_INFO]: async () => ({
    dataDir: '应用私有存储（IndexedDB）',
    bytes: await usedBytes(),
  }),
  [IPC.SYSTEM_OPEN_DATA_DIR]: () => false,
  [IPC.SYSTEM_OPEN_EXTERNAL]: async (payload) => {
    const url = String(payload?.url ?? '');
    if (!/^https:\/\//i.test(url)) return false;
    // Capacitor Browser 在系统浏览器打开；非原生环境回落 window.open
    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.open({ url });
      return true;
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    }
  },

  /* ===== PDF（能力差异，见文件头注释） ===== */
  [IPC.PDF_OFFICE_TO_PDF]: () => unsupported('Office 转 PDF（依赖 Windows COM）'),
  [IPC.PDF_EXPORT_HTML]: () => unsupported('导出 PDF（依赖 Electron printToPDF）'),

  /* ===== 宏（本地键值） ===== */
  [IPC.MACRO_LIST]: async () => {
    const names = (await kvGet<string[]>('macro:index')) ?? [];
    return Promise.all(
      names.map(async (name) => ({
        name,
        updatedAt: Number((await kvGet<{ updatedAt?: number }>(`macro:${name}`))?.updatedAt ?? 0),
      })),
    );
  },
  [IPC.MACRO_READ]: async (payload) => {
    const name = String(payload?.name ?? '');
    return String((await kvGet<{ code?: string }>(`macro:${name}`))?.code ?? '');
  },
  [IPC.MACRO_SAVE]: async (payload) => {
    const name = String(payload?.name ?? '');
    const code = String(payload?.code ?? '');
    await kvSet(`macro:${name}`, { code, updatedAt: Date.now() });
    const names = new Set((await kvGet<string[]>('macro:index')) ?? []);
    names.add(name);
    await kvSet('macro:index', [...names]);
    return { name, updatedAt: Date.now() };
  },
  [IPC.MACRO_DELETE]: async (payload) => {
    const name = String(payload?.name ?? '');
    await kvDel(`macro:${name}`);
    const names = ((await kvGet<string[]>('macro:index')) ?? []).filter((n) => n !== name);
    await kvSet('macro:index', names);
    return true;
  },

  /* ===== 更新（移动端走应用商店，无自更新） ===== */
  [IPC.UPDATER_CHECK]: () => ({ status: 'unsupported', message: '移动端通过应用商店更新' }),
};

/** 统一分发入口（未知通道抛错，避免静默失败掩盖接线遗漏） */
export async function dispatch(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers[channel];
  if (!handler) throw new Error(`[jareking-mobile] 未实现的通道: ${channel}`);
  return handler(payload as Payload);
}

/** 已实现的通道清单（供自检 / 报告统计） */
export const IMPLEMENTED_CHANNELS = Object.keys(handlers);

export type { StoredFile };
