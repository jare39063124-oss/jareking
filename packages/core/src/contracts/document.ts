/**
 * 文档相关契约。
 * 注意：OOXML 文档模型（paragraph/run/table/section…）属 Phase 1（T1.1），
 * 本文件仅定义 Phase 0 需要的文档库元数据契约。
 */

/** 文档模块类型 */
export type DocModule = 'writer' | 'sheet' | 'slide' | 'pdf';

/** 文档文件格式（jare 为 jareking 自有编辑态格式，保留全部编辑信息） */
export type DocFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'jare';

/** 格式保真等级：L1 文本结构 / L2 常规格式 / L3 高级特性（v1 目标 L2） */
export type FidelityLevel = 'L1' | 'L2' | 'L3';

/** 文档元数据（本地文档库契约） */
export interface DocumentMeta {
  id: string;
  module: DocModule;
  title: string;
  /** null = 未保存的新建文档 */
  filePath: string | null;
  format: DocFormat;
  fidelity: FidelityLevel;
  createdAt: number;
  updatedAt: number;
  sizeBytes: number;
}

/** 自动保存快照（崩溃恢复用） */
export interface AutosaveSnapshot {
  documentId: string;
  savedAt: number;
  snapshotPath: string;
}

/** 最近文件条目 */
export interface RecentFile {
  document: DocumentMeta;
  lastOpenedAt: number;
  pinned: boolean;
}
