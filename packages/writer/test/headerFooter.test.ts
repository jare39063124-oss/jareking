/**
 * 页眉页脚（WPS 对齐「W-批2 深度项」）单测。
 *
 * 覆盖：
 *  1. 导出部件断言：构造含 header/footer 的 JkDocument → exportDocx →
 *     回读 zip，断言生成 word/header1.xml / footer1.xml 且内容、关系、Content_Types 齐全。
 *  2. 解析往返断言：构造含 header1.xml/footer1.xml + sectPr 引用的最小 docx → parseDocx →
 *     断言 sections[0].header / footer 正确回填。
 *  3. round-trip：parse → export → parse，页眉页脚内容不丢。
 *  4. 无页眉页脚时：不生成多余部件（不破坏现有文档）。
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

import { parseDocx } from '../src/parser/docxParser.js';
import { exportDocx } from '../src/exporter/index.js';
import type { Block, JkDocument } from '../src/model/document.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 构造一个含页眉/页脚的 JkDocument（用于导出测试） */
function makeDocWithHf(): JkDocument {
  return {
    body: [{ type: 'paragraph', runs: [{ type: 'run', text: '正文内容' }] }],
    sections: [
      {
        type: 'section',
        header: [{ type: 'paragraph', runs: [{ type: 'run', text: '页眉文字' }] }],
        footer: [{ type: 'paragraph', runs: [{ type: 'run', text: '第 ' }] }],
      },
    ],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships: [],
    fidelity: { level: 'L2', features: [] },
  };
}

/** 构造一个不含页眉页脚的最小 JkDocument（用于回归测试） */
function makeDocWithoutHf(): JkDocument {
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

/** 构造含 header1.xml / footer1.xml + sectPr 引用的最小 docx（用于解析测试） */
async function buildHfDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${REL}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rIdHf1" Type="${R}/header" Target="header1.xml"/>
  <Relationship Id="rIdHf2" Type="${R}/footer" Target="footer1.xml"/>
</Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}">
  <w:body>
    <w:p><w:r><w:t>正文</w:t></w:r></w:p>
    <w:sectPr>
      <w:headerReference w:type="default" r:id="rIdHf1"/>
      <w:footerReference w:type="default" r:id="rIdHf2"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="${W}" xmlns:r="${R}">
  <w:p><w:r><w:t>页眉文字</w:t></w:r></w:p>
</w:hdr>`;
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="${W}" xmlns:r="${R}">
  <w:p><w:r><w:t>页脚文字</w:t></w:r></w:p>
</w:ftr>`;
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('word/_rels/document.xml.rels', docRels);
  zip.file('word/document.xml', documentXml);
  zip.file('word/header1.xml', headerXml);
  zip.file('word/footer1.xml', footerXml);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('页眉页脚（WPS 对齐）', () => {
  it('1. 导出：生成 header1.xml / footer1.xml 且关系与 Content_Types 齐全', async () => {
    const doc = makeDocWithHf();
    const out = await exportDocx(doc);
    const zip = await JSZip.loadAsync(out);

    // 部件存在且含预期内容与根节点
    const headerXml = await zip.file('word/header1.xml')!.async('string');
    expect(headerXml).toContain('<w:hdr');
    expect(headerXml).toContain('页眉文字');
    const footerXml = await zip.file('word/footer1.xml')!.async('string');
    expect(footerXml).toContain('<w:ftr');
    expect(footerXml).toContain('第 ');

    // document.xml.rels 含 header/footer 关系且 Target 指向对应部件
    const relsXml = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(relsXml).toContain('Target="header1.xml"');
    expect(relsXml).toContain('Target="footer1.xml"');
    expect(relsXml).toContain('header');
    expect(relsXml).toContain('footer');

    // document.xml 的 sectPr 含 headerReference/footerReference，且 r:id 与 rels 一致
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('headerReference');
    expect(docXml).toContain('footerReference');
    const headerRelId = /headerReference[^>]*r:id="([^"]+)"/.exec(docXml)?.[1];
    const footerRelId = /footerReference[^>]*r:id="([^"]+)"/.exec(docXml)?.[1];
    expect(headerRelId).toBeTruthy();
    expect(footerRelId).toBeTruthy();
    expect(relsXml).toContain(`Id="${headerRelId}"`);
    expect(relsXml).toContain(`Id="${footerRelId}"`);

    // [Content_Types].xml 含 header/footer Override
    const ctXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(ctXml).toContain('/word/header1.xml');
    expect(ctXml).toContain('/word/footer1.xml');
    expect(ctXml).toContain('header+xml');
    expect(ctXml).toContain('footer+xml');
  });

  it('2. 解析：从 docx 读回页眉/页脚内容到 sections[0]', async () => {
    const buf = await buildHfDocx();
    const doc = await parseDocx(buf);
    expect(doc.sections.length).toBeGreaterThan(0);
    const headerText = doc.sections[0].header
      ?.map((b: Block) => (b.type === 'paragraph' ? b.runs.map((r) => (r.type === 'run' ? r.text : '')).join('') : ''))
      .join('');
    const footerText = doc.sections[0].footer
      ?.map((b: Block) => (b.type === 'paragraph' ? b.runs.map((r) => (r.type === 'run' ? r.text : '')).join('') : ''))
      .join('');
    expect(headerText).toContain('页眉文字');
    expect(footerText).toContain('页脚文字');
  });

  it('3. round-trip：parse → export → parse 页眉页脚不丢', async () => {
    const buf = await buildHfDocx();
    const doc1 = await parseDocx(buf);
    expect(doc1.sections[0].header).toBeDefined();
    expect(doc1.sections[0].footer).toBeDefined();

    const out = await exportDocx(doc1);
    const zip = await JSZip.loadAsync(out);
    // 再导出仍生成页眉/页脚部件
    expect(await zip.file('word/header1.xml')).toBeTruthy();
    expect(await zip.file('word/footer1.xml')).toBeTruthy();

    const doc2 = await parseDocx(out);
    const headerText = doc2.sections[0].header
      ?.map((b: Block) => (b.type === 'paragraph' ? b.runs.map((r) => (r.type === 'run' ? r.text : '')).join('') : ''))
      .join('');
    const footerText = doc2.sections[0].footer
      ?.map((b: Block) => (b.type === 'paragraph' ? b.runs.map((r) => (r.type === 'run' ? r.text : '')).join('') : ''))
      .join('');
    expect(headerText).toContain('页眉文字');
    expect(footerText).toContain('页脚文字');
  });

  it('4. 无页眉页脚时不生成多余部件（不破坏现有文档）', async () => {
    const doc = makeDocWithoutHf();
    const out = await exportDocx(doc);
    const zip = await JSZip.loadAsync(out);
    // 不应生成 header/footer 部件
    expect(await zip.file('word/header1.xml')).toBeNull();
    expect(await zip.file('word/footer1.xml')).toBeNull();
    // document.xml.rels 不应含 header/footer 关系
    const relsFile = zip.file('word/_rels/document.xml.rels');
    if (relsFile) {
      const relsXml = await relsFile.async('string');
      expect(relsXml).not.toContain('header1.xml');
      expect(relsXml).not.toContain('footer1.xml');
      expect(relsXml).not.toContain('/header"');
      expect(relsXml).not.toContain('/footer"');
    }
    // Content_Types 不应含 header/footer Override
    const ctXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(ctXml).not.toContain('/word/header1.xml');
    expect(ctXml).not.toContain('/word/footer1.xml');
    // 正文仍正常保留
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('仅正文');
  });
});
