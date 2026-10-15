import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { pdfToText } from '../src/index';

/** 用 pdf-lib 生成含拉丁文本的最小 PDF（pdf-lib 默认字体不含中文字形，故测试样本用 ASCII） */
async function makePdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  let y = 760;
  for (const text of lines) {
    const page = doc.addPage([595, 842]);
    page.drawText(text, { x: 40, y, size: 12 });
    y -= 20;
  }
  return doc.save();
}

describe('pdfToText（PDF 转 TXT）', () => {
  it('单页：提取嵌入的文本', async () => {
    const bytes = await makePdf(['Hello jareking test']);
    const txt = await pdfToText(bytes);
    expect(txt).toContain('Hello jareking test');
  });

  it('多页：逐页提取且顺序正确', async () => {
    const doc = await PDFDocument.create();
    const p1 = doc.addPage([595, 842]);
    p1.drawText('PAGE ONE content', { x: 40, y: 760, size: 12 });
    const p2 = doc.addPage([595, 842]);
    p2.drawText('PAGE TWO content', { x: 40, y: 760, size: 12 });
    const bytes = await doc.save();
    const txt = await pdfToText(bytes);
    expect(txt).toContain('PAGE ONE content');
    expect(txt).toContain('PAGE TWO content');
    // 页码顺序：第一页内容应在第二页之前
    expect(txt.indexOf('PAGE ONE')).toBeLessThan(txt.indexOf('PAGE TWO'));
  });

  it('空页：返回空文本（trim 后长度为 0）', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const bytes = await doc.save();
    const txt = (await pdfToText(bytes)).trim();
    expect(txt.length).toBe(0);
  });

  it('多行文本按行拆分', async () => {
    const bytes = await makePdf(['Line Alpha', 'Line Beta', 'Line Gamma']);
    const txt = await pdfToText(bytes);
    expect(txt).toContain('Line Alpha');
    expect(txt).toContain('Line Beta');
    expect(txt).toContain('Line Gamma');
  });
});
