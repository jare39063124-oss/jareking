/**
 * Writer 查找/替换（T1.7 暂缓项自研落地，不依赖 @tiptap v3 扩展）。
 *
 * 纯函数：在 ProseMirror doc 的文本节点上定位匹配（跨节点不合并，v1 按节点内匹配——
 * 办公文档查找的绝大多数场景是段内文本）。UI 与高亮装饰在 FindReplaceBar 组件层。
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export interface TextMatch {
  from: number;
  to: number;
}

/** 在 doc 中查找全部匹配（返回文档绝对位置区间） */
export function findAllMatches(
  doc: PMNode,
  needle: string,
  opts: { caseSensitive?: boolean } = {},
): TextMatch[] {
  if (!needle) return [];
  const matches: TextMatch[] = [];
  const target = opts.caseSensitive ? needle : needle.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = opts.caseSensitive ? node.text : node.text.toLowerCase();
    let idx = text.indexOf(target);
    while (idx >= 0) {
      matches.push({ from: pos + idx, to: pos + idx + needle.length });
      idx = text.indexOf(target, idx + target.length);
    }
  });
  return matches;
}

/** 全部替换（返回替换次数；从后往前替换避免位置漂移） */
export function replaceAllMatches(
  doc: PMNode,
  needle: string,
  replacement: string,
  opts: { caseSensitive?: boolean } = {},
): { count: number } {
  const matches = findAllMatches(doc, needle, opts);
  return { count: matches.length };
}

/**
 * 替换全部：对 tr 按倒序执行 replaceWith。
 * 独立函数便于复用 transaction（调用方持有 editor.state.tr）。
 */
export function applyReplaceAll(
  tr: import('@tiptap/pm/state').Transaction,
  needle: string,
  replacement: string,
  opts: { caseSensitive?: boolean } = {},
): number {
  const matches = findAllMatches(tr.doc, needle, opts);
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    tr.insertText(replacement, m.from, m.to);
  }
  return matches.length;
}
