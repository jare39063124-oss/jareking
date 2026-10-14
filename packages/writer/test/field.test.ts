/**
 * Word 域（field）专项测试（T1 保真）：验证域在「解析 → 导出 → 再解析」链路中
 * 不被降级为静态文本，而是保留为 fldSimple，从而 Word/WPS 打开后按指令重算。
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseDocx } from '../src/parser/docxParser.js';
import { exportDocx } from '../src/exporter/index.js';
import type { Block, Inline } from '../src/model/document.js';
import { buildDocx } from './fixtures.js';

/** 在文档全部段落中查找首个 field 行内 */
function firstField(blocks: Block[]): Inline | undefined {
  for (const b of blocks) {
    if (b.type === 'paragraph') {
      const f = (b.runs ?? []).find((r) => r.type === 'field');
      if (f) return f;
    }
  }
  return undefined;
}

/** JkDocument.body 是块级序列（对应 w:body 子节点） */
function bodyOf(doc: { body: Block[] }): Block[] {
  return doc.body;
}

describe('Word 域解析', () => {
  it('简单域 w:fldSimple → field（instr + result）', async () => {
    const buf = await buildDocx({
      body: '<w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>',
    });
    const doc = await parseDocx(buf);
    const field = firstField(bodyOf(doc));
    expect(field?.type).toBe('field');
    expect((field as { instr?: string }).instr).toBe('PAGE');
    expect((field as { result?: string }).result).toBe('1');
  });

  it('复杂域 fldChar 序列 → field（instr 来自 instrText，result 来自 separate 后文本）', async () => {
    const body =
      '<w:p>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>5</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '</w:p>';
    const buf = await buildDocx({ body });
    const doc = await parseDocx(buf);
    const field = firstField(bodyOf(doc));
    expect(field?.type).toBe('field');
    expect((field as { instr?: string }).instr).toBe('NUMPAGES');
    expect((field as { result?: string }).result).toBe('5');
  });
});

describe('Word 域导出与往返', () => {
  it('含域文档：解析→导出→再解析，指令保留为 fldSimple', async () => {
    const buf = await buildDocx({
      body:
        '<w:p><w:fldSimple w:instr=" DATE "><w:r><w:t>2026-01-01</w:t></w:r></w:fldSimple></w:p>',
    });
    const doc = await parseDocx(buf);
    expect(firstField(bodyOf(doc))?.type).toBe('field');

    const out = await exportDocx(doc);
    // 导出字节中应含 w:fldSimple 且指令为 DATE
    const outText = new TextDecoder().decode(out);
    expect(outText).toContain('w:fldSimple');
    expect(outText).toContain('DATE');

    const reparsed = await parseDocx(out);
    const field = firstField(reparsed.body);
    expect(field?.type).toBe('field');
    expect((field as { instr?: string }).instr).toBe('DATE');
  });
});

// 引用以避免未使用告警（JSZip 在 fixtures 内使用，这里确保测试环境一致）
void JSZip;
