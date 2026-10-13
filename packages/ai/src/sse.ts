/**
 * 流解析（T4.1）：SSE（text/event-stream）与 NDJSON 两种分帧。
 *
 * 设计为通用异步生成器：上游 Response.body（ReadableStream）→
 * 逐帧产出「data: 后的负载」（SSE）或「每行 JSON」（NDJSON）。
 * 空行/注释行（`:` 开头）跳过；`data: [DONE]` 由调用方判断。
 */
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

async function* lines(body: ReadableStream<Uint8Array> | WebReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        yield line;
      }
    }
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/** SSE：产出每个 data: 帧的负载字符串 */
export async function* sseData(body: ReadableStream<Uint8Array> | WebReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of lines(body)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;
    if (!trimmed.startsWith('data:')) continue;
    yield trimmed.slice(5).trim();
  }
}

/** NDJSON：产出每一行（跳过空行） */
export async function* ndjson(body: ReadableStream<Uint8Array> | WebReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of lines(body)) {
    const trimmed = line.trim();
    if (trimmed) yield trimmed;
  }
}
