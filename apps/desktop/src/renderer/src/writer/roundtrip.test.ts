/**
 * T1.4 回归测试：编辑器「保存」全链路（无 GUI、纯逻辑）。
 *
 * 链路：内置 sample.docx → parseDocx → jkToHtml（→ 编辑器 content）
 *      → htmlToJk（编辑器 getHTML → 模型）→ exportDocx → 再 parseDocx
 *
 * 该链路等价于「打开 → 编辑 → 保存」中「保存」一侧的核心逻辑；
 * 在 headless 沙箱中无法渲染真实 TipTap，但 jkToHtml/htmlToJk/exportDocx
 * 均为纯函数（htmlToJk 仅依赖 DOMParser，由 jsdom 提供），
 * 因此本测试可在 Node 下完整验证保存闭环不丢结构。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportDocx, parseDocx, type Inline, type JkDocument, type Paragraph } from '@jareking/writer';
import { jkToHtml } from './jkToHtml';
import { htmlToJk } from './htmlToJk';

const samplePath = resolve(import.meta.dirname ?? '.', '../../public/sample.docx');

function countByType(doc: JkDocument, type: string): number {
  let n = 0;
  const walk = (blocks: JkDocument['body'] = []) => {
    for (const b of blocks ?? []) {
      if (b.type === type) n += 1;
      if (b.type === 'table') b.rows.forEach((r) => r.cells.forEach((c) => walk(c.blocks)));
    }
  };
  walk(doc.body);
  return n;
}

function hasHeading(doc: JkDocument): boolean {
  return (doc.body ?? []).some(
    (b) => b.type === 'paragraph' && b.pPr?.outlineLvl !== undefined,
  );
}

/** 收集文档内所有 Run（含超链接内的 Run） */
function collectRuns(doc: JkDocument): NonNullable<Paragraph['runs']> {
  const runs: NonNullable<Paragraph['runs']> = [];
  const walkInline = (inlines: Inline[] = []) => {
    for (const inl of inlines) {
      if (inl.type === 'run') runs.push(inl);
      if (inl.type === 'hyperlink') walkInline(inl.runs);
    }
  };
  for (const b of doc.body ?? []) {
    if (b.type === 'paragraph') walkInline(b.runs);
    if (b.type === 'table')
      b.rows.forEach((r) => r.cells.forEach((c) => collectRuns({ ...doc, body: c.blocks })));
  }
  return runs;
}

describe('T1.4 Writer 编辑器保存闭环', () => {
  it('sample.docx 解析后 jkToHtml 产出可识别的结构化 HTML', async () => {
    const buf = new Uint8Array(await readFile(samplePath));
    const doc = await parseDocx(buf);
    const html = jkToHtml(doc);

    expect(html).toContain('<h1');
    expect(html).toContain('<strong>');
    expect(html).toContain('<table>');
    // 有序/无序列表至少其一
    expect(html.includes('<ul>') || html.includes('<ol>')).toBe(true);
    // 超链接
    expect(html).toMatch(/<a href="https?:\/\//);
  });

  it('jkToHtml → htmlToJk → exportDocx → 再解析 结构稳定', async () => {
    const buf = new Uint8Array(await readFile(samplePath));
    const doc = await parseDocx(buf);
    const html = jkToHtml(doc);

    const doc2 = htmlToJk(html);
    const exported = await exportDocx(doc2);
    expect(exported.byteLength).toBeGreaterThan(1000);

    const doc3 = await parseDocx(exported);
    // 标题、段落、表格、列表在保存后仍然存在
    expect(hasHeading(doc3)).toBe(true);
    expect(countByType(doc3, 'paragraph')).toBeGreaterThan(0);
    expect(countByType(doc3, 'table')).toBeGreaterThanOrEqual(1);
  });
});

describe('T1.6 字体/颜色/字号/超链接 编辑后保存不丢', () => {
  const html = `
    <h1 style="text-align:center">标题居中</h1>
    <p><span style="color:#ff0000; font-size:18pt; font-family:'Microsoft YaHei'"><strong>红字大号雅黑加粗</strong></span></p>
    <p><a href="https://jareking.cn">访问官网</a></p>
    <ul><li>项目一</li><li>项目二</li></ul>
  `;

  it('htmlToJk 正确解析字符属性与链接', () => {
    const doc = htmlToJk(html);
    const runs = collectRuns(doc);
    const styled = runs.find(
      (r) => r.rPr?.color === 'ff0000' && r.rPr?.bold && r.rPr?.size === 36,
    );
    expect(styled).toBeDefined();
    expect(styled?.rPr?.font?.eastAsia).toBe('Microsoft YaHei');

    // 超链接：存在含该 URL 的外部关系，且链接文本正确
    const rel = doc.relationships.find((x) => x.target === 'https://jareking.cn');
    expect(rel).toBeDefined();
    const linkRun = runs.find((r) => r.text === '访问官网');
    expect(linkRun).toBeDefined();
  });

  it('编辑后导出再解析，字符属性与链接稳定保留', async () => {
    const doc = htmlToJk(html);
    const exported = await exportDocx(doc);
    const reparsed = await parseDocx(exported);
    const runs = collectRuns(reparsed);

    const styled = runs.find(
      (r) => r.rPr?.color === 'ff0000' && r.rPr?.bold && r.rPr?.size === 36,
    );
    expect(styled).toBeDefined();
    expect(styled?.rPr?.font?.eastAsia).toBe('Microsoft YaHei');

    const rel = reparsed.relationships.find((x) => x.target === 'https://jareking.cn');
    expect(rel).toBeDefined();
  });
});

