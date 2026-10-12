/**
 * 单位换算（T1.5 导出器）。
 *
 * 与 `src/parser/docxParser.ts` 的约定**精确互逆**：
 * 解析器用 `tw2emu(v) = Math.round(Number(v) * 635)` 把 twips 存成 EMU，
 * 因此导出时除以 635 还原 twips 写回 OOXML 属性（`w:ind` / `w:spacing` 的
 * before/after / `w:pgSz` / `w:pgMar` / `w:tblGrid` / `w:tcW` / `w:trHeight` …）。
 *
 * 下列字段**不**经此换算（解析器即原值存储，导出须原样写回，否则失真）：
 *   - 字号 `sz`（half-point，原值，如 44 = 22pt）
 *   - `w:spacing/@w:line`（解析器 `Number(lineRaw)` 原值，未 ×635）
 *   - drawing `extent` 的 cx/cy（已是 EMU，原值）
 */

/** twips（二十分之一磅）→ EMU 的系数（解析器所用，导出即其逆） */
export const EMU_PER_TWIP = 635;

/** EMU → twips（解析器 `tw2emu` 的逆运算）。 */
export function emuToTwips(emu: number | undefined): number | undefined {
  if (emu === undefined || emu === null) return undefined;
  return Math.round(emu / EMU_PER_TWIP);
}
