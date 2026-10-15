/// <reference lib="webworker" />
/**
 * 宏沙箱 Worker：在独立线程中执行用户 JavaScript 宏。
 *
 * 隔离策略（如实说明，非「硬沙箱」）：
 *  - 独立线程：宏崩溃 / 死循环不会冻结主线程 UI（崩溃隔离 + 超时由主线程 terminate 兜底）；
 *  - 无 DOM：Worker 线程本身没有 document / window（宏无法触碰界面）；
 *  - 无 Node：宏运行在 contextIsolation 渲染进程内的 Worker，没有 require / process 直接访问；
 *  - 受限 API：宏只能通过注入的 `jk` 白名单对象触达文档（回主线程执行）；
 *  - 纵深防御：以同名形参把一批危险全局（fetch / WebSocket / importScripts / globalThis …）
 *    注入为 undefined，**尽力**削弱宏对网络与全局对象的直接访问。
 *
 * ⚠️ 局限（诚实声明）：Worker 与宿主同源，`Function` 构造器等仍可能被绕过，
 *    因此这**不是**针对恶意第三方代码的强安全沙箱；其定位是「用户为自己编写的宏」
 *    提供一个「防手滑、防失控（死循环/崩溃）」的执行环境，而非隔离不可信代码。
 */
import type { WorkerInMessage, WorkerOutMessage } from './macroProtocol';
import { describeError, serializeLogArg } from './macroApi';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** 向主线程发送消息 */
function post(msg: WorkerOutMessage): void {
  ctx.postMessage(msg);
}

/** 待回填的 jk API 调用（id → resolve / reject） */
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let apiSeq = 0;

/** 向主线程发起一次 jk API 调用（跨线程请求 / 响应） */
function callHost(method: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++apiSeq;
    pending.set(id, { resolve, reject });
    post({ type: 'api', id, method, args });
  });
}

/** 受限 console：仅转发到主线程日志面板 */
const restrictedConsole = {
  log: (...args: unknown[]) => post({ type: 'log', level: 'log', args: args.map(serializeLogArg) }),
  info: (...args: unknown[]) => post({ type: 'log', level: 'info', args: args.map(serializeLogArg) }),
  warn: (...args: unknown[]) => post({ type: 'log', level: 'warn', args: args.map(serializeLogArg) }),
  error: (...args: unknown[]) => post({ type: 'log', level: 'error', args: args.map(serializeLogArg) }),
  debug: (...args: unknown[]) => post({ type: 'log', level: 'debug', args: args.map(serializeLogArg) }),
};

/** 构造 jk 白名单 API：全部返回 Promise（跨线程异步） */
function createJk(): Record<string, unknown> {
  return {
    log: (...args: unknown[]) => post({ type: 'log', level: 'log', args: args.map(serializeLogArg) }),
    getText: () => callHost('getText', []),
    setText: (t: unknown) => callHost('setText', [t]),
    appendText: (t: unknown) => callHost('appendText', [t]),
    findReplace: (a: unknown, b: unknown, opts?: unknown) => callHost('findReplace', [a, b, opts]),
    getSelection: () => callHost('getSelection', []),
    replaceSelection: (t: unknown) => callHost('replaceSelection', [t]),
    applyOps: (ops: unknown) => callHost('applyOps', [ops]),
    sheet: {
      getCellText: (a1: unknown) => callHost('sheet.getCellText', [a1]),
      setValues: (a1: unknown, matrix: unknown) => callHost('sheet.setValues', [a1, matrix]),
    },
  };
}

/**
 * 需在宏作用域内影子化的危险全局（以同名形参注入 undefined）。
 * 注意：**不包含** `eval`——严格模式下以 `eval` 作形参名会触发语法错误。
 */
const SHADOWED_GLOBALS = [
  'self',
  'globalThis',
  'window',
  'document',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'postMessage',
  'indexedDB',
  'caches',
  'navigator',
  'location',
  'Worker',
  'SharedWorker',
  'MessageChannel',
  'MessagePort',
  'BroadcastChannel',
  'FileReader',
  'Request',
  'Response',
  'process',
  'require',
  'module',
  'exports',
  'global',
  'Buffer',
  'Function',
];

/**
 * 用受限上下文编译用户代码。
 * 形参顺序：`jk` / `console` / …影子全局；函数体为 async IIFE（支持顶层 await 与 return）。
 *
 * 说明：此处是**沙箱 Worker 内**的动态求值（宏的本质就是执行用户脚本）；
 *      主进程绝不 eval / Function 执行宏。
 */
function compileUserCode(code: string): (...args: unknown[]) => Promise<unknown> {
  const params = ['jk', 'console', ...SHADOWED_GLOBALS];
  const body = `"use strict";\nreturn (async () => {\n${code}\n})();`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...params, body) as (...args: unknown[]) => Promise<unknown>;
  return fn;
}

/** 归一化宏返回值，确保可结构化克隆（否则降级为字符串） */
function sanitizeResult(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'symbol' || t === 'function') return String(value);
  try {
    JSON.stringify(value); // 探测可序列化（含循环引用会抛错）
    return value;
  } catch {
    return String(value);
  }
}

/** 执行宏：编译 → 以受限上下文调用 → 回传结果 / 错误 */
async function runMacro(code: string): Promise<void> {
  try {
    const invoke = compileUserCode(code);
    const jk = createJk();
    // jk → console → 影子全局（全部 undefined）：顺序需与 compileUserCode 的形参一致
    const args: unknown[] = [jk, restrictedConsole, ...SHADOWED_GLOBALS.map(() => undefined)];
    const result = await invoke(...args);
    post({ type: 'done', result: sanitizeResult(result) });
  } catch (err) {
    post({ type: 'error', message: describeError(err) });
  }
}

ctx.onmessage = (event: MessageEvent) => {
  const msg = event.data as WorkerInMessage;
  if (msg.type === 'api-result') {
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error ?? 'jk API 调用失败'));
    }
    return;
  }
  if (msg.type === 'run') {
    void runMacro(msg.code);
  }
};
