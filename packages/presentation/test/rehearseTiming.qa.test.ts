/**
 * rehearseTiming.qa.test.ts —— QA 独立反证测试（不依赖工程师既有用例的断言）。
 *
 * 第 2 轮（回归轮）变更：P2-3 修复后，`0 < advTm < 0.5`（如 0.4）不再写出 `advTm="0"`，
 * 故把第 1 轮记录该缺陷的探针翻转为正向断言（0.4 → 不写出 advTm），并补 advTm=0.5 / 500 / 499 边界。
 *
 * 目的：对 advTm（自动换片时间）读写做「敌意」边界验证，重点补齐工程师用例未覆盖的点：
 *  1) 无 advTm 时导出结果与改造前**逐字节**一致（零回归快照）；
 *  2) 导出端的取整 / 极端合法值（0.4 / 3000.7 / 超大值）是否产生 NaN 或非法 XML；
 *  3) 解析端对 -1 / abc / 超大 / 小数 / 空串 / 空白 的安全行为；
 *  4) 四态（效果 / advTm / 合并 / 皆无）与 p:transition 结构位置合法性；
 *  5) 多页 round-trip（fade+advTm / push+advTm / 仅 advTm / 无 transition）。
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

async function readSlideXml(bytes: Uint8Array, n = 1): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(`ppt/slides/slide${n}.xml`);
  if (!file) throw new Error(`缺少 ppt/slides/slide${n}.xml`);
  return file.async('string');
}

function oneSlide(slide: JkSlide): JkPresentation {
  return { slides: [slide], slideWidth: 9144000, slideHeight: 6858000 };
}

/**
 * 重建「改造前」serializeSlide 的空形状输出：仅用于零回归逐字节比对。
 * transitionXml 由调用方以旧三元表达式给出，与实现无关。
 */
function legacyEmptySlideXml(transitionXml: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '  <p:cSld><p:spTree>',
    '    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>',
    '    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>',
    '    ',
    '  </p:spTree></p:cSld>',
    '      ' + transitionXml,
    '</p:sld>',
  ].join('\n');
}

/* =========================================================================
 * A) 导出：零回归逐字节快照
 * ========================================================================= */
describe('QA·导出零回归（无 advTm 逐字节）', () => {
  it('无效果且无 advTm → 与 legacy 空形状输出逐字节一致', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [] })));
    expect(xml).toBe(legacyEmptySlideXml(''));
  });

  it('仅 fade（无 advTm）→ 与 legacy 输出逐字节一致', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], transition: 'fade' })));
    expect(xml).toBe(legacyEmptySlideXml('<p:transition><p:fade/></p:transition>'));
  });

  it('仅 slide（无 advTm）→ 与 legacy 输出逐字节一致', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], transition: 'slide' })));
    expect(xml).toBe(legacyEmptySlideXml('<p:transition><p:push dir="u"/></p:transition>'));
  });

  it('transition=none 显式传入 → 不写 p:transition', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], transition: 'none' })));
    expect(xml).toBe(legacyEmptySlideXml(''));
  });
});

/* =========================================================================
 * B) 导出：四态 + 取值边界
 * ========================================================================= */
describe('QA·导出四态与取值边界', () => {
  it('仅 advTm → 自闭合且无子元素（整段逐字节）', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 3000 })));
    expect(xml).toBe(legacyEmptySlideXml('<p:transition advTm="3000"/>'));
  });

  it('fade + advTm 合并到同一元素', async () => {
    const xml = await readSlideXml(
      await exportPptx(oneSlide({ shapes: [], transition: 'fade', advanceAfterMs: 2500 })),
    );
    expect(xml).toContain('<p:transition advTm="2500"><p:fade/></p:transition>');
    // 不允许出现两个 p:transition
    expect(xml.match(/<p:transition/g)?.length).toBe(1);
  });

  it('小数 advTm 四舍五入为整数（3000.7 → 3001）', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 3000.7 })));
    expect(xml).toContain('advTm="3001"');
    expect(xml).not.toContain('3000.7');
  });

  it('极小正数 advTm=0.4 → 舍入为 0 → 不写出 advTm（P2-3 修复：不再出现非法 advTm="0"）', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 0.4 })));
    // 修复后：0.4 四舍五入为 0，不再写出语义为「立即换片」的 advTm="0"
    expect(xml).not.toContain('advTm');
    expect(xml).not.toContain('<p:transition');
    expect(xml).not.toContain('NaN');
  });

  it('advTm=0.5 → 四舍五入为 1，写出 advTm="1"（边界收敛）', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 0.5 })));
    expect(xml).toContain('<p:transition advTm="1"/>');
  });

  it('advTm=500（恰好等于 MIN_ADVANCE_MS）→ 原样写出 advTm="500"', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 500 })));
    expect(xml).toContain('<p:transition advTm="500"/>');
  });

  it('advTm=499（低于 MIN）→ 导出端仍原样写出（下限过滤仅发生在 applyRehearsalTimings，导出为通用层）', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 499 })));
    expect(xml).toContain('<p:transition advTm="499"/>');
  });

  it('超大 advTm 保留为整数、不溢出为科学计数法', async () => {
    const xml = await readSlideXml(
      await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 99999999999 })),
    );
    expect(xml).toContain('advTm="99999999999"');
    expect(xml).not.toContain('e+');
    expect(xml).not.toContain('NaN');
  });

  it('非法 advTm（0 / 负数 / NaN / ±Infinity）一律不写出', async () => {
    for (const bad of [0, -1, -99999, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: bad })));
      expect(xml).not.toContain('advTm');
      expect(xml).not.toContain('<p:transition');
    }
  });
});

/* =========================================================================
 * C) 结构合法性
 * ========================================================================= */
describe('QA·导出结构合法性', () => {
  it('p:transition 位于 </p:cSld> 之后、</p:sld> 之前', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 3000 })));
    const iC = xml.indexOf('</p:cSld>');
    const iT = xml.indexOf('<p:transition');
    const iEnd = xml.indexOf('</p:sld>');
    expect(iC).toBeGreaterThan(-1);
    expect(iT).toBeGreaterThan(iC);
    expect(iT).toBeLessThan(iEnd);
  });

  it('属性名为裸名 advTm（不带命名空间前缀）', async () => {
    const xml = await readSlideXml(await exportPptx(oneSlide({ shapes: [], advanceAfterMs: 1234 })));
    expect(xml).toContain(' advTm="1234"');
    expect(xml).not.toContain('p:advTm');
  });
});

/* =========================================================================
 * D) 解析：非法 / 极端 advTm
 * ========================================================================= */
/** 手写最小 pptx，每页给出 p:transition 片段（可为空串） */
function handwrittenPptx(transitions: string[]): Uint8Array {
  const enc = new TextEncoder();
  const slide = (inner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
  </p:spTree></p:cSld>
  ${inner}
</p:sld>`;
  const sldIds = transitions
    .map((_, i) => `    <p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join('\n');
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${P}" xmlns:r="${R}">
  <p:sldIdLst>
${sldIds}
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`;
  const rels = transitions
    .map(
      (_, i) =>
        `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join('\n');
  const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
${rels}
</Relationships>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': enc.encode('<?xml version="1.0"?><Types/>'),
    'ppt/presentation.xml': enc.encode(presentation),
    'ppt/_rels/presentation.xml.rels': enc.encode(presRels),
  };
  transitions.forEach((inner, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = enc.encode(slide(inner));
  });
  return zipSync(files);
}

describe('QA·解析 advTm 极端值', () => {
  it('合法正整数解析为数值；0 / -1 / abc / 空属性 一律 undefined', async () => {
    const parsed = await parsePptx(
      handwrittenPptx([
        '<p:transition advTm="2500"/>',
        '<p:transition advTm="0"/>',
        '<p:transition advTm="-1"/>',
        '<p:transition advTm="abc"/>',
        '<p:transition/>',
      ]),
    );
    expect(parsed.slides.map((s) => s.advanceAfterMs)).toEqual([2500, undefined, undefined, undefined, undefined]);
  });

  it('超大 advTm 不抛错、不为 NaN', async () => {
    const parsed = await parsePptx(handwrittenPptx(['<p:transition advTm="99999999999"/>']));
    expect(parsed.slides[0].advanceAfterMs).toBe(99999999999);
    expect(Number.isNaN(parsed.slides[0].advanceAfterMs as number)).toBe(false);
  });

  it('小数 advTm 原样读回（3000.7）且不抛错', async () => {
    const parsed = await parsePptx(handwrittenPptx(['<p:transition advTm="3000.7"/>']));
    expect(parsed.slides[0].advanceAfterMs).toBe(3000.7);
  });

  it('合并形式 advTm + fade 能同时读回', async () => {
    const parsed = await parsePptx(
      handwrittenPptx(['<p:transition advTm="3000"><p:fade/></p:transition>']),
    );
    expect(parsed.slides[0].advanceAfterMs).toBe(3000);
    expect(parsed.slides[0].transition).toBe('fade');
  });
});

/* =========================================================================
 * E) 多页 round-trip
 * ========================================================================= */
describe('QA·多页 round-trip 保真', () => {
  it('fade+advTm / push+advTm / 仅 advTm / 无 transition 四页往返不丢', async () => {
    const pres: JkPresentation = {
      slideWidth: 9144000,
      slideHeight: 6858000,
      slides: [
        { shapes: [], transition: 'fade', advanceAfterMs: 4200 },
        { shapes: [], transition: 'slide', advanceAfterMs: 5000 },
        { shapes: [], advanceAfterMs: 9000 },
        { shapes: [] },
      ],
    };
    const parsed = await parsePptx(await exportPptx(pres));
    expect(parsed.slides).toHaveLength(4);
    expect(parsed.slides[0]).toMatchObject({ transition: 'fade', advanceAfterMs: 4200 });
    expect(parsed.slides[1]).toMatchObject({ transition: 'slide', advanceAfterMs: 5000 });
    expect(parsed.slides[2].transition).toBe('none');
    expect(parsed.slides[2].advanceAfterMs).toBe(9000);
    expect(parsed.slides[3].advanceAfterMs).toBeUndefined();
  });

  it('二次 export→parse 稳定（幂等）', async () => {
    const pres = oneSlide({ shapes: [], transition: 'fade', advanceAfterMs: 6000 });
    const once = await parsePptx(await exportPptx(pres));
    const twice = await parsePptx(await exportPptx(once));
    expect(twice.slides[0]).toMatchObject({ transition: 'fade', advanceAfterMs: 6000 });
  });
});
