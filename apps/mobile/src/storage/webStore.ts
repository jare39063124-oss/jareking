/**
 * 移动端持久层（替代桌面端的 sql.js + node:fs）。
 *
 * 设计要点：
 *  - **契约不变**：键值/文件字节两套原语即可覆盖 desktop 主进程的全部本地能力
 *    （设置、最近文件、自动保存快照、崩溃恢复字节、宏、AI 配置与计量）；
 *  - **IndexedDB 为主**：Android WebView 支持 IDB，容量按配额（通常数百 MB），
 *    适合存 docx/xlsx/pptx 字节；不可用时降级为内存 Map（仅当次会话有效，便于排障）；
 *  - 不引入第三方存储依赖（铁律 1.5）。
 */

const DB_NAME = 'jareking';
const DB_VERSION = 1;
const STORE_KV = 'kv';
const STORE_FILES = 'files';

/** 文件字节记录 */
export interface StoredFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  savedAt: number;
  meta?: Record<string, unknown>;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** 内存降级表（IndexedDB 不可用时使用） */
const memKv = new Map<string, unknown>();
const memFiles = new Map<string, StoredFile>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      console.warn('[jareking-mobile] IndexedDB 不可用，持久层降级为内存');
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_FILES)) db.createObjectStore(STORE_FILES, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('[jareking-mobile] IndexedDB 打开失败：', req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

/** 事务包装：统一错误回落到内存（IDB 一旦异常不能拖垮编辑器） */
async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
  fallback: () => T,
): Promise<T> {
  const db = await openDb();
  if (!db) return fallback();
  return new Promise<T>((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => {
        console.warn(`[jareking-mobile] ${store} 操作失败：`, req.error);
        resolve(fallback());
      };
    } catch (err) {
      console.warn(`[jareking-mobile] ${store} 事务异常：`, err);
      resolve(fallback());
    }
  });
}

/* ------------------------------ 键值 ------------------------------ */

export async function kvGet<T>(key: string): Promise<T | null> {
  const v = await withStore<T | undefined>(
    STORE_KV,
    'readonly',
    (s) => s.get(key) as IDBRequest<T | undefined>,
    () => memKv.get(key) as T | undefined,
  );
  return (v ?? null) as T | null;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  memKv.set(key, value);
  await withStore(STORE_KV, 'readwrite', (s) => s.put(value as unknown as never, key), () => undefined);
}

export async function kvDel(key: string): Promise<void> {
  memKv.delete(key);
  await withStore(STORE_KV, 'readwrite', (s) => s.delete(key), () => undefined);
}

/* ------------------------------ 文件字节 ------------------------------ */

export async function filePut(rec: StoredFile): Promise<void> {
  memFiles.set(rec.id, rec);
  await withStore(STORE_FILES, 'readwrite', (s) => s.put(rec), () => undefined);
}

export async function fileGet(id: string): Promise<StoredFile | null> {
  const v = await withStore<StoredFile | undefined>(
    STORE_FILES,
    'readonly',
    (s) => s.get(id) as IDBRequest<StoredFile | undefined>,
    () => memFiles.get(id),
  );
  return v ?? null;
}

export async function fileList(): Promise<StoredFile[]> {
  const all = await withStore<StoredFile[]>(
    STORE_FILES,
    'readonly',
    (s) => s.getAll() as IDBRequest<StoredFile[]>,
    () => [...memFiles.values()],
  );
  return (all ?? []).sort((a, b) => b.savedAt - a.savedAt);
}

export async function fileDel(id: string): Promise<boolean> {
  memFiles.delete(id);
  await withStore(STORE_FILES, 'readwrite', (s) => s.delete(id), () => undefined);
  return true;
}

/** 估算本地占用（对应桌面 system:storageInfo） */
export async function usedBytes(): Promise<number> {
  try {
    const est = await navigator.storage?.estimate?.();
    return est?.usage ?? 0;
  } catch {
    return 0;
  }
}
