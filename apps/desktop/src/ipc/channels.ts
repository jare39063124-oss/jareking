/**
 * 主进程 / 预加载 / 渲染进程共享的 IPC 通道常量。
 * 抽出此文件是因为 preload/index.ts 顶层会执行 contextBridge（仅预加载上下文可用），
 * 主进程不能直接 import 该文件；通道名在此单一来源定义，两端各自引用。
 */
export const IPC = {
  DB_QUERY: 'db:query',
  ACCOUNT_GET: 'account:get',
  ACCOUNT_POINTS: 'account:points',
  DOC_RECENT_LIST: 'doc:recent:list',
  DOC_RECENT_PIN: 'doc:recent:pin',
  DOC_READ_FILE: 'doc:read-file',
  DOC_REVEAL: 'doc:reveal',
  DOC_AUTOSAVE_SAVE: 'doc:autosave:save',
  DOC_AUTOSAVE_PENDING: 'doc:autosave:pending',
  UPDATER_CHECK: 'updater:check',
  AI_CONFIG_LIST: 'ai:config:list',
  AI_CONFIG_SAVE: 'ai:config:save',
  AI_CONFIG_DELETE: 'ai:config:delete',
  AI_KEY_RESOLVE: 'ai:key:resolve',
  SYSTEM_STORAGE_INFO: 'system:storageInfo',
  SYSTEM_OPEN_DATA_DIR: 'system:openDataDir',
  SYSTEM_OPEN_EXTERNAL: 'system:openExternal',
  PDF_OFFICE_TO_PDF: 'pdf:office-to-pdf',
} as const;

/** 允许通过 db:query 执行的操作名（白名单，杜绝任意 SQL 注入） */
export type DbOp =
  | 'recent'
  | 'settingsGet'
  | 'settingsSet';
