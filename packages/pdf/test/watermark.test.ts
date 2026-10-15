import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { addWatermark, loadPdf, pdfToText } from '../src/index';

/** 用 pdf-lib 造一个 2 页 A4 空 PDF（水印测试样本，纯 ASCII 文本以适配内建字体） */
async function makeTwoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([595, 842]);
  return doc.save();
}

describe('addWatermark（PDF 文字水印）', () => {
  it('居中水印：页数不变、文字写入、可再次加载并保存', async () => {
    const src = await makeTwoPagePdf();
    const out = await addWatermark(src, { text: 'CONFIDENTIAL' });

    // 页数保持不变
    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(2);

    // 可再次保存（说明水印写入的绘图指令合法）
    const resaved = await doc.save();
    expect(resaved.length).toBeGreaterThan(0);

    // 水印文字确实被写入（通过文本提取反查）
    const txt = await pdfToText(out);
    expect(txt).toContain('CONFIDENTIAL');
  });

  it('平铺水印：整页矩阵重复，页数不变且文字可见', async () => {
    const src = await makeTwoPagePdf();
    const out = await addWatermark(src, { text: 'DRAFT', tile: true, fontSize: 20 });

    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(2);

    const txt = await pdfToText(out);
    expect(txt).toContain('DRAFT');
  });

  it('自定义透明度 / 颜色 / 角度：正常生成且页数不变', async () => {
    const src = await makeTwoPagePdf();
    const out = await addWatermark(src, {
      text: 'SAMPLE',
      fontSize: 36,
      opacity: 0.3,
      rotate: 30,
      color: '#ff0000',
    });

    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(2);
    await doc.save();

    const txt = await pdfToText(out);
    expect(txt).toContain('SAMPLE');
  });

  it('空文字：按约定抛错（输入校验）', async () => {
    const src = await makeTwoPagePdf();
    await expect(addWatermark(src, { text: '   ' })).rejects.toThrow();
  });
});
