/**
 * 目录生成 + 域插入 单测（WPS 对齐批 2）。
 */
import { describe, it, expect } from 'vitest';
import { buildTocEntries, buildTocContent } from './tocBuilder';
import { Schema } from '@tiptap/pm/model';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    text: { group: 'inline', inline: true },
    jkField: { group: 'inline', inline: true, atom: true, attrs: { instr: { default: '' }, result: { default: '' } } },
  },
});

function makeDoc(blocks: { type: 'heading' | 'paragraph'; level?: number; text: string }[]) {
  return schema.node(
    'doc',
    null,
    blocks.map((b) =>
      b.type === 'heading'
        ? schema.node('heading', { level: b.level ?? 1 }, b.text ? [schema.text(b.text)] : [])
        : schema.node('paragraph', null, b.text ? [schema.text(b.text)] : []),
    ),
  );
}

describe('buildTocEntries', () => {
  it('按文档顺序提取标题层级，跳过正文与空标题', () => {
    const doc = makeDoc([
      { type: 'heading', level: 1, text: '第一章' },
      { type: 'paragraph', text: '正文正文' },
      { type: 'heading', level: 2, text: '1.1 小节' },
      { type: 'heading', level: 2, text: '  ' },
      { type: 'heading', level: 3, text: '1.1.1 深入' },
    ]);
    const entries = buildTocEntries(doc);
    expect(entries).toEqual([
      { level: 1, text: '第一章' },
      { level: 2, text: '1.1 小节' },
      { level: 3, text: '1.1.1 深入' },
    ]);
  });

  it('无标题文档返回空', () => {
    expect(buildTocEntries(makeDoc([{ type: 'paragraph', text: '纯正文' }]))).toHaveLength(0);
  });
});

describe('buildTocContent', () => {
  it('生成目录标题 + 缩进条目 + TOC 域', () => {
    const content = buildTocContent(buildTocEntries(makeDoc([
      { type: 'heading', level: 1, text: '第一章' },
      { type: 'heading', level: 2, text: '小节A' },
    ]))) as { type: string; attrs?: { level?: number }; content?: { text?: string }[] }[];
    expect(content[0].type).toBe('heading');
    expect(content[0].attrs?.level).toBe(1);
    // 目录标题 + 2 条目 + TOC 域 = 4
    expect(content).toHaveLength(4);
    expect(content[3].type).toBe('jkField');
    expect(content[1].content?.[0].text).toBe('第一章');
    // 二级条目带缩进（全角空格前缀）
    expect(content[2].content?.[0].text?.startsWith('　')).toBe(true);
  });

  it('空目录不生成内容', () => {
    expect(buildTocContent([])).toEqual([]);
  });
});
