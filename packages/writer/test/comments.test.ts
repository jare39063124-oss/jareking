/**
 * 批注（Comments，WPS 对齐协作功能）单测。
 *
 * 覆盖：
 *  1. 导出部件断言：构造含 comments + 段落 commentRanges 的 JkDocument → exportDocx →
 *     回读 zip，断言 word/comments.xml 存在且含批注文本、[Content_Types].xml 含 comments
 *     Override、document.xml.rels 含 comments 关系（Target=comments.xml）、
 *     document.xml 含 commentRangeStart/commentRangeEnd/commentReference 且 w:id 一致。
 *  2. 解析往返断言：构造最小 docx（含 comments.xml + commentRangeStart/End 的 document.xml
 *     + rels + content-types）→ parseDocx → 断言 comments 与 paragraph.commentRanges 正确。
 *  3. round-trip：export → parse 后批注与锚点不丢。
 *  4. 无批注时：不生成 word/comments.xml、无 comments Override/关系（不破坏现有文档）。
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

import { parseDocx } from '../src/parser/docxParser.js';
import { exportDocx } from '../src/exporter/index.js';
import type { Block, JkDocument, Paragraph } from '../src/model/document.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 构造一个含批注（commentRanges + comments）的 JkDocument（用于导出测试） */
function makeDocWithComments(): JkDocument {
  const para: Paragraph = {
    type: 'paragraph',
    runs: [
      { type: 'run', text: '前缀' },
      { type: 'run', text: '被批注文本' },
      { type: 'run', text: '后缀' },
    ],
    commentRanges: [{ id: '1', start: 1, end: 2 }],
  };
  return {
    body: [para],
    sections: [{ type: 'section' }],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships: [],
    fidelity: { level: 'L2', features: [] },
    comments: [
      {
        id: '1',
        author: '张三',
        initials: 'ZS',
        date: '2024-05-01T09:00:00Z',
        text: '第一条批注\n第二行',
      },
    ],
  };
}

/** 构造一个不含批注的最小 JkDocument（用于回归测试） */
function makeDocWithoutComments(): JkDocument {
  return {
    body: [{ type: 'paragraph', runs: [{ type: 'run', text: '仅正文' }] }],
    sections: [{ type: 'section' }],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships: [],
    fidelity: { level: 'L2', features: [] },
  };
}

/** 构造含 comments.xml + 批注锚点段落的最小 docx（用于解析测试） */
async function buildCommentDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${REL}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rIdCmt1" Type="${R}/comments" Target="comments.xml"/>
</Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}">
  <w:body>
    <w:p>
      <w:r><w:t>前缀</w:t></w:r>
      <w:commentRangeStart w:id="1"/>
      <w:r><w:t>被批注文本</w:t></w:r>
      <w:commentRangeEnd w:id="1"/>
      <w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>
      <w:r><w:t>后缀</w:t></w:r>
    </w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;
  const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W}">
  <w:comment w:id="1" w:author="张三" w:initials="ZS" w:date="2024-05-01T09:00:00Z">
    <w:p><w:r><w:t>这是一条批注</w:t></w:r></w:p>
  </w:comment>
</w:comments>`;
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('word/_rels/document.xml.rels', docRels);
  zip.file('word/document.xml', documentXml);
  zip.file('word/comments.xml', commentsXml);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('批注（WPS 对齐协作功能）', () => {
  it('1. 导出：生成 comments.xml 且 Content_Types / rels / 锚点齐全', async () => {
    const out = await exportDocx(makeDocWithComments());
    const zip = await JSZip.loadAsync(out);

    // 部件存在且含批注文本（多段落用 \n 拆分）
    const commentsXml = await zip.file('word/comments.xml')!.async('string');
    expect(commentsXml).toContain('<w:comments');
    expect(commentsXml).toContain('第一条批注');
    expect(commentsXml).toContain('第二行');
    expect(commentsXml).toContain('w:author="张三"');

    // [Content_Types].xml 含 comments Override
    const ctXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(ctXml).toContain('/word/comments.xml');
    expect(ctXml).toContain('comments+xml');

    // document.xml.rels 含 comments 关系且 Target 为 comments.xml
    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(relsXml).toContain('Target="comments.xml"');
    expect(relsXml).toMatch(/Type="[^"]*\/comments"/);
    const cmtRelId = /<Relationship Id="(rIdCmt\d+)"[^>]*Target="comments\.xml"/.exec(relsXml)?.[1];
    expect(cmtRelId).toBeTruthy();

    // document.xml 含锚点，且 w:id 与批注一致（'1'）
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toMatch(/<w:commentRangeStart w:id="1"\/>/);
    expect(docXml).toMatch(/<w:commentRangeEnd w:id="1"\/>/);
    expect(docXml).toMatch(/<w:commentReference w:id="1"\/>/);
  });

  it('2. 解析：从 docx 读回 comments 与段落 commentRanges', async () => {
    const doc = await parseDocx(await buildCommentDocx());

    // 批注元数据
    expect(doc.comments).toBeDefined();
    expect(doc.comments!.length).toBe(1);
    expect(doc.comments![0]).toMatchObject({
      id: '1',
      author: '张三',
      initials: 'ZS',
      date: '2024-05-01T09:00:00Z',
      text: '这是一条批注',
    });

    // 段落内锚点：3 个 run（引用 run 已被排除），批注覆盖 run#1
    const para = doc.body[0] as Paragraph;
    expect(para.type).toBe('paragraph');
    expect(para.runs.length).toBe(3);
    expect(para.commentRanges).toEqual([{ id: '1', start: 1, end: 2 }]);
    expect((para.runs[1] as { text?: string }).text).toBe('被批注文本');
  });

  it('3. round-trip：export → parse 批注与锚点不丢（且不重复 comments 关系）', async () => {
    const doc1 = await parseDocx(await buildCommentDocx());
    const out = await exportDocx(doc1);

    const zip = await JSZip.loadAsync(out);
    expect(await zip.file('word/comments.xml')).toBeTruthy();

    // 关系不重复累积（复用解析透传的 comments 关系）
    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
    const cmtCount = (relsXml.match(/Type="[^"]*\/comments"/g) ?? []).length;
    expect(cmtCount).toBe(1);

    const doc2 = await parseDocx(out);
    expect(doc2.comments?.[0]?.text).toBe('这是一条批注');
    const para = doc2.body[0] as Paragraph;
    expect(para.commentRanges).toEqual([{ id: '1', start: 1, end: 2 }]);
    // 不因 round-trip 累积空的引用 run
    expect(para.runs.length).toBe(3);
  });

  it('4. 无批注时不生成 comments.xml / Override / 关系', async () => {
    const out = await exportDocx(makeDocWithoutComments());
    const zip = await JSZip.loadAsync(out);

    expect(await zip.file('word/comments.xml')).toBeNull();

    const ctXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(ctXml).not.toContain('/word/comments.xml');

    const relsFile = zip.file('word/_rels/document.xml.rels');
    if (relsFile) {
      const relsXml = await relsFile.async('string');
      expect(relsXml).not.toContain('comments.xml');
      expect(relsXml).not.toContain('/comments"');
    }

    // 正文仍正常保留、无遗漏锚点
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('仅正文');
    expect(docXml).not.toContain('commentRangeStart');
    void (null as unknown as Block);
  });
});
