/**
 * LLM 输出的 JSON 容错提取（T4.3/T4.5 共用）。
 */

/** 剥掉 ```json 围栏与首尾杂质后取第一个平衡的 JSON 对象 */
export function extractJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error('输出中未找到 JSON 对象');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('JSON 对象不完整');
}
