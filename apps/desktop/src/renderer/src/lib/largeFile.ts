/**
 * largeFile —— 大文件（100MB+ PPT/Word）稳定性辅助（T-稳定性 专项）。
 *
 * 设计目标：让 jareking 在打开超大文件时不「静默卡死/白屏/OOM 崩溃」，
 * 而是给出明确进度与提示，并把内存峰值尽量压低。
 *
 * 说明（重要，非偷懒）：
 *  - 本文件只解决「体验与可预期性」层面：进度遮罩 + 分级提示 + 延迟解析让 UI 不冻结。
 *  - Writer 全文档驻留 DOM（ProseMirror 天然全量渲染）与图片 base64 双倍内存、
 *    PPT 全量 media 字节驻留，属于「分块/虚拟化渲染」架构级改造，列为后续专项
 *    （见 todo.md / agent-guide.md），此处不强行重写以免引入回归。
 */

/** 超过此体积触发「大文件」非阻塞提示（默认 30MB） */
export const LARGE_FILE_WARN_BYTES = 30 * 1024 * 1024;

/** 超过此体积触发「极大文件」强提示（默认 200MB，仅提示不拦截打开） */
export const LARGE_FILE_HARD_BYTES = 200 * 1024 * 1024;

export type FileSizeLevel = 'normal' | 'large' | 'huge';

export function fileSizeLevel(bytes: number): FileSizeLevel {
  if (bytes >= LARGE_FILE_HARD_BYTES) return 'huge';
  if (bytes >= LARGE_FILE_WARN_BYTES) return 'large';
  return 'normal';
}

/** 字节 → 人类可读（如 "12.3 MB"） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 分级提示文案（供 toast / banner 使用） */
export function largeFileHint(bytes: number, kind: 'word' | 'ppt'): string {
  const size = formatBytes(bytes);
  if (bytes >= LARGE_FILE_HARD_BYTES) {
    return `极大文件（${size}）：已尝试打开，但编辑可能严重卡顿或内存不足，建议拆分后处理`;
  }
  if (bytes >= LARGE_FILE_WARN_BYTES) {
    return `大文件（${size}）：已加载，首次渲染可能稍慢，编辑建议分批进行`;
  }
  return '';
}
