/**
 * 文档库：文档元数据 + 最近文件列表。
 * 列表规则：置顶（pinned）优先，其余按 lastOpenedAt 倒序（契约见 contracts/document.ts）。
 */
import type { Database, Row } from '../db/database.js';
import type { DocumentMeta, RecentFile } from '../contracts/document.js';

export class DocumentLibrary {
  constructor(private readonly db: Database) {}

  /**
   * 新增或更新文档元数据，并刷新其在最近列表中的打开时间。
   * @param lastOpenedAt 打开时间戳，默认当前时间（测试可传入以确定排序）
   */
  addOrUpdateRecent(meta: DocumentMeta, lastOpenedAt: number = Date.now()): void {
    this.db.transaction(() => {
      // 元数据 upsert：已存在则更新（保留 created_at，刷新 updated_at 等字段）
      this.db.exec(
        `INSERT INTO documents_meta
           (id, module, title, file_path, format, fidelity, created_at, updated_at, size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           module = excluded.module,
           title = excluded.title,
           file_path = excluded.file_path,
           format = excluded.format,
           fidelity = excluded.fidelity,
           updated_at = excluded.updated_at,
           size_bytes = excluded.size_bytes`,
        [
          meta.id,
          meta.module,
          meta.title,
          meta.filePath,
          meta.format,
          meta.fidelity,
          meta.createdAt,
          meta.updatedAt,
          meta.sizeBytes,
        ],
      );
      // 最近列表 upsert：已存在只刷新打开时间（不动 pinned 状态）
      this.db.exec(
        `INSERT INTO recent_files (document_id, last_opened_at, pinned)
         VALUES (?, ?, 0)
         ON CONFLICT(document_id) DO UPDATE SET last_opened_at = excluded.last_opened_at`,
        [meta.id, lastOpenedAt],
      );
    });
    this.db.save();
  }

  /** 最近文件列表：置顶优先，按 lastOpenedAt 倒序 */
  listRecent(): RecentFile[] {
    const rows = this.db.all<Row>(
      `SELECT m.id, m.module, m.title, m.file_path, m.format, m.fidelity,
              m.created_at, m.updated_at, m.size_bytes,
              r.last_opened_at, r.pinned
       FROM recent_files r
       JOIN documents_meta m ON m.id = r.document_id
       ORDER BY r.pinned DESC, r.last_opened_at DESC`,
    );
    return rows.map((row) => ({
      document: {
        id: String(row['id']),
        module: String(row['module']) as DocumentMeta['module'],
        title: String(row['title']),
        filePath: row['file_path'] === null ? null : String(row['file_path']),
        format: String(row['format']) as DocumentMeta['format'],
        fidelity: String(row['fidelity']) as DocumentMeta['fidelity'],
        createdAt: Number(row['created_at']),
        updatedAt: Number(row['updated_at']),
        sizeBytes: Number(row['size_bytes']),
      },
      lastOpenedAt: Number(row['last_opened_at']),
      pinned: Number(row['pinned']) === 1,
    }));
  }

  /** 置顶 / 取消置顶（条目不存在时静默忽略） */
  pin(documentId: string, pinned: boolean): void {
    this.db.exec('UPDATE recent_files SET pinned = ? WHERE document_id = ?', [
      pinned ? 1 : 0,
      documentId,
    ]);
    this.db.save();
  }

  /**
   * 从最近列表移除文档；同时清理其元数据与自动保存记录
   * （本地文档库语义：彻底移除，重新打开该文件时会再次入库）。
   */
  removeRecent(documentId: string): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM recent_files WHERE document_id = ?', [documentId]);
      this.db.exec('DELETE FROM autosaves WHERE document_id = ?', [documentId]);
      this.db.exec('DELETE FROM documents_meta WHERE id = ?', [documentId]);
    });
    this.db.save();
  }
}
