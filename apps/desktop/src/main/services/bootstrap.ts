/**
 * 服务装配：按 db → account → library 顺序初始化全部本地服务。
 * 供主进程 index.ts 在 app.whenReady() 之后调用接入；现在只需导出。
 */
import type { Database } from '@jareking/core';
import { getDb } from './db.js';
import { getAccountService, type AccountService } from './accountService.js';
import {
  getDocumentLibraryService,
  type DocumentLibraryService,
} from './documentLibraryService.js';
import { AiConfigService } from './aiConfigService.js';
import { MacroService } from './macroService.js';

/** 主进程全部本地服务实例 */
export interface AppServices {
  db: Database;
  account: AccountService;
  library: DocumentLibraryService;
  ai: AiConfigService;
  macro: MacroService;
}

/** 初始化全部本地服务（内部为单例，重复调用返回同一组实例） */
export async function initServices(): Promise<AppServices> {
  const db = await getDb();
  const account = await getAccountService();
  const library = await getDocumentLibraryService();
  const ai = new AiConfigService();
  const macro = new MacroService();
  return { db, account, library, ai, macro };
}
