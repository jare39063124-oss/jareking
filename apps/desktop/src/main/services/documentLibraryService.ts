/**
 * 文档库服务：封装 DocumentLibrary + AutosaveManager，
 * 自动保存快照目录位于 userData/autosaves。
 */
import { join } from 'node:path';
import {
  AutosaveManager,
  DocumentLibrary,
  type Database,
} from '@jareking/core';
import { getDb, getUserDataDir } from './db.js';

export class DocumentLibraryService {
  /** 最近文件 / 文档元数据 */
  readonly library: DocumentLibrary;
  /** 自动保存与崩溃恢复 */
  readonly autosave: AutosaveManager;

  constructor(db: Database) {
    this.library = new DocumentLibrary(db);
    this.autosave = new AutosaveManager(db, join(getUserDataDir(), 'autosaves'));
  }
}

/** 文档库服务单例（依赖数据库单例） */
let instance: DocumentLibraryService | null = null;

export async function getDocumentLibraryService(): Promise<DocumentLibraryService> {
  if (!instance) {
    instance = new DocumentLibraryService(await getDb());
  }
  return instance;
}
