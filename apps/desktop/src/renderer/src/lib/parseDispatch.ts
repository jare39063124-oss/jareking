/**
 * 解析分发（纯函数，Worker 与单测共用）。
 *
 * 把「根据类型选择解析器」的逻辑集中在此，便于：
 *  - worker 直接调用（在 Worker 线程内跑，主线程不冻结）；
 *  - 单测直接调用（无需启动 Worker，验证分发与错误映射）。
 *
 * #46-C（2026-10-15）：Sheet/PPT 解析迁移到 Web Worker 后，此处是 Worker 内部
 * 真正执行解析的入口；错误被归一为 { ok:false, error }，不会让 Worker 抛飞。
 */
import { parseXlsx, type JkWorkbook } from '@jareking/sheet';
import { parsePptx, type JkPresentation } from '@jareking/presentation';

export type ParseKind = 'xlsx' | 'pptx';

export type ParseSuccess = { ok: true; model: JkWorkbook | JkPresentation };
export type ParseFailure = { ok: false; error: string };
export type ParseResult = ParseSuccess | ParseFailure;

/** 在「当前线程」执行解析（Worker 内调用；单测也可直接调用） */
export async function runParse(
  kind: ParseKind,
  buffer: Uint8Array | ArrayBuffer,
): Promise<ParseResult> {
  try {
    const u8 = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    if (kind === 'xlsx') {
      const model = await parseXlsx(u8);
      return { ok: true, model };
    }
    if (kind === 'pptx') {
      const model = await parsePptx(u8);
      return { ok: true, model };
    }
    return { ok: false, error: `不支持的解析类型：${String(kind)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
