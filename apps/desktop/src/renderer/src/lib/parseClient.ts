/**
 * 解析客户端：主线程侧调用入口，封装 Web Worker 通信。
 *
 * - 通过 `new Worker(new URL('./parse.worker.ts', import.meta.url))` 创建 Worker；
 * - 把文件字节以 transferable ArrayBuffer 转移给 Worker（零拷贝，原 buffer 被 neuter，
 *   调用方需确保解析后不再使用该 buffer——两个 Editor 的 onFileChange 均满足）；
 * - 带超时（默认 10 分钟）：Worker 假死/卡死时 reject 并重建 Worker，避免 UI 永久等待；
 * - 错误归一为 throw，沿用原 Editor 的 try/catch + toast 语义。
 *
 * #46-C（2026-10-15）：Sheet（exceljs 全量 load）/PPT（fflate 流式解压）解析迁移到
 * Worker 后，主线程不再被大文件解析冻结，且解析崩溃被隔离在 Worker 内。
 */
import type { JkWorkbook } from '@jareking/sheet';
import type { JkPresentation } from '@jareking/presentation';
import type { ParseKind } from './parseDispatch';

/** 解析超时上限：防止 Worker 假死导致 UI 永久卡在加载态 */
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./parse.worker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return worker;
}

function resetWorker(): void {
  try {
    worker?.terminate();
  } catch {
    /* ignore */
  }
  worker = null;
}

/** 解析类型 → 对应模型（xlsx→JkWorkbook，pptx→JkPresentation），供调用方精确收窄返回值 */
export type ParseKindModel<K extends ParseKind> = K extends 'xlsx' ? JkWorkbook : JkPresentation;

/**
 * 在 Worker 中解析文件，返回模型。
 * 注意：传入的 buffer 会被转移（neutered），调用方解析后不应再读取它。
 * 返回类型随 kind 收窄（'xlsx' → JkWorkbook，'pptx' → JkPresentation），
 * 调用方无需再对返回值做联合类型收窄 / 断言。
 */
export async function parseInWorker<K extends ParseKind>(
  kind: K,
  buf: Uint8Array,
): Promise<ParseKindModel<K>> {
  const w = getWorker();
  return new Promise<ParseKindModel<K>>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMessage);
      w.removeEventListener('error', onError);
    };

    const onMessage = (e: MessageEvent) => {
      if (settled) return;
      const data = e.data as { ok: boolean; model?: JkWorkbook | JkPresentation; error?: string };
      if (data && data.ok) {
        settled = true;
        cleanup();
        resolve(data.model as ParseKindModel<K>);
      } else {
        settled = true;
        cleanup();
        resetWorker(); // 解析失败也重建，保证下次可用
        reject(new Error(data?.error ?? '解析失败'));
      }
    };

    const onError = (e: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      resetWorker();
      reject(new Error(e.message || '解析进程异常退出'));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resetWorker();
      reject(new Error('解析超时（可能文件过大或已损坏）'));
    }, WORKER_TIMEOUT_MS);

    // 转移底层 ArrayBuffer（零拷贝）。buf 来自 file.arrayBuffer()，其 buffer 即完整文件，
    // 解析后不再被主线程使用，neuter 安全。
    const ab = buf.buffer;
    w.addEventListener('message', onMessage);
    w.addEventListener('error', onError);
    w.postMessage({ kind, buffer: ab }, [ab]);
  });
}
