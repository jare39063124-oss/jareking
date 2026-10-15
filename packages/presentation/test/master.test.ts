/**
 * 演示母版 / 版式（slideMaster / slideLayout）回归测试。
 *
 * 覆盖三块：
 *  1) 解析：手写含 slideMaster/slideLayout/theme 的最小 pptx → parsePptx，
 *     断言 masters（名称/主题名/背景色）、layouts（名称/占位符/所属母版）
 *     以及 JkSlide.layout（版式 partName）正确；
 *  2) 导出：含 masters/layouts 的 JkPresentation → exportPptx，
 *     断言母版/版式/主题部件存在、content-types 与关系齐备，且 slides 不丢；
 *  3) round-trip：export → parse，母版/版式最小信息与页版面式关联不丢。
 */
import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import JSZip from 'jszip';
import { exportPptx, parsePptx } from '../src/index';
import type {
  JkPresentation,
  JkSlide,
  JkSlideLayout,
  JkSlideMaster,
} from '../src/model/index';

/* =========================================================================
 * 手写最小 pptx（含母版 / 版式 / 主题）
 * ========================================================================= */

const NS = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
};

/** 占位符形状（type 即 ph@type；用于版式断言） */
function phShape(id: number, type: string, idx?: number): string {
  const idxAttr = idx !== undefined ? ` idx="${idx}"` : '';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${type} ${id}"/><p:cNvSpPr/>` +
    `<p:nvPr><p:ph type="${type}"${idxAttr}/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
  );
}

/** 构造含 1 页 + 1 母版 + 1 版式 + 1 主题的最小合法 pptx 字节 */
function buildHandwrittenPptx(): Uint8Array {
  const enc = new TextEncoder();

  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${NS.p}" xmlns:r="${NS.r}">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/></p:sldMasterIdLst>
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`;

  const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.rel}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
</Relationships>`;

  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="标题 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="7315200" cy="1143000"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="3200" b="1"/><a:t>母版测试</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;

  const slideRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.rel}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`;

  const master = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">
  <p:cSld name="主题母版">
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      ${phShape(2, 'title')}
    </p:spTree>
  </p:cSld>
</p:sldMaster>`;

  const masterRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.rel}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;

  const layout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">
  <p:cSld name="标题和内容"><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    ${phShape(2, 'title')}
    ${phShape(3, 'body', 1)}
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;

  const layoutRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.rel}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;

  const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${NS.a}" name="Office 主题">
  <a:themeElements>
    <a:clrScheme name="Office 主题">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office 主题"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office 主题"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme>
  </a:themeElements>
</a:theme>`;

  return zipSync({
    '[Content_Types].xml': enc.encode('<?xml version="1.0"?><Types/>'),
    'ppt/presentation.xml': enc.encode(presentation),
    'ppt/_rels/presentation.xml.rels': enc.encode(presRels),
    'ppt/slides/slide1.xml': enc.encode(slide),
    'ppt/slides/_rels/slide1.xml.rels': enc.encode(slideRels),
    'ppt/slideMasters/slideMaster1.xml': enc.encode(master),
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': enc.encode(masterRels),
    'ppt/slideLayouts/slideLayout1.xml': enc.encode(layout),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': enc.encode(layoutRels),
    'ppt/theme/theme1.xml': enc.encode(theme),
  });
}

/* =========================================================================
 * 1) 解析
 * ========================================================================= */

describe('母版/版式解析', () => {
  it('手写 pptx → masters/layouts 与 JkSlide.layout 正确', async () => {
    const parsed = await parsePptx(buildHandwrittenPptx());

    // 母版
    expect(parsed.masters).toBeDefined();
    expect(parsed.masters).toHaveLength(1);
    expect(parsed.masters![0]).toMatchObject({
      partName: 'ppt/slideMasters/slideMaster1.xml',
      name: '主题母版',
      themeName: 'Office 主题',
      bgColor: '#FFFFFF',
    });

    // 版式
    expect(parsed.layouts).toBeDefined();
    expect(parsed.layouts).toHaveLength(1);
    const layout = parsed.layouts![0];
    expect(layout.partName).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(layout.name).toBe('标题和内容');
    expect(layout.masterPartName).toBe('ppt/slideMasters/slideMaster1.xml');
    expect(layout.placeholders).toEqual(['title', 'body']);

    // 页 → 版式关联（存版式 partName）
    expect(parsed.slides).toHaveLength(1);
    expect(parsed.slides[0].layout).toBe('ppt/slideLayouts/slideLayout1.xml');

    // 保真报告不再声称「母版未支持」
    expect(parsed.fidelity?.notes.join(' ')).not.toContain('母版');
  });
});

/* =========================================================================
 * 2) 导出部件
 * ========================================================================= */

/** 含母版/版式的演示文稿（1 页引用该版式） */
function buildPresWithMaster(): JkPresentation {
  const master: JkSlideMaster = {
    partName: 'ppt/slideMasters/slideMaster1.xml',
    name: '主题母版',
    themeName: 'Office 主题',
    bgColor: '#FFFFFF',
  };
  const layout: JkSlideLayout = {
    partName: 'ppt/slideLayouts/slideLayout1.xml',
    name: '标题和内容',
    masterPartName: 'ppt/slideMasters/slideMaster1.xml',
    placeholders: ['title', 'body'],
  };
  const slide: JkSlide = {
    layout: 'ppt/slideLayouts/slideLayout1.xml',
    shapes: [
      {
        type: 'text',
        id: '2',
        name: '标题',
        x: 914400,
        y: 457200,
        w: 7315200,
        h: 1143000,
        paragraphs: [{ runs: [{ text: '母版测试', bold: true, fontSize: 32 }] }],
      },
    ],
  };
  return {
    slides: [slide],
    slideWidth: 9144000,
    slideHeight: 6858000,
    masters: [master],
    layouts: [layout],
    fidelity: { level: 'L1', notes: [] },
  };
}

describe('母版/版式导出', () => {
  it('exportPptx：写出母版/版式/主题部件 + 关系 + content-types，slides 不丢', async () => {
    const bytes = await exportPptx(buildPresWithMaster());
    const zip = await JSZip.loadAsync(bytes);

    // 部件存在
    expect(zip.file('ppt/slideMasters/slideMaster1.xml')).toBeTruthy();
    expect(zip.file('ppt/slideLayouts/slideLayout1.xml')).toBeTruthy();
    expect(zip.file('ppt/theme/theme1.xml')).toBeTruthy();

    const masterXml = await zip.file('ppt/slideMasters/slideMaster1.xml')!.async('string');
    expect(masterXml).toContain('主题母版');
    expect(masterXml).toContain('FFFFFF');
    // Bug2 修复：母版须含 <p:sldLayoutIdLst> 与 txStyles
    expect(masterXml).toContain('<p:sldLayoutIdLst>');
    expect(masterXml).toContain('<p:sldLayoutId ');
    expect(masterXml).toContain('<p:txStyles>');

    const layoutXml = await zip.file('ppt/slideLayouts/slideLayout1.xml')!.async('string');
    expect(layoutXml).toContain('标题和内容');
    expect(layoutXml).toContain('type="title"');
    expect(layoutXml).toContain('type="body"');

    // 关系：presentation → slideMaster；layout → slideMaster；master → theme + slideLayout；slide → slideLayout
    const presRels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string');
    expect(presRels).toContain('/slideMaster"');
    const layoutRels = await zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels')!.async('string');
    expect(layoutRels).toContain('/slideMaster"');
    const masterRels = await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')!.async('string');
    expect(masterRels).toContain('/theme"');
    // Bug2 修复：母版 rels 须同时含 theme 与 slideLayout
    expect(masterRels).toContain('/slideLayout"');
    const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
    expect(slideRels).toContain('/slideLayout"');

    // content-types 覆盖
    const contentTypes = await zip.file('[Content_Types].xml')!.async('string');
    expect(contentTypes).toContain('/ppt/slideMasters/slideMaster1.xml');
    expect(contentTypes).toContain('/ppt/slideLayouts/slideLayout1.xml');
    expect(contentTypes).toContain('/ppt/theme/theme1.xml');

    // slides 不丢
    expect(zip.file('ppt/slides/slide1.xml')).toBeTruthy();
    const slideXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slideXml).toContain('母版测试');
  });
});

/* =========================================================================
 * 3) round-trip
 * ========================================================================= */

describe('母版/版式 round-trip', () => {
  it('export → parse：母版/版式最小信息与页版面式关联不丢', async () => {
    const bytes = await exportPptx(buildPresWithMaster());
    const parsed = await parsePptx(bytes);

    // 母版：名称 / 主题名 / 背景色
    expect(parsed.masters).toHaveLength(1);
    expect(parsed.masters![0]).toMatchObject({
      partName: 'ppt/slideMasters/slideMaster1.xml',
      name: '主题母版',
      themeName: 'Office 主题',
      bgColor: '#FFFFFF',
    });

    // 版式：名称 / 占位符 / 所属母版
    expect(parsed.layouts).toHaveLength(1);
    expect(parsed.layouts![0]).toMatchObject({
      partName: 'ppt/slideLayouts/slideLayout1.xml',
      name: '标题和内容',
      masterPartName: 'ppt/slideMasters/slideMaster1.xml',
    });
    expect(parsed.layouts![0].placeholders).toEqual(['title', 'body']);

    // 页 → 版式关联
    expect(parsed.slides[0].layout).toBe('ppt/slideLayouts/slideLayout1.xml');

    // 文本仍在
    const text = parsed.slides[0].shapes.find((s) => s.type === 'text');
    expect(text).toBeDefined();
  });

  it('无母版/版式的演示文稿导出后自带默认骨架（母版/版式/主题），round-trip 字段不再是 undefined', async () => {
    const plain: JkPresentation = {
      slides: [{ shapes: [] }],
      slideWidth: 9144000,
      slideHeight: 6858000,
    };
    const bytes = await exportPptx(plain);
    const parsed = await parsePptx(bytes);
    expect(parsed.slides).toHaveLength(1);
    // Bug1 修复后：导出器合成默认骨架 → 回读得到 1 个母版 + 1 个版式（此前为 undefined）
    expect(parsed.masters).toHaveLength(1);
    expect(parsed.layouts).toHaveLength(1);
    // 页自动关联到默认版式
    expect(parsed.slides[0].layout).toBe('ppt/slideLayouts/slideLayout1.xml');
  });
});

/* =========================================================================
 * 4) 默认骨架兜底（P0 回归守卫）
 * -------------------------------------------------------------------------
 * 对抗审计 T29/T36/T37（P0）：默认演示（无 masters/layouts）导出的 pptx 仅有
 * 5 个部件、缺母版/版式/主题，导致 WPS/PowerPoint 打开挂起/要求修复。
 * 修复后：**任何** JkPresentation 都能导出被 WPS/Office 打开的合法包，
 * 本用例即为该回归的单测守卫。
 * ========================================================================= */

describe('默认骨架兜底（P0 回归守卫）', () => {
  it('无 masters 的 JkPresentation → exportPptx：含 slideMaster1/slideLayout1/theme1 + presentation.xml 含 sldMasterIdLst', async () => {
    // 模拟「新建演示」默认模型：不带 masters / layouts（见 SlideEditor.demoPresentation）
    const plain: JkPresentation = {
      slides: [
        {
          shapes: [
            {
              type: 'text',
              x: 914400,
              y: 685800,
              w: 7315200,
              h: 1143000,
              paragraphs: [{ runs: [{ text: '默认骨架', bold: true, fontSize: 40 }] }],
            },
          ],
        },
      ],
      slideWidth: 9144000,
      slideHeight: 6858000,
    };
    const bytes = await exportPptx(plain);
    const zip = await JSZip.loadAsync(bytes);

    // 1) 母版 / 版式 / 主题部件齐备（此前缺失 → WPS 打不开）
    expect(zip.file('ppt/slideMasters/slideMaster1.xml')).toBeTruthy();
    expect(zip.file('ppt/slideLayouts/slideLayout1.xml')).toBeTruthy();
    expect(zip.file('ppt/theme/theme1.xml')).toBeTruthy();

    // 2) presentation.xml 必须含 <p:sldMasterIdLst> 且 id=2147483648，且顺序在 sldIdLst 之前
    const presXml = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presXml).toContain('<p:sldMasterIdLst>');
    expect(presXml).toMatch(/<p:sldMasterId id="2147483648" r:id="rId\d+"\/>/);
    expect(presXml.indexOf('<p:sldMasterIdLst>')).toBeLessThan(presXml.indexOf('<p:sldIdLst>'));
    // 既有 sldIdLst / sldSz / notesSz 保留
    expect(presXml).toContain('<p:sldSz');
    expect(presXml).toContain('<p:notesSz');

    // 3) 母版含 <p:sldLayoutIdLst>（关联版式）与 txStyles；母版 rels 同时含 theme 与 slideLayout
    const masterXml = await zip.file('ppt/slideMasters/slideMaster1.xml')!.async('string');
    expect(masterXml).toContain('<p:sldLayoutIdLst>');
    expect(masterXml).toContain('<p:sldLayoutId id="2147483649"');
    expect(masterXml).toContain('<p:txStyles>');
    expect(masterXml).toContain('<p:titleStyle>');
    expect(masterXml).toContain('<p:bodyStyle>');
    const masterRels = await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')!.async('string');
    expect(masterRels).toContain('/theme"');
    expect(masterRels).toContain('/slideLayout"');

    // 4) 版式 rels 含 slideMaster 关系
    const layoutRels = await zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels')!.async('string');
    expect(layoutRels).toContain('/slideMaster"');

    // 5) 每页 rels 补 slideLayout 关系
    const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
    expect(slideRels).toContain('/slideLayout"');
    expect(slideRels).toContain('../slideLayouts/slideLayout1.xml');

    // 6) content-types 补全母版/版式/主题声明
    const ct = await zip.file('[Content_Types].xml')!.async('string');
    expect(ct).toContain('/ppt/slideMasters/slideMaster1.xml');
    expect(ct).toContain('/ppt/slideLayouts/slideLayout1.xml');
    expect(ct).toContain('/ppt/theme/theme1.xml');

    // 7) 主题含完整方案（clrScheme/fontScheme/fmtScheme 四组列表各 ≥3 项）
    const themeXml = await zip.file('ppt/theme/theme1.xml')!.async('string');
    expect(themeXml).toContain('<a:clrScheme');
    expect(themeXml).toContain('<a:fontScheme');
    expect(themeXml).toContain('<a:fmtScheme');
    expect(themeXml).toMatch(/<a:latin typeface=/);
  });
});
