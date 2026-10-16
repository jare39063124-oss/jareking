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
  // 崩溃恢复入口显性化（文档备份中心）：文件字节备份的存/列/恢复/丢弃
  DOC_BACKUP_SAVE: 'doc:autosave:save-backup',
  DOC_BACKUP_LIST: 'doc:autosave:list',
  DOC_BACKUP_RECOVER: 'doc:autosave:recover',
  DOC_BACKUP_DISCARD: 'doc:autosave:discard',
  UPDATER_CHECK: 'updater:check',
  AI_CONFIG_LIST: 'ai:config:list',
  AI_CONFIG_SAVE: 'ai:config:save',
  AI_CONFIG_DELETE: 'ai:config:delete',
  AI_KEY_RESOLVE: 'ai:key:resolve',
  // AI 算力计量（token → 积分）：读取汇总 / 用量流水（主进程从本地库读，纯只读）
  AI_METER_SUMMARY: 'ai:meter:summary',
  AI_METER_RECORDS: 'ai:meter:records',
  SYSTEM_STORAGE_INFO: 'system:storageInfo',
  SYSTEM_OPEN_DATA_DIR: 'system:openDataDir',
  SYSTEM_OPEN_EXTERNAL: 'system:openExternal',
  PDF_OFFICE_TO_PDF: 'pdf:office-to-pdf',
  // 导出 PDF（打印管线）：渲染层传打印 HTML，主进程隐藏窗口 printToPDF 返回字节
  PDF_EXPORT_HTML: 'pdf:export-html',
  // 宏（用户 JavaScript 宏）：CRUD 由主进程文件系统实现；执行在渲染进程 Worker 沙箱
  MACRO_LIST: 'macro:list',
  MACRO_READ: 'macro:read',
  MACRO_SAVE: 'macro:save',
  MACRO_DELETE: 'macro:delete',
} as const;

/** 允许通过 db:query 执行的操作名（白名单，杜绝任意 SQL 注入） */
export type DbOp =
  | 'recent'
  | 'settingsGet'
  | 'settingsSet';
