/**
 * printSettings —— Sheet「打印设置」持久化模型与解析纯函数（零 DOM / 零 electron 依赖）。
 *
 * 对应 WPS「页面布局 → 打印设置」中的常用项：纸张 / 方向 / 页边距 / 打印区域 / 重复标题行 /
 * 仅打印活动工作表。本文件只做「数据模型 + 容错反序列化 + 记法解析」，不接触任何渲染 / IPC，
 * 便于单测直接引用（铁律：单一事实源、可复用）。
 *
 * 复用既有实现（勿另起一套）：
 *  - 纸张名 `PrintPageSizeName` 与页边距钳制 `normalizeMarginMm` 来自 `shared/pdfPrint`（唯一来源）；
 *  - A1 记法解析 `parseA1Range` 与列号换算 `toA1` 来自 `@jareking/sheet`。
 * 存储键：`jk-sheet-print-v1`（localStorage，JSON 序列化 SheetPrintSettings）。
 */
import { parseA1Range, toA1 } from '@jareking/sheet';
import { normalizeMarginMm, PAGE_SIZE_MM, type PrintPageSizeName } from '../../../shared/pdfPrint';

/** 打印区域（0 基闭区间）；由 A1 记法解析得到 */
export interface PrintRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** 行范围（0 基闭区间）；由行号记法解析得到 */
export interface RowRange {
  startRow: number;
  endRow: number;
}

/** Sheet「打印设置」（可持久化子集） */
export interface SheetPrintSettings {
  /** 纸张规格名 */
  pageSize: PrintPageSizeName;
  /** 是否横向（true 横向 / false 纵向） */
  landscape: boolean;
  /** 页边距（毫米），[0, 50]，非法回落 15 */
  marginMm: number;
  /** 打印区域（A1 记法，如 'A1:C20'）；null / 空 = 整表 */
  printArea: string | null;
  /** 重复标题行（行号记法，如 '1:2'）；null / 空 = 不重复 */
  repeatRows: string | null;
  /** 仅打印活动工作表 */
  activeOnly: boolean;
}

/** 默认打印设置：A4 / 纵向 / 15mm / 无打印区域 / 无重复行 / 非仅活动表 */
export const DEFAULT_SHEET_PRINT_SETTINGS: SheetPrintSettings = {
  pageSize: 'A4',
  landscape: false,
  marginMm: 15,
  printArea: null,
  repeatRows: null,
  activeOnly: false,
};

/** 全部合法纸张名（取自 PAGE_SIZE_MM，单一事实源） */
const PAGE_SIZE_NAMES = Object.keys(PAGE_SIZE_MM) as PrintPageSizeName[];

/** 校验是否为合法纸张名 */
function isPageSizeName(v: unknown): v is PrintPageSizeName {
  return typeof v === 'string' && (PAGE_SIZE_NAMES as string[]).includes(v);
}

/** 规整文本字段：非字符串或空白 → null；否则返回 trim 后的文本 */
function normalizeTextOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * 容错反序列化：逐字段校验，非法 / 缺失字段各自回落默认值（用于 localStorage 读取）。
 * marginMm 复用 shared/pdfPrint 的 normalizeMarginMm（负数/非有限 → 15，再钳制到 [0, 50]）。
 */
export function normalizeSheetPrintSettings(raw: unknown): SheetPrintSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    pageSize: isPageSizeName(r.pageSize) ? r.pageSize : DEFAULT_SHEET_PRINT_SETTINGS.pageSize,
    landscape:
      typeof r.landscape === 'boolean' ? r.landscape : DEFAULT_SHEET_PRINT_SETTINGS.landscape,
    // 复用既有钳制逻辑（负数/NaN/非数字 → 15；>50 → 50）
    marginMm: normalizeMarginMm(r.marginMm as number | undefined),
    printArea: normalizeTextOrNull(r.printArea),
    repeatRows: normalizeTextOrNull(r.repeatRows),
    activeOnly:
      typeof r.activeOnly === 'boolean' ? r.activeOnly : DEFAULT_SHEET_PRINT_SETTINGS.activeOnly,
  };
}

/**
 * 解析打印区域（A1 记法）为 0 基闭区间；非法返回 null。
 * 支持 'A1:C20' / 'C5' / 'A1'（大小写不敏感、容忍 $ 绝对引用）；反序（如 'C3:A1'）自动归一。
 * 复用 `@jareking/sheet` 的 parseA1Range（勿另写列号换算）。
 *
 * 注意：A1 记法的行号/列号均为 **1 基**，必须 ≥1。parseA1Range 对 'A0'（行号 0）会得到
 * 0 基行号 -1，不满足「0 基闭区间」的下界承诺，故此处显式判负 → 返回 null（语义更诚实）。
 */
export function parsePrintArea(text: string): PrintRange | null {
  const parsed = parseA1Range(text ?? '');
  if (!parsed) return null;
  // 归一：保证 start <= end（反序输入也能得到合法区域）
  const startRow = Math.min(parsed.startRow, parsed.endRow);
  const startCol = Math.min(parsed.startCol, parsed.endCol);
  const endRow = Math.max(parsed.startRow, parsed.endRow);
  const endCol = Math.max(parsed.startCol, parsed.endCol);
  // 任一索引为负（如 'A0' / 'A0:C1' / 'A1:A0'）→ 非法
  if (startRow < 0 || startCol < 0 || endRow < 0 || endCol < 0) return null;
  return { startRow, startCol, endRow, endCol };
}

/**
 * 解析重复标题行；非法返回 null。
 * 支持：
 *  - 行号记法 '1:2' / '2:2' / '1' / '$1:$2'（1 基输入 → 0 基输出，自动归一，且必须 ≥1）；
 *  - 兼容 A1 区域记法 'A1:D2'（取其行范围，同样要求行号 ≥1）。
 * 复用 `@jareking/sheet` 的 parseA1Range（含列字母的行记法场景）。
 */
export function parseRepeatRows(text: string): RowRange | null {
  const t = (text ?? '').trim();
  if (!t) return null;

  // 含字母 → 视为 A1 区域记法，取其行范围（如 'A1:D2' → 行 0..1）
  if (/[A-Za-z]/.test(t)) {
    const r = parseA1Range(t);
    if (!r) return null;
    const startRow = Math.min(r.startRow, r.endRow);
    const endRow = Math.max(r.startRow, r.endRow);
    // A1 记法行号 1 基；parseA1Range 对 'A0' 会得到 -1 → 非法
    if (startRow < 0 || endRow < 0) return null;
    return { startRow, endRow };
  }

  // 纯数字行号记法：'1' / '1:2' / '$1:$2'
  const m = /^\$?(\d+)(?::\$?(\d+))?$/.exec(t);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  // 行号 1 基，且必须为正整数（'1:0' / '0' 等 → null）
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) return null;
  return {
    startRow: Math.min(a, b) - 1,
    endRow: Math.max(a, b) - 1,
  };
}

/**
 * 「确定」时使用的页边距规整（纯函数）：非法（负数 / 非有限 / 非数字）→ 默认 15；超范围 → 钳制到 [0, 50]。
 *
 * 复用 shared/pdfPrint 的 normalizeMarginMm（勿另起一套钳制逻辑），供上层在 UI 确认时对输入
 * 做规整，避免把 '-5' / '999' 原样存盘（本轮仅提供纯函数，接线留待后续）。
 */
export function normalizeMarginForConfirm(v: unknown): number {
  if (typeof v === 'number') return normalizeMarginMm(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return normalizeMarginMm(n);
  }
  return normalizeMarginMm(undefined);
}

/**
 * 0 基闭区间 → A1 记法（单格返回 'A1'，多格返回 'A1:C20'）。
 * 复用 `@jareking/sheet` 的 toA1（列号换算唯一来源）。
 */
export function formatRangeA1(range: PrintRange): string {
  const start = toA1(range.startRow, range.startCol);
  const end = toA1(range.endRow, range.endCol);
  return start === end ? start : `${start}:${end}`;
}
