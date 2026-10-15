/**
 * 宏沙箱「主线程 ↔ Worker」消息协议与共享类型（纯类型，无副作用）。
 *
 * 设计要点（见 docs/macros.md）：
 *  - 宏在独立 Web Worker 中执行，Worker 内无 DOM / 无 Node 访问；
 *  - Worker 不能直接操作文档，凡 `jk.*` 调用都经消息桥接回主线程的 `MacroHost` 执行；
 *  - 因此所有 `jk` 方法在主线程侧均为「异步请求 / 响应」。
 */

/** jk API 的宿主实现：由主线程提供，落到「当前文档」上 */
export interface MacroHost {
  /** 取当前文档全文 */
  getText(): string | Promise<string>;
  /** 覆盖全文 */
  setText(text: string): void | Promise<void>;
  /** 追加文本到文档末尾 */
  appendText(text: string): void | Promise<void>;
  /** 查找替换（复用 writer/findReplace） */
  findReplace(
    needle: string,
    replacement: string,
    opts?: { caseSensitive?: boolean },
  ): { count: number } | Promise<{ count: number }>;
  /** 取当前选区文本 */
  getSelection(): string | Promise<string>;
  /** 用文本替换当前选区 */
  replaceSelection(text: string): void | Promise<void>;
  /** 应用文档 ops（复用 writer/opsExecutor） */
  applyOps(ops: unknown[]): unknown | Promise<unknown>;
  /** 工作表：读取单元格文本 */
  sheetGetCellText(a1: string): string | Promise<string>;
  /** 工作表：按 A1 起点写入二维矩阵 */
  sheetSetValues(a1: string, matrix: unknown[][]): void | Promise<void>;
}

/** 单条日志 */
export interface MacroLogEntry {
  level: string;
  text: string;
}

/** 一次宏运行结果 */
export interface MacroRunResult {
  ok: boolean;
  logs: MacroLogEntry[];
  /** 宏 return 的返回值（结构化克隆安全时） */
  result?: unknown;
  /** 失败原因 */
  error?: string;
  /** 耗时（毫秒） */
  durationMs: number;
}

/** 主线程 → Worker 的消息 */
export type WorkerInMessage =
  | { type: 'run'; code: string }
  | { type: 'api-result'; id: number; ok: boolean; value?: unknown; error?: string };

/** Worker → 主线程的消息 */
export type WorkerOutMessage =
  | { type: 'log'; level: string; args: string[] }
  | { type: 'api'; id: number; method: string; args: unknown[] }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string };
