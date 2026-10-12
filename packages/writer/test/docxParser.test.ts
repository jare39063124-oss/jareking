/**
 * T1.2 docx 解析器单测。
 *
 * 覆盖 8 类验收用例（构造最小合法 docx 夹具，断言模型结构与预期一致，
 * 解析全程不抛异常）。每个用例均经由 parseDocx 消费 JSZip 构造的 Uint8Array。
 */

import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDocx, parseDocxFile } from '../src/parser/docxParser.js';
import type { Block, Inline, Paragraph, Run, Table, Image, Hyperlink } from '../src/model/document.js';
import {
  buildDocx,
  DEFAULT_STYLES,
  hyperlinkRels,
  imageRels,
  DRAWING,
} from './fixtures.js';

function paragraph(body: string): Promise<Uint8Array> {
  return buildDocx({ body });
}

function firstParagraph(doc: { body: Block[] }): Paragraph {
  const p = doc.body.find((b) => b.type === 'paragraph') as Paragraph | undefined;
  if (!p) throw new Error('expected a paragraph');
  return p;
}

describe('T1.2 docx 解析器', () => {
  it('1. 纯文本段落 → 1 个 Paragraph，runs 含正确 text', async () => {
    const buf = await paragraph('<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>');
    const doc = await parseDocx(buf);
    expect(doc.body.length).toBe(1);
    const p = firstParagraph(doc);
    expect(p.type).toBe('paragraph');
    const run = p.runs[0] as Run;
    expect(run.type).toBe('run');
    expect(run.text).toBe('Hello world');
  });

  it('2. 粗体 + 斜体 + 下划线 run → rPr 字段正确', async () => {
    const buf = await paragraph(
      '<w:p><w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/></w:rPr><w:t>Bold</w:t></w:r></w:p>',
    );
    const doc = await parseDocx(buf);
    const run = firstParagraph(doc).runs[0] as Run;
    expect(run.rPr?.bold).toBe(true);
    expect(run.rPr?.italic).toBe(true);
    expect(run.rPr?.underline).toBe('single');
  });

  it('3. 字号 sz=44 → 半磅值 44（=22pt）', async () => {
    const buf = await paragraph(
      '<w:p><w:r><w:rPr><w:sz w:val="44"/></w:rPr><w:t>Hi</w:t></w:r></w:p>',
    );
    const doc = await parseDocx(buf);
    const run = firstParagraph(doc).runs[0] as Run;
    // 模型 size 为 half-point：44 half-point = 22pt
    expect(run.rPr?.size).toBe(44);
  });

  it('4. 标题样式 Heading1 → outlineLvl 正确且 styleDefs 存在且 basedOn=Normal', async () => {
    const buf = await buildDocx({
      body: '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>',
      styles: DEFAULT_STYLES,
    });
    const doc = await parseDocx(buf);
    const p = firstParagraph(doc);
    expect(p.pPr?.styleId).toBe('Heading1');
    expect(p.pPr?.outlineLvl).toBe(0);

    const heading = doc.styleDefs.styles.find((s) => s.styleId === 'Heading1');
    expect(heading).toBeDefined();
    expect(heading?.styleType).toBe('paragraph');
    expect(heading?.basedOn).toBe('Normal');

    const normal = doc.styleDefs.styles.find((s) => s.styleId === 'Normal');
    expect(normal?.isDefault).toBe(true);
  });

  it('5. 2x2 表格 → Table.rows 长度 2，每行 2 个 cell', async () => {
    const buf = await paragraph(
      `<w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>`,
    );
    const doc = await parseDocx(buf);
    const tbl = doc.body[0] as Table;
    expect(tbl.type).toBe('table');
    expect(tbl.rows.length).toBe(2);
    expect(tbl.rows[0].cells.length).toBe(2);
    expect(tbl.rows[1].cells.length).toBe(2);
    // 单元格内容递归解析为段落
    const cellText = (tbl.rows[0].cells[0].blocks[0] as Paragraph).runs[0] as Run;
    expect(cellText.text).toBe('A1');
  });

  it('6. 超链接 → Hyperlink 且 URL 经 rels 解析正确', async () => {
    const buf = await buildDocx({
      body: '<w:p><w:hyperlink r:id="rId1"><w:r><w:t>click</w:t></w:r></w:hyperlink></w:p>',
      rels: hyperlinkRels('https://example.com', 'rId1'),
    });
    const doc = await parseDocx(buf);
    const p = firstParagraph(doc);
    const hyper = p.runs.find((r) => r.type === 'hyperlink') as Hyperlink | undefined;
    expect(hyper).toBeDefined();
    expect(hyper?.relId).toBe('rId1');
    const rel = doc.relationships.find((x) => x.id === 'rId1');
    expect(rel).toBeDefined();
    expect(rel?.target).toBe('https://example.com');
    expect(rel?.targetMode).toBe('external');
    // 链接文本保留在 runs 内
    const inner = (hyper as Hyperlink).runs[0] as Run;
    expect(inner.text).toBe('click');
  });

  it('7. 图片 → Image 节点且 embed rId 保留', async () => {
    const buf = await buildDocx({
      body: `<w:p><w:r>${DRAWING('rId7')}</w:r></w:p>`,
      rels: imageRels('rId7'),
    });
    const doc = await parseDocx(buf);
    const p = firstParagraph(doc);
    const img = p.runs.find((r) => r.type === 'image') as Image | undefined;
    expect(img).toBeDefined();
    expect(img?.type).toBe('image');
    expect(img?.embed).toBe('rId7');
    // extent 已是 EMU，原值保留
    expect(img?.width).toBe(914400);
    expect(img?.height).toBe(457200);
    expect(img?.alt).toBe('a cat');
    // 图片资源在 relationships 中可追溯
    expect(doc.relationships.find((x) => x.id === 'rId7')?.target).toBe('media/image1.png');
  });

  it('8. 未知元素（smartArt）→ 不抛错，写入 UnsupportedFeature 且结构完整', async () => {
    const buf = await paragraph(
      '<w:p><w:r><w:t>before</w:t></w:r></w:p>' +
        '<w:smartArt><w:something/></w:smartArt>' +
        '<w:p><w:r><w:t>after</w:t></w:r></w:p>',
    );
    const doc = await parseDocx(buf);
    // 不抛异常，且两个已知段落完整保留
    expect(doc.body.length).toBe(2);
    const texts = (doc.body as Paragraph[]).map((b) => (b.runs[0] as Run).text);
    expect(texts).toEqual(['before', 'after']);
    // 降级特性被记录
    expect(doc.fidelity.features.length).toBeGreaterThan(0);
    expect(doc.fidelity.features.some((f) => f.kind === 'smartart')).toBe(true);
    // 原始未知块被保留于兜底数据，避免 round-trip 丢数据
    expect(doc.data?.__unparsedBlocks).toBeDefined();
    const kinds = (doc.data?.__unparsedBlocks as any[]).map((b) => b.tag);
    expect(kinds).toContain('smartArt');
  });

  it('9. parseDocxFile 可从文件路径解析（Node 环境）', async () => {
    const buf = await paragraph('<w:p><w:r><w:t>from file</w:t></w:r></w:p>');
    const dir = await mkdtemp(join(tmpdir(), 'jkdocx-'));
    const path = join(dir, 'sample.docx');
    await writeFile(path, buf);
    const doc = await parseDocxFile(path);
    const p = firstParagraph(doc);
    expect((p.runs[0] as Run).text).toBe('from file');
  });
});
