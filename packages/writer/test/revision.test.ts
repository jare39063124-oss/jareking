/**
 * 修订（track changes，WPS 对齐）单测。
 *
 * 覆盖：
 *  1. 导出：含 insert/delete run 的 JkDocument → exportDocx → 回读 document.xml，
 *     断言 <w:ins>/<w:del>/<w:delText> 存在且 w:author / w:date 正确、w:id 齐备。
 *  2. 解析：构造含 w:ins/w:del 的最小 docx → parseDocx → 断言 runs 的 revision 正确
 *     （kind/author/date、删除文本取自 w:delText），并汇总 revisions 作者清单。
 *  3. round-trip：export → parse 修订不丢（kind/author/date/文本一致）。
 *  4. 无修订：导出不产生 w:ins/w:del/delText（不破坏既有导出路径）。
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';

import { parseDocx } from '../src/parser/docxParser.js';
import { exportDocx } from '../src/exporter/index.js';
import type { JkDocument, Paragraph, Run } from '../src/model/document.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const AUTHOR_INS = '张三';
const DATE_INS = '2024-05-01T09:00:00Z';
const AUTHOR_DEL = '李四';
const DATE_DEL = '2024-05-02T10:00:00Z';

/** 构造含插入/删除修订的 JkDocument（用于导出测试） */
function makeDocWithRevisions(): JkDocument {
  const para: Paragraph = {
    type: 'paragraph',
    runs: [
      { type: 'run', text: '前缀' },
      { type: 'run', text: '新增文本', revision: { kind: 'insert', author: AUTHOR_INS, date: DATE_INS } },
      { type: 'run', text: '删除文本', revision: { kind: 'delete', author: AUTHOR_DEL, date: DATE_DEL } },
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
  };
}

/** 构造无修订的最小 JkDocument（回归测试） */
function makeDocWithoutRevisions(): JkDocument {
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

/** 构造含 w:ins / w:del 的最小 docx（用于解析测试） */
async function buildRevisionDocx(): Promise<Uint8Array> {
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
    <w:p>
      <w:r><w:t>前缀</w:t></w:r>
      <w:ins w:id="1" w:author="${AUTHOR_INS}" w:date="${DATE_INS}"><w:r><w:t>新增文本</w:t></w:r></w:ins>
      <w:del w:id="2" w:author="${AUTHOR_DEL}" w:date="${DATE_DEL}"><w:r><w:delText>删除文本</w:delText></w:r></w:del>
    </w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('word/document.xml', documentXml);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('修订（track changes）', () => {
  it('1. 导出：含 insert/delete run 时生成 <w:ins>/<w:del>/<w:delText> 且 author/date 正确', async () => {
    const out = await exportDocx(makeDocWithRevisions());
    const zip = await JSZip.loadAsync(out);
    const xml = await zip.file('word/document.xml')!.async('string');

    // 插入修订：<w:ins> 包裹，文本用 <w:t>
    expect(xml).toMatch(/<w:ins\s/);
    expect(xml).toMatch(/<w:ins[^>]*w:author="张三"/);
    expect(xml).toMatch(/<w:ins[^>]*w:date="2024-05-01T09:00:00Z"/);
    expect(xml).toMatch(/<w:ins[^>]*w:id="\d+"/);
    expect(xml).toContain('新增文本');
    // 插入文本必须落在 <w:t> 中（非 delText）
    expect(xml).toMatch(/<w:t xml:space="preserve">新增文本<\/w:t>/);

    // 删除修订：<w:del> 包裹，文本用 <w:delText>
    expect(xml).toMatch(/<w:del\s/);
    expect(xml).toMatch(/<w:del[^>]*w:author="李四"/);
    expect(xml).toMatch(/<w:del[^>]*w:date="2024-05-02T10:00:00Z"/);
    expect(xml).toMatch(/<w:delText xml:space="preserve">删除文本<\/w:delText>/);

    // 普通 run 仍用 <w:t>，未被包进修订元素
    expect(xml).toMatch(/<w:t xml:space="preserve">前缀<\/w:t>/);
  });

  it('2. 解析：从 docx 读回 w:ins / w:del 的 revision 与作者清单', async () => {
    const doc = await parseDocx(await buildRevisionDocx());
    const para = doc.body[0] as Paragraph;

    expect(para.type).toBe('paragraph');
    expect(para.runs.length).toBe(3);

    const ins = para.runs[1] as Run;
    expect(ins.revision).toEqual({ kind: 'insert', author: AUTHOR_INS, date: DATE_INS });
    expect(ins.text).toBe('新增文本');

    const del = para.runs[2] as Run;
    expect(del.revision).toEqual({ kind: 'delete', author: AUTHOR_DEL, date: DATE_DEL });
    // 删除文本取自 <w:delText>
    expect(del.text).toBe('删除文本');

    // 普通 run 无 revision
    expect((para.runs[0] as Run).revision).toBeUndefined();

    // 修订作者清单（可选字段）：去重汇总张三 / 李四
    expect(doc.revisions).toBeDefined();
    const authors = (doc.revisions ?? []).map((r) => r.author).sort();
    expect(authors).toEqual([AUTHOR_INS, AUTHOR_DEL].sort());
  });

  it('3. round-trip：export → parse 修订不丢（kind/author/date/文本一致）', async () => {
    const doc1 = await parseDocx(await buildRevisionDocx());
    const out = await exportDocx(doc1);
    const doc2 = await parseDocx(out);
    const para = doc2.body[0] as Paragraph;

    expect(para.runs.length).toBe(3);
    const ins = para.runs[1] as Run;
    expect(ins.revision).toMatchObject({ kind: 'insert', author: AUTHOR_INS, date: DATE_INS });
    expect(ins.text).toBe('新增文本');

    const del = para.runs[2] as Run;
    expect(del.revision).toMatchObject({ kind: 'delete', author: AUTHOR_DEL, date: DATE_DEL });
    expect(del.text).toBe('删除文本');
  });

  it('4. 无修订时导出不受影响（不产生 w:ins / w:del / delText）', async () => {
    const out = await exportDocx(makeDocWithoutRevisions());
    const zip = await JSZip.loadAsync(out);
    const xml = await zip.file('word/document.xml')!.async('string');

    expect(xml).not.toMatch(/<w:ins[\s>]/);
    expect(xml).not.toMatch(/<w:del[\s>]/);
    expect(xml).not.toContain('delText');
    // 正文照常保留
    expect(xml).toMatch(/<w:t xml:space="preserve">仅正文<\/w:t>/);
  });
});
