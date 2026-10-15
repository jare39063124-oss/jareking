import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { addImageWatermark, addWatermark, loadPdf, pdfToText } from '../src/index';

/**
 * 1×1 透明 PNG（68 字节，标准最小 PNG）。
 * 用于图片水印单测——无需 DOM / canvas，可在 Node 环境完整覆盖数据层逻辑。
 */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
const TINY_PNG = new Uint8Array(Buffer.from(TINY_PNG_B64, 'base64'));

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

/**
 * 非拉丁（中文）水印回归（对抗审计 T25 / Bug3 修复）。
 *
 * 说明：本项目**未引入** `@pdf-lib/fontkit`（遵守「不新增运行时依赖」），而 pdf-lib
 * 嵌入自定义字体（TTF/OTF/TTC）**强依赖 fontkit**；本机测试环境即处于「无 fontkit」状态，
 * 故 addWatermark 实际走「抛出明确错误」兜底分支。若运行环境已注册 fontkit（或经
 * opts.fontBytes/fontPath 提供字体），则应成功产出合法 PDF。
 * 本用例**两种结果均接受**，但明确禁止：静默产出乱码 / 损坏 PDF，或抛出 WinAnsi 原始异常。
 */
describe('addWatermark（非拉丁 / 中文，Bug3 修复）', () => {
  it('中文水印：能嵌入 CJK 字体则产出合法 PDF，否则抛出明确可操作错误', async () => {
    const src = await makeTwoPagePdf();
    let out: Uint8Array | null = null;
    let err: Error | null = null;
    try {
      out = await addWatermark(src, { text: '机密', fontSize: 40, opacity: 0.2, rotate: 45 });
    } catch (e) {
      err = e as Error;
    }

    if (out) {
      // 成功分支：页数守恒、可重新加载并保存（绘图指令合法）、文本可提取
      const doc = await loadPdf(out);
      expect(doc.getPageCount()).toBe(2);
      await doc.save();
      const txt = await pdfToText(out);
      expect(txt).toContain('机密');
    } else {
      // 报错分支：须为可读、可操作的明确错误（含 CJK/字体关键词），而非 WinAnsi 乱码异常
      expect(err).toBeTruthy();
      expect(err!.message).toMatch(/非拉丁|中文|CJK|字体/);
      expect(err!.message).not.toMatch(/WinAnsi/);
      expect(err!.message).not.toMatch(/cannot encode/);
    }
  });

  it('fontPath 指向不存在的字体 → 抛出明确错误（不产出损坏 PDF）', async () => {
    const src = await makeTwoPagePdf();
    await expect(
      addWatermark(src, { text: '机密', fontPath: 'Z:\\no\\such\\font.ttf' }),
    ).rejects.toThrow(/fontkit|字体/);
  });

  it('拉丁文本不受影响：仍走内建字体，正常产出（无回归）', async () => {
    const src = await makeTwoPagePdf();
    const out = await addWatermark(src, { text: 'SECRET', fontSize: 40 });
    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(2);
    const txt = await pdfToText(out);
    expect(txt).toContain('SECRET');
  });
});

/** 断言导出字节是合法 PDF（%PDF- 头） */
function expectValidPdfHeader(bytes: Uint8Array): void {
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  expect(head).toBe('%PDF-');
}

/**
 * 图片水印（addImageWatermark）—— 中文等非拉丁文本的位图化水印数据层。
 *
 * 说明：本用例只在 Node 数据层验证「图片嵌入 + 叠加 + 页数守恒 + 输出合法」。
 * 渲染层「中文 → canvas PNG」逻辑依赖 DOM，Node 无 canvas，不在单测覆盖范围，
 * 由 GUI 冒烟 / 人工验证（见提交说明）。
 */
describe('addImageWatermark（PDF 图片水印）', () => {
  it('居中：页数不变、输出合法 PDF、可再次加载并保存', async () => {
    const src = await makeTwoPagePdf();
    const out = await addImageWatermark(src, { imageBytes: TINY_PNG, mime: 'png' });

    expectValidPdfHeader(out);

    // 页数保持不变
    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(2);
    // 可再次保存（说明绘图指令合法、无损坏）
    const resaved = await doc.save();
    expect(resaved.length).toBeGreaterThan(0);
  });

  it('平铺：整页网格重复，页数不变且输出合法', async () => {
    const src = await makeTwoPagePdf();
    const out = await addImageWatermark(src, { imageBytes: TINY_PNG, tile: true, rotate: 30 });

    expectValidPdfHeader(out);
    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(2);
    await doc.save();
  });

  it('自定义透明度 / 角度 / 宽度比例：正常产出且页数不变', async () => {
    const src = await makeTwoPagePdf();
    const out = await addImageWatermark(src, {
      imageBytes: TINY_PNG,
      opacity: 0.3,
      rotate: 45,
      widthRatio: 0.4,
    });

    expectValidPdfHeader(out);
    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(2);
    await doc.save();
  });

  it('空图片字节：按约定抛错（输入校验）', async () => {
    const src = await makeTwoPagePdf();
    await expect(
      addImageWatermark(src, { imageBytes: new Uint8Array(0) }),
    ).rejects.toThrow();
  });
});
