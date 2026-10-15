/**
 * rehearseTiming.test.ts —— 演示「排练计时」advTm（自动换片时间）读写回归测试。
 *
 * 覆盖：
 *  1) 导出：仅有 advTm → 自闭合 `<p:transition advTm="N"/>`；
 *     advTm 与切换效果（fade / push）合并到同一 `<p:transition>`；
 *     无 advTm 时导出形态与改造前逐字节一致（零回归）。
 *  2) 解析：`<p:transition advTm="N">` → JkSlide.advanceAfterMs = N；
 *     非法 advTm（0 / 负数 / 非数字）一律忽略为 undefined。
 *  3) round-trip：export → parse，advTm 不丢。
 */
import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import JSZip from 'jszip';
import { exportPptx, parsePptx } from '../src/index';
import type { JkPresentation, JkSlide } from '../src/model/index';

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 读回指定 slideN.xml 文本 */
async function readSlideXml(bytes: Uint8Array, n = 1): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(`ppt/slides/slide${n}.xml`);
  if (!file) throw new Error(`缺少 ppt/slides/slide${n}.xml`);
  return file.async('string');
}

/** 单页演示文稿便捷构造 */
function oneSlide(slide: JkSlide): JkPresentation {
  return { slides: [slide], slideWidth: 9144000, slideHeight: 6858000 };
}

/* =========================================================================
 * 1) 导出
 * ========================================================================= */

describe('advTm 导出', () => {
  it('仅设 advTm（无切换效果）→ 自闭合 <p:transition advTm="N"/>', async () => {
    const bytes = await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 3000 }));
    const xml = await readSlideXml(bytes);
    expect(xml).toContain('<p:transition advTm="3000"/>');
    // 不得出现任何切换效果子元素
    expect(xml).not.toContain('<p:fade');
    expect(xml).not.toContain('<p:push');
  });

  it('advTm 与 fade 合并到同一 <p:transition>', async () => {
    const bytes = await exportPptx(oneSlide({ shapes: [], transition: 'fade', advanceAfterMs: 2500 }));
    const xml = await readSlideXml(bytes);
    expect(xml).toContain('<p:transition advTm="2500"><p:fade/></p:transition>');
  });

  it('advTm 与 slide（push）合并到同一 <p:transition>', async () => {
    const bytes = await exportPptx(oneSlide({ shapes: [], transition: 'slide', advanceAfterMs: 5000 }));
    const xml = await readSlideXml(bytes);
    expect(xml).toContain('<p:transition advTm="5000"><p:push dir="u"/></p:transition>');
  });

  it('非法 advTm（0 / 负数 / 非有限数）不写出 p:transition', async () => {
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bytes = await exportPptx(oneSlide({ shapes: [], advanceAfterMs: bad }));
      const xml = await readSlideXml(bytes);
      expect(xml).not.toContain('<p:transition');
      expect(xml).not.toContain('advTm');
    }
  });

  it('0 < advTm < 0.5（如 0.4）四舍五入为 0 → 不写出 advTm（避免无意义的「立即换片」）', async () => {
    const bytes = await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 0.4 }));
    const xml = await readSlideXml(bytes);
    expect(xml).not.toContain('advTm');
    expect(xml).not.toContain('<p:transition');
  });

  it('0.5 <= advTm < 1 四舍五入为 1 → 写出 advTm="1"', async () => {
    const bytes = await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 0.5 }));
    const xml = await readSlideXml(bytes);
    expect(xml).toContain('<p:transition advTm="1"/>');
  });
});

describe('无 advTm 零回归', () => {
  it('无切换效果且无 advTm → 不含 p:transition', async () => {
    const bytes = await exportPptx(oneSlide({ shapes: [] }));
    const xml = await readSlideXml(bytes);
    expect(xml).not.toContain('<p:transition');
  });

  it('仅 fade（无 advTm）→ 与改造前完全一致的 <p:transition><p:fade/></p:transition>', async () => {
    const bytes = await exportPptx(oneSlide({ shapes: [], transition: 'fade' }));
    const xml = await readSlideXml(bytes);
    expect(xml).toContain('<p:transition><p:fade/></p:transition>');
    expect(xml).not.toContain('advTm');
  });

  it('仅 slide（无 advTm）→ 与改造前完全一致的 <p:transition><p:push dir="u"/></p:transition>', async () => {
    const bytes = await exportPptx(oneSlide({ shapes: [], transition: 'slide' }));
    const xml = await readSlideXml(bytes);
    expect(xml).toContain('<p:transition><p:push dir="u"/></p:transition>');
    expect(xml).not.toContain('advTm');
  });
});

/* =========================================================================
 * 2) 解析（手写最小 pptx）
 * ========================================================================= */

/** 手写含 advTm 的最小 pptx：三页分别 2500 / 非法(0) / 非法(abc) */
function buildHandwrittenPptx(): Uint8Array {
  const enc = new TextEncoder();
  const slide = (advTm: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
  <p:transition ${advTm}/>
</p:sld>`;

  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${P}" xmlns:r="${R}">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
    <p:sldId id="258" r:id="rId3"/>
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`;

  const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>`;

  return zipSync({
    '[Content_Types].xml': enc.encode('<?xml version="1.0"?><Types/>'),
    'ppt/presentation.xml': enc.encode(presentation),
    'ppt/_rels/presentation.xml.rels': enc.encode(presRels),
    'ppt/slides/slide1.xml': enc.encode(slide('advTm="2500"')),
    'ppt/slides/slide2.xml': enc.encode(slide('advTm="0"')),
    'ppt/slides/slide3.xml': enc.encode(slide('advTm="abc"')),
  });
}

describe('advTm 解析', () => {
  it('合法 advTm 回读为数值；非法（0 / 非数字）忽略为 undefined', async () => {
    const parsed = await parsePptx(buildHandwrittenPptx());
    expect(parsed.slides).toHaveLength(3);
    expect(parsed.slides[0].advanceAfterMs).toBe(2500);
    expect(parsed.slides[1].advanceAfterMs).toBeUndefined();
    expect(parsed.slides[2].advanceAfterMs).toBeUndefined();
  });
});

/* =========================================================================
 * 3) round-trip
 * ========================================================================= */

describe('advTm round-trip', () => {
  it('export → parse：advTm 与切换效果均不丢', async () => {
    const pres = oneSlide({ shapes: [], transition: 'fade', advanceAfterMs: 4200 });
    const parsed = await parsePptx(await exportPptx(pres));
    expect(parsed.slides[0].advanceAfterMs).toBe(4200);
    expect(parsed.slides[0].transition).toBe('fade');
  });

  it('仅 advTm 且无切换效果：round-trip 后效果仍为 none', async () => {
    const parsed = await parsePptx(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 9000 })));
    expect(parsed.slides[0].advanceAfterMs).toBe(9000);
    expect(parsed.slides[0].transition).toBe('none');
  });
});
