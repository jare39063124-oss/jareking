/**
 * 主进程数据库单例：基于 electron app.getPath('userData') 定位 jareking.db。
 * 注意：仅在 Electron 主进程运行时调用（app.whenReady 之后），此处不运行、仅参与类型检查。
 */
import { app } from 'electron';
import { createDatabase, type Database } from '@jareking/core';

/** 数据库单例 Promise（并发调用只初始化一次） */
let dbPromise: Promise<Database> | null = null;

/** userData 目录（Electron 提供：存放数据库与自动保存快照） */
export function getUserDataDir(): string {
  return app.getPath('userData');
}

/** 获取数据库单例（首次调用时创建并完成迁移） */
export function getDb(): Promise<Database> {
  dbPromise ??= createDatabase(getUserDataDir());
  return dbPromise;
}
