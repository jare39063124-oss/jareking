/// <reference lib="webworker" />
/**
 * 解析 Worker：在独立线程跑 Sheet/PPT 解析，主线程（UI）不被阻塞，
 * 且 Worker 内解析异常/崩溃不会拖垮渲染进程（崩溃隔离）。
 *
 * 协议：主线程 postMessage({ kind, buffer })（buffer 为 transferable ArrayBuffer）；
 * Worker 回 postMessage(ParseResult)。ParseResult 由 parseDispatch.runParse 归一。
 */
import { runParse, type ParseKind } from './parseDispatch';

const ctx = self as unknown as Worker;

ctx.onmessage = async (e: MessageEvent) => {
  const data = e.data as { kind: ParseKind; buffer: ArrayBuffer };
  const result = await runParse(data.kind, data.buffer);
  ctx.postMessage(result);
};
