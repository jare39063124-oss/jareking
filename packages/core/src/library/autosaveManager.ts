/**
 * 自动保存管理：快照写入 autosaveDir/<documentId>.json，
 * 并通过 autosaves 表跟踪崩溃恢复状态（recovering 标记，契约见 contracts/document.ts）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database, Row } from '../db/database.js';
import type { AutosaveSnapshot } from '../contracts/document.js';

/** 快照文件内容结构 */
export interface SnapshotFile {
  documentId: string;
  savedAt: number;
  data: unknown;
}

export class AutosaveManager {
  constructor(
    private readonly db: Database,
    private readonly autosaveDir: string,
  ) {}

  /**
   * 保存快照：写 JSON 文件并更新 autosaves 表（recovering 复位为 0）。
   * @returns 快照信息（路径供崩溃恢复读取）
   */
  saveSnapshot(documentId: string, data: unknown): AutosaveSnapshot {
    // 文件名做安全清洗，防止 documentId 中的异常字符导致路径逃逸
    const safeId = documentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    mkdirSync(this.autosaveDir, { recursive: true });
    const snapshotPath = join(this.autosaveDir, `${safeId}.json`);
    const savedAt = Date.now();
    const payload: SnapshotFile = { documentId, savedAt, data };
    writeFileSync(snapshotPath, JSON.stringify(payload), 'utf8');
    this.db.transaction(() => {
      this.db.exec(
        `INSERT INTO autosaves (document_id, saved_at, snapshot_path, recovering)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(document_id) DO UPDATE SET
           saved_at = excluded.saved_at,
           snapshot_path = excluded.snapshot_path,
           recovering = 0`,
        [documentId, savedAt, snapshotPath],
      );
    });
    this.db.save();
    return { documentId, savedAt, snapshotPath };
  }

  /** 标记快照待恢复（崩溃后重启时调用） */
  markRecovering(documentId: string): void {
    this.db.exec('UPDATE autosaves SET recovering = 1 WHERE document_id = ?', [documentId]);
    this.db.save();
  }

  /** 清除待恢复标记（恢复完成或用户放弃恢复后调用） */
  clearRecovering(documentId: string): void {
    this.db.exec('UPDATE autosaves SET recovering = 0 WHERE document_id = ?', [documentId]);
    this.db.save();
  }

  /** 列出所有待恢复快照（recovering = 1，按保存时间升序） */
  listPendingRecovery(): AutosaveSnapshot[] {
    const rows = this.db.all<Row>(
      `SELECT document_id, saved_at, snapshot_path
       FROM autosaves WHERE recovering = 1
       ORDER BY saved_at ASC`,
    );
    return rows.map((row) => ({
      documentId: String(row['document_id']),
      savedAt: Number(row['saved_at']),
      snapshotPath: String(row['snapshot_path']),
    }));
  }

  /** 读取快照内容；文件不存在返回 null */
  readSnapshot(snapshotPath: string): SnapshotFile | null {
    if (!existsSync(snapshotPath)) return null;
    return JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotFile;
  }
}
