/**
 * 分栏（WPS 对齐「W-批2」）单测。
 *
 * 覆盖：
 *  1. 导出：sections[0].columns → exportDocx → document.xml 的 sectPr 含 <w:cols>
 *     （w:num / w:space / w:sep 与模型一致）。
 *  2. 解析：构造含 <w:cols w:num="3" w:space="425" w:sep="1"/> 的最小 docx → parseDocx →
 *     断言 sections[0].columns 回填（space 由 twips 换算为 EMU）。
 *  3. round-trip：parse → export → parse，分栏设置稳定不漂移。
 *  4. 单栏 / 缺省：不写出 <w:cols>（保持最小模型，不破坏现有文档）。
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

import { parseDocx } from '../src/parser/docxParser.js';
import { exportDocx } from '../src/exporter/index.js';
import type { JkDocument } from '../src/model/document.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 构造含分栏设置的最小 JkDocument（用于导出测试） */
function makeDocWithColumns(): JkDocument {
  return {
    body: [{ type: 'paragraph', runs: [{ type: 'run', text: '双栏正文' }] }],
    sections: [{ type: 'section', columns: { count: 2, space: 425 * 635, separator: true } }],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships: [],
    fidelity: { level: 'L2', features: [] },
  };
}

/** 构造单栏（缺省）的最小 JkDocument（用于回归测试） */
function makeDocWithoutColumns(): JkDocument {
  return {
    body: [{ type: 'paragraph', runs: [{ type: 'run', text: '单栏正文' }] }],
    sections: [{ type: 'section' }],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships: [],
    fidelity: { level: 'L2', features: [] },
  };
}

/** 构造含 sectPr/w:cols 的最小 docx（用于解析测试） */
async function buildColumnsDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${REL}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}">
  <w:body>
    <w:p><w:r><w:t>三栏正文</w:t></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:cols w:num="3" w:space="425" w:sep="1"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('分栏（WPS 对齐）', () => {
  it('1. 导出：sectPr 写出 <w:cols> 且 num/space/sep 与模型一致', async () => {
    const out = await exportDocx(makeDocWithColumns());
    const zip = await JSZip.loadAsync(out);
    const docXml = await zip.file('word/document.xml')!.async('string');

    expect(docXml).toContain('<w:cols');
    expect(docXml).toMatch(/<w:cols[^>]*w:num="2"/);
    expect(docXml).toMatch(/<w:cols[^>]*w:space="425"/);
    expect(docXml).toMatch(/<w:cols[^>]*w:sep="1"/);
  });

  it('2. 解析：从 sectPr/w:cols 读回分栏设置（space 为 EMU）', async () => {
    const doc = await parseDocx(await buildColumnsDocx());
    expect(doc.sections.length).toBeGreaterThan(0);
    expect(doc.sections[0].columns).toBeDefined();
    expect(doc.sections[0].columns!.count).toBe(3);
    expect(doc.sections[0].columns!.space).toBe(425 * 635);
    expect(doc.sections[0].columns!.separator).toBe(true);
  });

  it('3. round-trip：parse → export → parse 分栏设置稳定', async () => {
    const doc1 = await parseDocx(await buildColumnsDocx());
    const out = await exportDocx(doc1);

    const zip = await JSZip.loadAsync(out);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toMatch(/<w:cols[^>]*w:num="3"/);

    const doc2 = await parseDocx(out);
    expect(doc2.sections[0].columns).toEqual({ count: 3, space: 425 * 635, separator: true });
  });

  it('4. 单栏/缺省：不写出 <w:cols>', async () => {
    const out = await exportDocx(makeDocWithoutColumns());
    const zip = await JSZip.loadAsync(out);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).not.toContain('<w:cols');
    expect(docXml).toContain('单栏正文');
  });
});
