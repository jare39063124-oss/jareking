/**
 * PPT 对象超链接（a:hlinkClick + slide rels）回归测试。
 *
 * 覆盖四块：
 *  1) 导出部件断言：含 hyperlink 的形状 → exportPptx → 读回 slideN.xml 含
 *     a:hlinkClick，且 slideN.xml.rels 含 hyperlink 关系（TargetMode=External、
 *     Target=URL），并校验 r:id 与形状引用一致；
 *  2) rId 不冲突：同页既有图片又有超链接时，两者的关系 id 互不相同；
 *  3) 解析：手写最小 pptx（含 hlinkClick + 外部/内部关系）→ parsePptx，
 *     断言外部超链接回填到 shape.hyperlink，内部跳转被忽略；
 *  4) round-trip：export → parse，超链接不丢；无超链接不影响既有导出。
 */
import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import JSZip from 'jszip';
import { exportPptx, parsePptx } from '../src/index';
import type { JkPresentation, JkSlide } from '../src/model/index';

/** 1×1 PNG（合法 PNG 签名，仅用于触发图片关系，内容不参与断言） */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngBytes = new Uint8Array(Buffer.from(PNG_B64, 'base64'));

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 读回指定 slideN.xml 文本 */
async function readSlideXml(bytes: Uint8Array, n = 1): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(`ppt/slides/slide${n}.xml`);
  if (!file) throw new Error(`缺少 ppt/slides/slide${n}.xml`);
  return file.async('string');
}

/** 读回指定 slideN.xml.rels 文本（可能不存在，返回空串） */
async function readSlideRels(bytes: Uint8Array, n = 1): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(`ppt/slides/_rels/slide${n}.xml.rels`);
  return file ? file.async('string') : '';
}

/* =========================================================================
 * 1) 导出部件断言
 * ========================================================================= */

describe('ppt 超链接导出部件', () => {
  it('含 hyperlink 的形状 → slide xml 含 a:hlinkClick 且 rels 含外部超链接关系（r:id 一致）', async () => {
    const url = 'https://jareking.example.com/docs';
    const slide: JkSlide = {
      shapes: [
        {
          type: 'text',
          id: '2',
          name: '链接文本',
          x: 1000000,
          y: 1000000,
          w: 3000000,
          h: 1000000,
          paragraphs: [{ runs: [{ text: '点我跳转' }] }],
          hyperlink: url,
        },
      ],
    };
    const pres: JkPresentation = {
      slides: [slide],
      slideWidth: 9144000,
      slideHeight: 6858000,
    };

    const bytes = await exportPptx(pres);
    const xml = await readSlideXml(bytes);
    const rels = await readSlideRels(bytes);

    // slide xml：cNvPr 内写 hlinkClick
    expect(xml).toContain('<a:hlinkClick r:id=');
    const m = /<a:hlinkClick r:id="(rId\d+)"\/>/.exec(xml);
    expect(m).not.toBeNull();
    const rid = m![1];

    // rels：同一 rId → hyperlink 关系，TargetMode=External，Target=URL
    expect(rels).toContain(`Id="${rid}"`);
    expect(rels).toContain('relationships/hyperlink"');
    expect(rels).toContain('TargetMode="External"');
    expect(rels).toContain(`Target="${url}"`);
  });

  it('同页既有图片又有超链接：hlinkClick 的 rId 与图片图片关系 rId 不冲突', async () => {
    const url = 'https://example.com/x';
    const slide: JkSlide = {
      shapes: [
        { type: 'image', relId: 'rId2', id: '3', name: '图', x: 0, y: 0, w: 1000000, h: 1000000 },
        {
          type: 'text',
          id: '4',
          name: '链接',
          x: 0,
          y: 0,
          w: 1000000,
          h: 1000000,
          paragraphs: [{ runs: [{ text: 't' }] }],
          hyperlink: url,
        },
      ],
    };
    const pres: JkPresentation = {
      slides: [slide],
      slideWidth: 9144000,
      slideHeight: 6858000,
      media: { '0:rId2': pngBytes },
    };

    const bytes = await exportPptx(pres);
    const xml = await readSlideXml(bytes);
    const rels = await readSlideRels(bytes);

    const hrefRid = /<a:hlinkClick r:id="(rId\d+)"\/>/.exec(xml)![1];
    const imgRid = /<Relationship Id="(rId\d+)" Type="[^"]*\/image"/.exec(rels)![1];

    // 两者都存在且不相等
    expect(rels).toContain(`Id="${hrefRid}"`);
    expect(rels).toContain(`Id="${imgRid}"`);
    expect(hrefRid).not.toBe(imgRid);
  });
});

/* =========================================================================
 * 2) 解析（手写最小 pptx）
 * ========================================================================= */

/** 手写含 hlinkClick 的最小 pptx：形状 1 外部链接、形状 2 内部跳转（应被忽略） */
function buildHandwrittenPptx(): Uint8Array {
  const enc = new TextEncoder();
  const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${P}" xmlns:r="${R}">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`;

  const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`;

  const sp = (id: number, name: string, rid: string, text: string) =>
    `<p:sp><p:nvSpPr>` +
    `<p:cNvPr id="${id}" name="${name}"><a:hlinkClick r:id="${rid}"/></p:cNvPr>` +
    `<p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="100000" y="200000"/><a:ext cx="3000000" cy="500000"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    ${sp(2, '外部链接框', 'rId3', '去官网')}
    ${sp(3, '内部跳转框', 'rId4', '跳到第 2 页')}
  </p:spTree></p:cSld>
</p:sld>`;

  const slideRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://wps.example.com/site" TargetMode="External"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="#slide2"/>
</Relationships>`;

  return zipSync({
    '[Content_Types].xml': enc.encode('<?xml version="1.0"?><Types/>'),
    'ppt/presentation.xml': enc.encode(presentation),
    'ppt/_rels/presentation.xml.rels': enc.encode(presRels),
    'ppt/slides/slide1.xml': enc.encode(slide),
    'ppt/slides/_rels/slide1.xml.rels': enc.encode(slideRels),
  });
}

describe('ppt 超链接解析', () => {
  it('手写 hlinkClick + rels → 外部链接回填 hyperlink；内部跳转忽略', async () => {
    const parsed = await parsePptx(buildHandwrittenPptx());
    expect(parsed.slides).toHaveLength(1);
    const shapes = parsed.slides[0].shapes;
    expect(shapes).toHaveLength(2);

    // 外部链接：rId3 → Target
    expect(shapes[0].hyperlink).toBe('https://wps.example.com/site');
    // 内部跳转（无 TargetMode=External）：v1 忽略
    expect(shapes[1].hyperlink).toBeUndefined();
  });
});

/* =========================================================================
 * 3) round-trip / 不回归
 * ========================================================================= */

describe('ppt 超链接 round-trip', () => {
  it('export → parse：超链接不丢', async () => {
    const url = 'https://roundtrip.example.com/a?b=1&c=2';
    const slide: JkSlide = {
      shapes: [
        {
          type: 'text',
          id: '2',
          name: '链接',
          x: 1000000,
          y: 1000000,
          w: 3000000,
          h: 1000000,
          paragraphs: [{ runs: [{ text: '超链接往返' }] }],
          hyperlink: url,
        },
      ],
    };
    const pres: JkPresentation = { slides: [slide], slideWidth: 9144000, slideHeight: 6858000 };

    const parsed = await parsePptx(await exportPptx(pres));
    expect(parsed.slides[0].shapes[0].hyperlink).toBe(url);
  });

  it('无超链接的形状导出不产生 a:hlinkClick 与 hyperlink 关系（不回归）', async () => {
    const slide: JkSlide = {
      shapes: [
        {
          type: 'text',
          id: '2',
          name: '普通文本',
          x: 0,
          y: 0,
          w: 1000000,
          h: 1000000,
          paragraphs: [{ runs: [{ text: '无链接' }] }],
        },
      ],
    };
    const pres: JkPresentation = { slides: [slide], slideWidth: 9144000, slideHeight: 6858000 };
    const bytes = await exportPptx(pres);
    const xml = await readSlideXml(bytes);
    const rels = await readSlideRels(bytes);

    expect(xml).not.toContain('hlinkClick');
    expect(rels).not.toContain('relationships/hyperlink');
  });
});
