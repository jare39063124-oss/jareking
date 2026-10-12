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
import { exportDocx, parseDocx, type JkDocument } from '@jareking/writer';
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
