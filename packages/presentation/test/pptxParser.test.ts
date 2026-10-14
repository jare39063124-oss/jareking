/**
 * pptxParser 回归测试（#46-C fflate 流式重写）。
 *
 * 用自研 exporter 生成合法 pptx 字节，再走流式解析器解析，
 * 断言 顺序/文本/格式/填充/图片字节 与原始模型一致；
 * 另用 fflate zipSync 构造「缺 presentation.xml」的非法包，验证错误路径。
 */
import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { exportPptx, parsePptx } from '../src/index';
import type { JkPresentation, JkSlide } from '../src/model/index';

// 1×1 PNG（合法 PNG 签名，内容不影响往返，仅校验字节保留）
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBytes = new Uint8Array(Buffer.from(PNG_B64, 'base64'));

function buildPres(): JkPresentation {
  const slide0: JkSlide = {
    shapes: [
      {
        type: 'text',
        id: '2',
        name: 'TextBox 1',
        x: 1000000,
        y: 1000000,
        w: 5000000,
        h: 1000000,
        paragraphs: [
          { runs: [{ text: 'Hello', bold: true, fontSize: 32, color: '#000000' }] },
        ],
        geom: 'rect',
      },
      {
        // 注意：geom=rect 会被解析器按分类规则归为文本框，故自动形状用 ellipse
        type: 'shape',
        geom: 'ellipse',
        id: '3',
        name: 'Ellipse 1',
        x: 1000000,
        y: 2500000,
        w: 3000000,
        h: 1500000,
        fill: '#FF0000',
      },
    ],
  };
  const slide1: JkSlide = {
    shapes: [
      {
        type: 'image',
        relId: 'rId2',
        id: '2',
        name: 'Picture 1',
        x: 500000,
        y: 500000,
        w: 4000000,
        h: 3000000,
      },
    ],
  };
  return {
    slides: [slide0, slide1],
    slideWidth: 9144000,
    slideHeight: 6858000,
    media: { '1:rId2': pngBytes },
    fidelity: { level: 'L1', notes: [] },
  };
}

describe('pptxParser（fflate 流式）round-trip', () => {
  it('导出 → 解析：顺序/文本/格式/填充/图片字节 一致', async () => {
    const pres = buildPres();
    const bytes = await exportPptx(pres);
    expect(bytes.length).toBeGreaterThan(0);

    const parsed = await parsePptx(bytes);

    // 数量与顺序
    expect(parsed.slides).toHaveLength(2);

    // slide0：文本框 + 形状
    const s0 = parsed.slides[0];
    expect(s0.shapes).toHaveLength(2);

    const textShape = s0.shapes.find((s) => s.type === 'text');
    expect(textShape).toBeDefined();
    if (textShape && textShape.type === 'text') {
      expect(textShape.paragraphs[0].runs[0].text).toBe('Hello');
      expect(textShape.paragraphs[0].runs[0].bold).toBe(true);
      expect(textShape.paragraphs[0].runs[0].fontSize).toBe(32);
    }

    const rectShape = s0.shapes.find((s) => s.type === 'shape');
    expect(rectShape).toBeDefined();
    if (rectShape && rectShape.type === 'shape') {
      expect(rectShape.geom).toBe('ellipse');
      expect(rectShape.fill).toBe('#FF0000');
    }

    // slide1：图片存在
    const s1 = parsed.slides[1];
    const imgShape = s1.shapes.find((s) => s.type === 'image');
    expect(imgShape).toBeDefined();
    expect(imgShape?.type).toBe('image');

    // 媒体字节完整保留
    expect(parsed.media).toBeDefined();
    const mediaVals = Object.values(parsed.media!);
    expect(mediaVals).toHaveLength(1);
    expect(Array.from(mediaVals[0])).toEqual(Array.from(pngBytes));
  });

  it('缺少 presentation.xml 的非法包 → 抛错', async () => {
    const bad = zipSync({
      '[Content_Types].xml': new TextEncoder().encode('<?xml version="1.0"?><Types/>'),
    });
    await expect(parsePptx(bad)).rejects.toThrow(/presentation\.xml/);
  });
});
