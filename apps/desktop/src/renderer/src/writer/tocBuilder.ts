/**
 * 目录生成（WPS 对齐批 2）——扫描文档标题层级，生成目录内容。
 *
 * 纯函数：从 ProseMirror doc 提取 heading 层级 → 目录条目；插入内容为
 * 「目录」标题 + 缩进大纲条目 + 末尾 TOC 域节点（Word/WPS 打开后可重算页码）。
 * 不伪造页码（编辑器无法预知排版页码），与 Word「插入目录域 + 静态条目」同构。
 */
import type { Node as PMNode } from '@tiptap/pm/model';

export interface TocEntry {
  /** heading 级别（1-6） */
  level: number;
  text: string;
}

/** 扫描 doc 的全部标题（按文档顺序） */
export function buildTocEntries(doc: PMNode): TocEntry[] {
  const entries: TocEntry[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (text) entries.push({ level: (node.attrs.level as number) ?? 1, text });
    }
  });
  return entries;
}

/**
 * 目录 → TipTap insertContent 内容数组。
 * 结构：目录标题段 → 每级缩进条目段 → TOC 域（jkField，占位提示重算）。
 */
export function buildTocContent(entries: TocEntry[]): unknown[] {
  if (!entries.length) return [];
  const content: unknown[] = [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: '目录' }],
    },
  ];
  for (const e of entries) {
    content.push({
      type: 'paragraph',
      attrs: {},
      // 用缩进表达层级（TipTap paragraph 无原生 outline 缩进属性，用 textIndent 近似）
      content: [
        {
          type: 'text',
          text: `${'　'.repeat(Math.max(0, e.level - 1))}${e.text}`,
        },
      ],
    });
  }
  // TOC 域：Word/WPS 打开后可右键「更新域」得真实页码目录
  content.push({
    type: 'jkField',
    attrs: { instr: 'TOC \\o "1-3" \\h \\z \\u', result: '目录（打开后右键更新域可得页码）' },
  });
  return content;
}
