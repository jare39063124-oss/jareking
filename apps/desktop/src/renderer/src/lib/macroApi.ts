/**
 * 宏相关的渲染层纯函数 / 常量（可在 jsdom 下单测，不触碰 DOM / Worker）。
 */

/** 宏执行超时（毫秒）：超时由主线程强制 terminate Worker，防死循环 */
export const MACRO_TIMEOUT_MS = 5000;

/** 宏代码长度上限（防御性；正常宏远小于此值） */
export const MAX_MACRO_CODE_LENGTH = 200_000;

/**
 * jk 白名单 API 一览（用于 UI 展示与文档）。
 * Worker 内的实际绑定见 `macroWorker.ts`。
 */
export const JK_API_METHODS: readonly string[] = [
  'jk.log(...args)',
  'const text = await jk.getText()',
  'await jk.setText(text)',
  'await jk.appendText(text)',
  'await jk.findReplace(needle, replacement, { caseSensitive })',
  'const sel = await jk.getSelection()',
  'await jk.replaceSelection(text)',
  'await jk.applyOps(ops)',
  'await jk.sheet.getCellText(a1)',
  'await jk.sheet.setValues(a1, matrix)',
];

/** 新建宏时的示例代码 */
export const SAMPLE_MACRO = `// 示例宏：统计字数 + 查找替换（所有 jk 方法均返回 Promise，需 await）
const text = await jk.getText();
jk.log('当前文档字数：', text.length);

// 演示查找替换：把「测试」替换为「验收」
const r = await jk.findReplace('测试', '验收');
jk.log('替换次数：', r.count);
`;

export interface MacroValidationResult {
  ok: boolean;
  reason?: string;
}

/** 运行 / 保存前的宏代码校验（纯函数） */
export function validateMacroCode(code: unknown): MacroValidationResult {
  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, reason: '宏代码为空' };
  }
  if (code.length > MAX_MACRO_CODE_LENGTH) {
    return { ok: false, reason: `宏代码过长（上限 ${MAX_MACRO_CODE_LENGTH} 字符）` };
  }
  return { ok: true };
}

/** 把任意异常归一为可读字符串 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === 'string') return err;
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 把任意日志参数序列化为可跨线程传递的字符串（循环引用/函数等做降级） */
export function serializeLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  const t = typeof arg;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(arg);
  if (t === 'symbol') return arg.toString();
  if (t === 'function') {
    const name = (arg as { name?: string }).name;
    return `[Function ${name || 'anonymous'}]`;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
