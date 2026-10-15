/**
 * 宏运行器（主线程侧）：创建 Web Worker 沙箱、桥接 jk API、施加超时。
 *
 * - 每次运行创建「全新」Worker（干净状态，便于 terminate 收尾）；
 * - Worker 内的 `jk.*` 调用回主线程由 `MacroHost` 执行（见 macroHost.ts）；
 * - 超时（默认 `MACRO_TIMEOUT_MS`）到点强制 terminate，防宏死循环卡住 UI；
 * - 崩溃 / 语法错误 / 运行时错误统一归一为 `MacroRunResult`。
 */
import { getMacroHost } from './macroHost';
import { MACRO_TIMEOUT_MS, describeError } from './macroApi';
import type {
  MacroHost,
  MacroLogEntry,
  MacroRunResult,
  WorkerInMessage,
  WorkerOutMessage,
} from './macroProtocol';

export interface RunMacroOptions {
  /** 覆盖默认 jk 宿主（默认取注册的全局宿主 = Writer） */
  host?: MacroHost;
  /** 超时（毫秒），默认 `MACRO_TIMEOUT_MS` */
  timeoutMs?: number;
  /** 日志实时回调（用于 UI 边运行边刷新） */
  onLog?: (entry: MacroLogEntry) => void;
}

/** jk 方法名 → MacroHost 方法名 映射（白名单，未列出的一律拒绝） */
const HOST_METHOD_MAP: Record<string, keyof MacroHost> = {
  getText: 'getText',
  setText: 'setText',
  appendText: 'appendText',
  findReplace: 'findReplace',
  getSelection: 'getSelection',
  replaceSelection: 'replaceSelection',
  applyOps: 'applyOps',
  'sheet.getCellText': 'sheetGetCellText',
  'sheet.setValues': 'sheetSetValues',
};

/**
 * 在 Worker 沙箱中运行宏代码。
 *
 * @param code 用户宏源码
 * @param opts 选项（宿主 / 超时 / 日志回调）
 * @returns 运行结果（含日志、返回值、错误、耗时）；本函数**不抛出**，失败也返回 ok=false
 */
export async function runMacro(code: string, opts?: RunMacroOptions): Promise<MacroRunResult> {
  const timeoutMs = opts?.timeoutMs ?? MACRO_TIMEOUT_MS;
  const host = opts?.host ?? getMacroHost();
  const logs: MacroLogEntry[] = [];
  const started = Date.now();

  let worker: Worker;
  try {
    worker = new Worker(new URL('./macroWorker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    return { ok: false, logs, error: `无法创建宏沙箱：${describeError(err)}`, durationMs: 0 };
  }

  return new Promise<MacroRunResult>((resolve) => {
    let settled = false;

    /** 收尾：去重、清定时器、终止 Worker、resolve */
    const finish = (result: MacroRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        /* 忽略终止异常 */
      }
      resolve(result);
    };

    /** 处理 Worker → 主线程的 jk API 请求：转发到宿主并把结果回传 Worker */
    const handleApiCall = async (id: number, method: string, args: unknown[]): Promise<void> => {
      const hostKey = HOST_METHOD_MAP[method];
      const fn = hostKey
        ? (host as unknown as Record<string, (...a: unknown[]) => unknown>)[hostKey]
        : undefined;
      if (!hostKey || typeof fn !== 'function') {
        worker.postMessage({
          type: 'api-result',
          id,
          ok: false,
          error: `不支持的 jk API：${method}`,
        } satisfies WorkerInMessage);
        return;
      }
      try {
        const value = await fn.call(host, ...args);
        worker.postMessage({ type: 'api-result', id, ok: true, value } satisfies WorkerInMessage);
      } catch (err) {
        worker.postMessage({
          type: 'api-result',
          id,
          ok: false,
          error: describeError(err),
        } satisfies WorkerInMessage);
      }
    };

    const onMessage = (event: MessageEvent): void => {
      const msg = event.data as WorkerOutMessage;
      switch (msg.type) {
        case 'log': {
          const entry: MacroLogEntry = { level: msg.level, text: msg.args.join(' ') };
          logs.push(entry);
          opts?.onLog?.(entry);
          break;
        }
        case 'api': {
          void handleApiCall(msg.id, msg.method, msg.args);
          break;
        }
        case 'done': {
          finish({ ok: true, logs, result: msg.result, durationMs: Date.now() - started });
          break;
        }
        case 'error': {
          finish({ ok: false, logs, error: msg.message, durationMs: Date.now() - started });
          break;
        }
        default:
          break;
      }
    };

    const onError = (event: ErrorEvent): void => {
      finish({
        ok: false,
        logs,
        error: `宏沙箱异常退出：${event.message || '未知错误'}`,
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        logs,
        error: `宏执行超时（> ${timeoutMs}ms）已终止`,
        durationMs: Date.now() - started,
      });
    }, timeoutMs);

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ type: 'run', code } satisfies WorkerInMessage);
  });
}
