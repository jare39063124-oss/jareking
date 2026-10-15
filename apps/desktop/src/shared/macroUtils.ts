/**
 * 宏文件命名 / 校验纯函数（主进程与渲染层共用，抽到 shared 便于单测）。
 *
 * 抽出的原因：
 *  ① 主进程 `macroService` 用它安全化文件名（拒绝路径穿越 `../` 与非法字符）；
 *  ② 渲染层可复用同一套规则做「保存/运行前」校验；
 *  ③ 纯函数无副作用，可在 vitest（`src/shared/**` include）下直接跑。
 */
export const MACRO_FILE_EXT = '.js';

/** 宏元信息（IPC 契约：主进程 macroService 与渲染层 macroStore 共用，单一来源） */
export interface MacroMeta {
  /** 宏名（不含 `.js` 后缀） */
  name: string;
  /** 最后修改时间（毫秒时间戳） */
  updatedAt: number;
}

/** 宏名长度上限（保守取值，兼顾文件系统与可读性） */
const MAX_NAME_LENGTH = 64;

/** Windows 非法文件名字符 + 路径分隔符 + ASCII 控制字符 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

export interface SanitizeMacroNameResult {
  /** 是否合法 */
  ok: boolean;
  /** 安全化后的宏名（ok=false 时为空串） */
  name: string;
  /** 失败原因（中文，供 UI 提示） */
  reason?: string;
}

/**
 * 安全化并校验宏名。
 *
 * 规则：去首尾空白；非空；长度 ≤ 64；不含路径分隔符 / 通配符等非法字符；
 * 不含 `..`（路径穿越）；不以点号开头或结尾（避免隐藏文件 / 无扩展名歧义）。
 *
 * @param raw 用户输入的原始宏名（可能为任意类型，防御性处理）
 */
export function sanitizeMacroName(raw: unknown): SanitizeMacroNameResult {
  if (typeof raw !== 'string') return { ok: false, name: '', reason: '宏名必须是字符串' };
  const name = raw.trim();
  if (name === '') return { ok: false, name: '', reason: '宏名不能为空' };
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, name: '', reason: `宏名过长（上限 ${MAX_NAME_LENGTH} 字符）` };
  }
  if (ILLEGAL_CHARS.test(name)) {
    return { ok: false, name: '', reason: '宏名不能包含 \\ / : * ? " < > | 等非法字符' };
  }
  if (name.includes('..')) {
    return { ok: false, name: '', reason: '宏名不能包含 ".."（禁止路径穿越）' };
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    return { ok: false, name: '', reason: '宏名不能以点号开头或结尾' };
  }
  return { ok: true, name };
}

/** 便捷布尔版：宏名是否合法 */
export function isValidMacroName(raw: unknown): boolean {
  return sanitizeMacroName(raw).ok;
}

/**
 * 宏名 → 磁盘文件名（追加 `.js` 后缀）。
 *
 * @throws 宏名非法时抛出（携带中文原因）
 */
export function macroFileName(rawName: unknown): string {
  const result = sanitizeMacroName(rawName);
  if (!result.ok) throw new Error(result.reason ?? '非法宏名');
  return `${result.name}${MACRO_FILE_EXT}`;
}
