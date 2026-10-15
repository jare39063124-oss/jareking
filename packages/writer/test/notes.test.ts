/**
 * 脚注 / 尾注（WPS 对齐「W-批2 深度项」）单测。
 *
 * 覆盖：
 *  1. 导出部件断言：构造含 footnotes/endnotes + 正文 FootnoteRef 的 JkDocument →
 *     exportDocx → 回读 zip，断言生成 word/footnotes.xml / word/endnotes.xml，
 *     含正文内容与规范分隔符条目，document.xml 含 w:footnoteReference / w:endnoteReference，
 *     rels 含 footnotes/endnotes 关系，Content_Types 含对应 Override。
 *  2. 解析往返断言：构造含 footnotes.xml/endnotes.xml + 正文引用的最小 docx → parseDocx →
 *     断言 doc.footnotes / doc.endnotes 回填，正文 FootnoteRef 的 id 与 noteType 正确。
 *  3. round-trip：parse → export → parse，脚注/尾注内容与引用不丢。
 *  4. 无脚注/尾注时：不生成多余部件（不破坏现有文档）。
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

import { parseDocx } from '../src/parser/docxParser.js';
import { exportDocx } from '../src/exporter/index.js';
import type { Block, FootnoteRef, JkDocument, Paragraph } from '../src/model/document.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 从段落 runs 中取出脚注/尾注引用 */
function noteRefs(doc: JkDocument): FootnoteRef[] {
  const out: FootnoteRef[] = [];
  for (const b of doc.body) {
    if (b.type !== 'paragraph') continue;
    for (const r of b.runs) if (r.type === 'footnoteRef') out.push(r);
  }
  return out;
}

/** 构造含脚注/尾注与正文引用的 JkDocument（用于导出测试） */
function makeDocWithNotes(): JkDocument {
  const para: Paragraph = {
    type: 'paragraph',
    runs: [
      { type: 'run', text: '正文甲' },
      { type: 'footnoteRef', id: '1' },
      { type: 'run', text: '正文乙' },
      { type: 'footnoteRef', id: '1', noteType: 'endnote' },
    ],
  };
  return {
    body: [para],
    sections: [{ type: 'section' }],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships: [],
    fidelity: { level: 'L2', features: [] },
    footnotes: [{ id: '1', blocks: [{ type: 'paragraph', runs: [{ type: 'run', text: '脚注内容' }] }] }],
    endnotes: [{ id: '1', blocks: [{ type: 'paragraph', runs: [{ type: 'run', text: '尾注内容' }] }] }],
  };
}

/** 构造不含脚注/尾注的最小 JkDocument（用于回归测试） */
function makeDocWithoutNotes(): JkDocument {
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

/** 构造含 footnotes.xml / endnotes.xml + 正文引用的最小 docx（用于解析测试） */
async function buildNotesDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${REL}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rIdFn1" Type="${R}/footnotes" Target="footnotes.xml"/>
  <Relationship Id="rIdEn1" Type="${R}/endnotes" Target="endnotes.xml"/>
</Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}">
  <w:body>
    <w:p>
      <w:r><w:t>正文甲</w:t></w:r>
      <w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>
      <w:r><w:t>正文乙</w:t></w:r>
      <w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteReference w:id="1"/></w:r>
    </w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;
  const footnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="${W}">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t>脚注内容</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;
  const endnotesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes xmlns:w="${W}">
  <w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
  <w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>
  <w:endnote w:id="1"><w:p><w:r><w:t>尾注内容</w:t></w:r></w:p></w:endnote>
</w:endnotes>`;
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('word/_rels/document.xml.rels', docRels);
  zip.file('word/document.xml', documentXml);
  zip.file('word/footnotes.xml', footnotesXml);
  zip.file('word/endnotes.xml', endnotesXml);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('脚注 / 尾注（WPS 对齐）', () => {
  it('1. 导出：生成 footnotes.xml / endnotes.xml 且引用 / 关系 / Content_Types 齐全', async () => {
    const out = await exportDocx(makeDocWithNotes());
    const zip = await JSZip.loadAsync(out);

    // 脚注部件：含根节点、正文内容与规范分隔符
    const footnotesXml = await zip.file('word/footnotes.xml')!.async('string');
    expect(footnotesXml).toContain('<w:footnotes');
    expect(footnotesXml).toContain('脚注内容');
    expect(footnotesXml).toContain('<w:footnote w:type="separator" w:id="-1">');
    expect(footnotesXml).toContain('<w:footnote w:id="1">');

    // 尾注部件
    const endnotesXml = await zip.file('word/endnotes.xml')!.async('string');
    expect(endnotesXml).toContain('<w:endnotes');
    expect(endnotesXml).toContain('尾注内容');
    expect(endnotesXml).toContain('<w:endnote w:id="1">');

    // document.xml 含两种引用
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toMatch(/<w:footnoteReference w:id="1"\/>/);
    expect(docXml).toMatch(/<w:endnoteReference w:id="1"\/>/);

    // document.xml.rels 含 footnotes / endnotes 关系
    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(relsXml).toContain('Target="footnotes.xml"');
    expect(relsXml).toContain('Target="endnotes.xml"');
    expect(relsXml).toMatch(/Type="[^"]*\/footnotes"/);
    expect(relsXml).toMatch(/Type="[^"]*\/endnotes"/);

    // [Content_Types].xml 含 footnotes / endnotes Override
    const ctXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(ctXml).toContain('/word/footnotes.xml');
    expect(ctXml).toContain('/word/endnotes.xml');
    expect(ctXml).toContain('footnotes+xml');
    expect(ctXml).toContain('endnotes+xml');
  });

  it('2. 解析：从 docx 读回 footnotes/endnotes 与正文引用', async () => {
    const doc = await parseDocx(await buildNotesDocx());

    expect(doc.footnotes?.length).toBe(1);
    expect(doc.footnotes![0].id).toBe('1');
    const fnText = doc.footnotes![0].blocks
      .map((b: Block) => (b.type === 'paragraph' ? b.runs.map((r) => (r.type === 'run' ? r.text : '')).join('') : ''))
      .join('');
    expect(fnText).toContain('脚注内容');

    expect(doc.endnotes?.length).toBe(1);
    expect(doc.endnotes![0].id).toBe('1');

    // 正文引用：脚注 noteType 缺省（footnote），尾注显式 endnote
    const refs = noteRefs(doc);
    expect(refs.length).toBe(2);
    expect(refs[0]).toMatchObject({ type: 'footnoteRef', id: '1' });
    expect(refs[0].noteType).toBeUndefined();
    expect(refs[1]).toMatchObject({ type: 'footnoteRef', id: '1', noteType: 'endnote' });

    // 引用 run 不计入正文文本 run（正文仍有「正文甲」「正文乙」两个文本 run）
    const para = doc.body[0] as Paragraph;
    const textRuns = para.runs.filter((r) => r.type === 'run');
    expect(textRuns.length).toBe(2);
  });

  it('3. round-trip：parse → export → parse 脚注/尾注与引用不丢', async () => {
    const doc1 = await parseDocx(await buildNotesDocx());
    const out = await exportDocx(doc1);
    const zip = await JSZip.loadAsync(out);
    expect(await zip.file('word/footnotes.xml')).toBeTruthy();
    expect(await zip.file('word/endnotes.xml')).toBeTruthy();

    const doc2 = await parseDocx(out);
    expect(doc2.footnotes?.[0]?.id).toBe('1');
    const refs = noteRefs(doc2);
    expect(refs.length).toBe(2);
    expect(refs[1].noteType).toBe('endnote');
    // 关系不重复累积
    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect((relsXml.match(/Type="[^"]*\/footnotes"/g) ?? []).length).toBe(1);
    expect((relsXml.match(/Type="[^"]*\/endnotes"/g) ?? []).length).toBe(1);
  });

  it('4. 无脚注/尾注时不生成多余部件（不破坏现有文档）', async () => {
    const doc = makeDocWithoutNotes();
    const out = await exportDocx(doc);
    const zip = await JSZip.loadAsync(out);

    expect(await zip.file('word/footnotes.xml')).toBeNull();
    expect(await zip.file('word/endnotes.xml')).toBeNull();

    const ctXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(ctXml).not.toContain('/word/footnotes.xml');
    expect(ctXml).not.toContain('/word/endnotes.xml');

    const relsFile = zip.file('word/_rels/document.xml.rels');
    if (relsFile) {
      const relsXml = await relsFile.async('string');
      expect(relsXml).not.toContain('footnotes.xml');
      expect(relsXml).not.toContain('endnotes.xml');
    }

    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('仅正文');
    expect(docXml).not.toContain('footnoteReference');
    expect(docXml).not.toContain('endnoteReference');
  });
});
