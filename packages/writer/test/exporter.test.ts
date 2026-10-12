/**
 * T1.5 docx 导出器单测（vitest）。
 *
 * 覆盖三类验收：
 *  1. round-trip 对称：parse → export → parse，关键结构字段一致
 *  2. 导出合法性：zip 可被 JSZip 打开、含必需部件、document.xml 带 w: 命名空间、可被 parser 无异常解析
 *  3. 不丢数据：含 unknown 块（smartArt）→ 解析降级 → 导出 → 再解析，unknown 块仍以兜底形式保留
 *
 * 注：沙箱无法安装 Word/WPS，无法做真实应用打开验证；
 * 故「可被 Word 打开」以「结构合法 + 命名空间正确 + 本包 parser 二次解析无异常」作为代理验证。
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

import { parseDocx } from '../src/parser/docxParser.js';
import { exportDocx } from '../src/exporter/index.js';
import type {
  Block,
  Hyperlink,
  Paragraph,
  Run,
  Table,
  Image,
} from '../src/model/document.js';
import {
  buildDocx,
  DEFAULT_STYLES,
  hyperlinkRels,
  DRAWING,
  imageRels,
} from './fixtures.js';

/* --------------------------- 测试输入构造 --------------------------- */

const ROUNDTRIP_BODY = `
  <w:p><w:r><w:t>Hello world</w:t></w:r></w:p>
  <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold text</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:hyperlink r:id="rId1"><w:r><w:t>click</w:t></w:r></w:hyperlink></w:p>
`;

/* --------------------------- 测试辅助 --------------------------- */

function paragraphs(doc: { body: Block[] }): Paragraph[] {
  return doc.body.filter((b): b is Paragraph => b.type === 'paragraph');
}

function firstBoldRun(doc: { body: Block[] }): Run | undefined {
  for (const p of paragraphs(doc)) {
    for (const r of p.runs) {
      if (r.type === 'run' && r.rPr?.bold) return r;
    }
  }
  return undefined;
}

function headingParagraph(doc: { body: Block[] }): Paragraph | undefined {
  return paragraphs(doc).find((p) => p.pPr?.styleId === 'Heading1');
}

function tableBlock(doc: { body: Block[] }): Table | undefined {
  return doc.body.find((b): b is Table => b.type === 'table');
}

function hyperlinkInline(doc: { body: Block[] }): Hyperlink | undefined {
  for (const p of paragraphs(doc)) {
    const h = p.runs.find((r) => r.type === 'hyperlink') as Hyperlink | undefined;
    if (h) return h;
  }
  return undefined;
}

/* --------------------------- 用例 --------------------------- */

describe('T1.5 docx 导出器', () => {
  it('1. round-trip 对称：解析→导出→再解析，关键结构一致', async () => {
    const input = await buildDocx({
      body: ROUNDTRIP_BODY,
      styles: DEFAULT_STYLES,
      rels: hyperlinkRels('https://example.com', 'rId1'),
    });

    const doc1 = await parseDocx(input);
    const out = await exportDocx(doc1);
    const doc2 = await parseDocx(out);

    // 块级结构数量一致
    expect(doc2.body.length).toBe(doc1.body.length);

    // 纯文本段落文本一致
    const hello1 = paragraphs(doc1)[0].runs[0] as Run;
    const hello2 = paragraphs(doc2)[0].runs[0] as Run;
    expect(hello2.text).toBe(hello1.text);

    // 粗体标记在两次解析中都为 true
    expect(firstBoldRun(doc1)?.rPr?.bold).toBe(true);
    expect(firstBoldRun(doc2)?.rPr?.bold).toBe(true);

    // 标题样式 + 大纲级别一致
    expect(headingParagraph(doc1)?.pPr?.styleId).toBe('Heading1');
    expect(headingParagraph(doc2)?.pPr?.styleId).toBe('Heading1');
    expect(headingParagraph(doc1)?.pPr?.outlineLvl).toBe(0);
    expect(headingParagraph(doc2)?.pPr?.outlineLvl).toBe(0);

    // 2x2 表格结构一致
    const t1 = tableBlock(doc1)!;
    const t2 = tableBlock(doc2)!;
    expect(t2.rows.length).toBe(2);
    expect(t2.rows[0].cells.length).toBe(2);
    expect(t2.rows[1].cells.length).toBe(2);
    const a1 = (t2.rows[0].cells[0].blocks[0] as Paragraph).runs[0] as Run;
    expect(a1.text).toBe('A1');

    // 超链接 relId / 文本 / 关系目标一致
    const h1 = hyperlinkInline(doc1)!;
    const h2 = hyperlinkInline(doc2)!;
    expect(h2.relId).toBe(h1.relId);
    expect((h2.runs[0] as Run).text).toBe('click');
    const rel2 = doc2.relationships.find((r) => r.id === 'rId1');
    expect(rel2?.target).toBe('https://example.com');
    expect(rel2?.targetMode).toBe('external');

    // Heading1 样式定义（basedOn）也保持
    const h1Style = doc2.styleDefs.styles.find((s) => s.styleId === 'Heading1');
    expect(h1Style?.basedOn).toBe('Normal');
  });

  it('2. 导出合法性：zip 部件齐全、命名空间正确、parser 可二次解析', async () => {
    const input = await buildDocx({
      body: ROUNDTRIP_BODY,
      styles: DEFAULT_STYLES,
      rels: hyperlinkRels('https://example.com', 'rId1'),
    });
    const doc = await parseDocx(input);
    const out = await exportDocx(doc);

    // 可被 JSZip 打开
    const zip = await JSZip.loadAsync(out);
    const required = [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/numbering.xml',
      'word/settings.xml',
      'word/_rels/document.xml.rels',
    ];
    for (const part of required) {
      expect(zip.file(part), `缺少部件 ${part}`).toBeTruthy();
    }

    // document.xml 含 w: 命名空间声明（Word/WPS 可打开的前提）
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main');
    expect(docXml).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships');

    // 可被本包 parser 无异常解析
    const reparsed = await parseDocx(out);
    expect(reparsed.body.length).toBeGreaterThan(0);
  });

  it('3. 不丢数据：含 unknown 块（smartArt）→ 导出 → 再解析，unknown 仍以兜底保留', async () => {
    const input = await buildDocx({
      body:
        '<w:p><w:r><w:t>before</w:t></w:r></w:p>' +
        '<w:smartArt><w:something/></w:smartArt>' +
        '<w:p><w:r><w:t>after</w:t></w:r></w:p>',
    });
    const doc1 = await parseDocx(input);
    // 原始解析：两个已知段落 + 一条降级记录 + unparsed 兜底
    expect(paragraphs(doc1).length).toBe(2);
    expect(doc1.data?.__unparsedBlocks).toBeDefined();
    const ub1 = doc1.data!.__unparsedBlocks as Array<{ tag: string }>;
    expect(ub1.some((b) => b.tag === 'smartArt')).toBe(true);

    const out = await exportDocx(doc1);
    const doc2 = await parseDocx(out);

    // 再解析后仍是两个已知段落，结构数不变
    expect(paragraphs(doc2).length).toBe(2);
    // unknown 块通过 __unparsedBlocks 兜底被重新保留（未丢数据）
    expect(doc2.data?.__unparsedBlocks).toBeDefined();
    const ub2 = doc2.data!.__unparsedBlocks as Array<{ tag: string }>;
    expect(ub2.some((b) => b.tag === 'smartArt')).toBe(true);
  });

  it('4. 图片节点导出后仍可被解析为 Image（drawing 结构保留）', async () => {
    const input = await buildDocx({
      body: `<w:p><w:r>${DRAWING('rId7')}</w:r></w:p>`,
      rels: imageRels('rId7'),
    });
    const doc1 = await parseDocx(input);
    const out = await exportDocx(doc1);
    const doc2 = await parseDocx(out);
    let img: Image | undefined;
    for (const p of paragraphs(doc2)) {
      const found = p.runs.find((r) => r.type === 'image') as Image | undefined;
      if (found) img = found;
    }
    expect(img).toBeDefined();
    expect(img?.embed).toBe('rId7');
    // 关系也保留
    expect(doc2.relationships.find((r) => r.id === 'rId7')?.target).toBe('media/image1.png');
  });
});
