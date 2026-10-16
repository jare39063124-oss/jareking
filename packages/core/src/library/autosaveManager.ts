/**
 * 自动保存管理：快照写入 autosaveDir/<documentId>.json，
 * 并通过 autosaves 表跟踪崩溃恢复状态（recovering 标记，契约见 contracts/document.ts）。
 *
 * 此外提供「文件字节备份」能力（saveBackup / listBackups / beginSession /
 * resolveBackup / discardBackup），把 docx/xlsx/pptx 的二进制快照落盘并登记
 * 模块 / 标题 / 字节数，供渲染层「文档备份中心」列出与恢复（崩溃恢复显性化）。
 * 两套能力并存：既有 JSON 快照（saveSnapshot 等）保持不变，勿删。
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database, Row } from '../db/database.js';
import type { AutosaveSnapshot } from '../contracts/document.js';

/** 快照文件内容结构 */
export interface SnapshotFile {
  documentId: string;
  savedAt: number;
  data: unknown;
}

/** 自动保存「文件字节备份」元信息（崩溃恢复中心的列表项） */
export interface AutosaveBackup {
  documentId: string;
  /** 所属模块（writer / sheet / slide …） */
  module: string;
  /** 展示用标题（通常为文件名） */
  title: string;
  savedAt: number;
  sizeBytes: number;
  /** 备份文件完整路径 */
  snapshotPath: string;
  /** 是否待恢复（recovering = 1；进程启动后所有备份均置 1） */
  pending: boolean;
}

/** 模块 → 备份文件扩展名（与各编辑器导出格式一致） */
const MODULE_EXT: Record<string, string> = {
  writer: 'docx',
  sheet: 'xlsx',
  slide: 'pptx',
};

/** documentId → 安全文件名（仅保留字母数字、下划线、连字符，防路径逃逸） */
function sanitizeId(documentId: string): string {
  return documentId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 标题 → 安全文件名（剔除路径分隔符与非法字符，兜底「未命名」） */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '未命名';
  return cleaned;
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
    const safeId = sanitizeId(documentId);
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

  /* -------------------- 文件字节备份（崩溃恢复中心） -------------------- */

  /**
   * 保存「文件字节备份」：把序列化后的文件字节（docx/xlsx/pptx）写入
   * autosaveDir/<safeId>.<ext>，并登记模块 / 标题 / 字节数（recovering 复位为 0）。
   *
   * @param documentId 文档标识（文件名经清洗，防路径逃逸）
   * @param meta 模块与展示标题
   * @param bytes 文件字节快照
   */
  saveBackup(
    documentId: string,
    meta: { module: string; title: string },
    bytes: Uint8Array,
  ): AutosaveBackup {
    const safeId = sanitizeId(documentId);
    const ext = MODULE_EXT[meta.module] ?? 'bin';
    mkdirSync(this.autosaveDir, { recursive: true });
    const snapshotPath = join(this.autosaveDir, `${safeId}.${ext}`);
    const savedAt = Date.now();
    // 允许传入 ArrayBuffer 视图等兼容类型，统一归一为 Uint8Array
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes as ArrayLike<number>);
    writeFileSync(snapshotPath, data);
    this.db.transaction(() => {
      this.db.exec(
        `INSERT INTO autosaves (document_id, saved_at, snapshot_path, recovering, module, title, size_bytes)
         VALUES (?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET
           saved_at = excluded.saved_at,
           snapshot_path = excluded.snapshot_path,
           recovering = 0,
           module = excluded.module,
           title = excluded.title,
           size_bytes = excluded.size_bytes`,
        [documentId, savedAt, snapshotPath, meta.module, meta.title, data.length],
      );
    });
    // 立即落盘：备份元信息必须与快照文件同时持久化，否则崩溃（进程被杀）时
    // 会残留「有文件、无记录」的孤儿快照而无法在恢复中心列出。频次受上层防抖约束（≥15s）。
    this.db.flush();
    return {
      documentId,
      module: meta.module,
      title: meta.title,
      savedAt,
      sizeBytes: data.length,
      snapshotPath,
      pending: false,
    };
  }

  /**
   * 列出全部「文件字节备份」（module IS NOT NULL 的行；遗留 JSON 快照不展示），
   * 按 saved_at 倒序（最近保存的在前）。
   */
  listBackups(): AutosaveBackup[] {
    const rows = this.db.all<Row>(
      `SELECT document_id, saved_at, snapshot_path, recovering, module, title, size_bytes
       FROM autosaves
       WHERE module IS NOT NULL
       ORDER BY saved_at DESC`,
    );
    return rows.map((row) => ({
      documentId: String(row['document_id']),
      module: String(row['module']),
      title: String(row['title'] ?? ''),
      savedAt: Number(row['saved_at']),
      sizeBytes: Number(row['size_bytes'] ?? 0),
      snapshotPath: String(row['snapshot_path']),
      pending: Number(row['recovering']) === 1,
    }));
  }

  /**
   * 开始新会话：把库中「所有」自动保存记录置为待恢复（recovering = 1）。
   * 语义：进程刚启动 → 凡存在快照即上次会话遗留的未保存文档。
   *
   * @returns 被标记的记录条数
   */
  beginSession(): number {
    const count = Number(this.db.all<Row>('SELECT COUNT(*) AS c FROM autosaves')[0]?.['c'] ?? 0);
    if (count > 0) {
      this.db.exec('UPDATE autosaves SET recovering = 1');
      this.db.save();
    }
    return count;
  }

  /**
   * 恢复备份：把快照字节物化为 targetDir/<title>.<ext>（文件名清洗、同名覆盖），
   * 同时清除该文档的 recovering 标记。文件缺失 / 无记录时返回 null（不抛）。
   */
  resolveBackup(
    documentId: string,
    targetDir: string,
  ): { path: string; name: string; module: string } | null {
    const row = this.db.all<Row>(
      'SELECT snapshot_path, module, title FROM autosaves WHERE document_id = ?',
      [documentId],
    )[0];
    if (!row) return null;
    const snapshotPath = String(row['snapshot_path']);
    if (!existsSync(snapshotPath)) return null;
    const module = String(row['module'] ?? '');
    const ext = MODULE_EXT[module] ?? 'bin';
    // 标题可能已含扩展名（如「报告.docx」），先剥离再统一追加模块扩展名，避免出现 .docx.docx
    const baseTitle = String(row['title'] ?? '').replace(/\.(docx|xlsx|pptx|bin)$/i, '');
    const name = `${sanitizeFileName(baseTitle)}.${ext}`;
    mkdirSync(targetDir, { recursive: true });
    const path = join(targetDir, name);
    writeFileSync(path, readFileSync(snapshotPath));
    this.clearRecovering(documentId);
    return { path, name, module };
  }

  /**
   * 丢弃备份：删除快照文件并删除库记录。
   * 文件不存在也删除库记录；返回是否删除了库记录。
   */
  discardBackup(documentId: string): boolean {
    const row = this.db.all<Row>('SELECT snapshot_path FROM autosaves WHERE document_id = ?', [
      documentId,
    ])[0];
    if (row) {
      const snapshotPath = String(row['snapshot_path']);
      try {
        if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
      } catch {
        // 文件删除失败不阻断库记录清理
      }
    }
    if (!row) return false;
    this.db.transaction(() => {
      this.db.exec('DELETE FROM autosaves WHERE document_id = ?', [documentId]);
    });
    // 立即落盘：删除同样需要即时持久化（与 saveBackup 对齐）
    this.db.flush();
    return true;
  }
}
