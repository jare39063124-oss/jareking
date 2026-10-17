/**
 * sql.js shim —— 移动端不使用 WASM SQLite（改用 IndexedDB）。
 * 桌面端持久层（core/db/database.ts）在移动端不会实例化；若误调用则显式报错。
 */
const initSqlJs = async (): Promise<never> => {
  throw new Error(
    '[jareking-mobile] sql.js 在移动端不可用：持久层请使用 src/storage/webStore.ts（IndexedDB）',
  );
};

export default initSqlJs;
