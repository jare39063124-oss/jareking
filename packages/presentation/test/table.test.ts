/**
 * PPT 表格（graphicFrame → a:tbl）回归测试。
 *
 * 覆盖三块：
 *  1) 导出部件断言：JkTableShape → exportPptx → 读回 slideN.xml，含 a:tbl /
 *     a:tblGrid 列数 / a:tr 行数 / 单元格文本；
 *  2) 解析：手写最小 pptx（含 graphicFrame/a:tbl）+ fflate zipSync → parsePptx，
 *     断言 shapes 含 table 且 colWidths/行列/文本正确；
 *  3) round-trip：export → parse，表格列数/行数/文本不丢。
 */
import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import JSZip from 'jszip';
import { exportPptx, parsePptx } from '../src/index';
import type { JkPresentation, JkSlide, JkTableCell, JkTableShape } from '../src/model/index';

/** 构造 3×3（或指定行列）表格形状，单元格文本为 `R{r}C{c}` */
function buildTable(rows = 3, cols = 3): JkTableShape {
  const colW = 1000000;
  const rowH = 500000;
  return {
    type: 'table',
    id: '10',
    name: '表格 1',
    x: 1000000,
    y: 1500000,
    w: colW * cols,
    h: rowH * rows,
    colWidths: Array.from({ length: cols }, () => colW),
    rows: Array.from({ length: rows }, (_, r) => ({
      cells: Array.from({ length: cols }, (_, c): JkTableCell => ({
        text: `R${r}C${c}`,
        fontSize: 16,
        align: 'center',
        bold: r === 0,
      })),
      height: rowH,
    })),
    height: rowH * rows,
  };
}

/** 单页含一个表格的演示文稿 */
function buildPres(table: JkTableShape): JkPresentation {
  const slide: JkSlide = { shapes: [table] };
  return {
    slides: [slide],
    slideWidth: 9144000,
    slideHeight: 6858000,
    fidelity: { level: 'L1', notes: [] },
  };
}

/** 读回指定 slideN.xml 文本 */
async function readSlideXml(bytes: Uint8Array, n = 1): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(`ppt/slides/slide${n}.xml`);
  if (!file) throw new Error(`缺少 ppt/slides/slide${n}.xml`);
  return file.async('string');
}

describe('ppt 表格导出部件', () => {
  it('导出：slide xml 含 a:tbl、3 列 gridCol、3 行 tr 与单元格文本', async () => {
    const table = buildTable(3, 3);
    const bytes = await exportPptx(buildPres(table));
    const xml = await readSlideXml(bytes);

    // graphicFrame + 原生表格结构
    expect(xml).toContain('<p:graphicFrame>');
    expect(xml).toContain('<a:tbl>');
    expect(xml).toContain(
      'uri="http://schemas.openxmlformats.org/drawingml/2006/table"',
    );
    expect(xml).toContain('<a:tblGrid>');

    // 列数 = 3，行数 = 3
    expect((xml.match(/<a:gridCol /g) ?? []).length).toBe(3);
    expect((xml.match(/<a:tr /g) ?? []).length).toBe(3);

    // 单元格文本存在（首末单元格）
    expect(xml).toContain('R0C0');
    expect(xml).toContain('R2C2');
    // 边框（最小可用 tcPr）与默认表样式
    expect(xml).toContain('<a:lnL ');
    expect(xml).toContain('{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}');
  });
});

describe('ppt 表格解析', () => {
  /** 手写含 graphicFrame/a:tbl 的最小 pptx（3 列 × 2 行） */
  function buildHandwrittenPptx(): Uint8Array {
    const enc = new TextEncoder();
    const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>`;

    const presRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`;

    const cell = (text: string) =>
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>` +
      `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="1800" b="1">` +
      `<a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:rPr>` +
      `<a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`;

    const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:graphicFrame>
      <p:nvGraphicFramePr>
        <p:cNvPr id="2" name="表格 1"/>
        <p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>
        <p:nvPr/>
      </p:nvGraphicFramePr>
      <p:xfrm><a:off x="2000000" y="1000000"/><a:ext cx="3000000" cy="1000000"/></p:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl>
          <a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>
          <a:tblGrid><a:gridCol w="1000000"/><a:gridCol w="1000000"/><a:gridCol w="1000000"/></a:tblGrid>
          <a:tr h="500000">${cell('A1')}${cell('B1')}${cell('C1')}</a:tr>
          <a:tr h="500000">${cell('A2')}${cell('B2')}${cell('C2')}</a:tr>
        </a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`;

    return zipSync({
      '[Content_Types].xml': enc.encode('<?xml version="1.0"?><Types/>'),
      'ppt/presentation.xml': enc.encode(presentation),
      'ppt/_rels/presentation.xml.rels': enc.encode(presRels),
      'ppt/slides/slide1.xml': enc.encode(slide),
    });
  }

  it('解析：手写 graphicFrame/a:tbl → JkTableShape（列宽/行列/文本/样式）', async () => {
    const parsed = await parsePptx(buildHandwrittenPptx());
    expect(parsed.slides).toHaveLength(1);

    const table = parsed.slides[0].shapes.find((s) => s.type === 'table');
    expect(table).toBeDefined();
    expect(table?.type).toBe('table');
    if (!table || table.type !== 'table') return;

    expect(table.name).toBe('表格 1');
    expect(table.x).toBe(2000000);
    expect(table.y).toBe(1000000);
    expect(table.height).toBe(1000000);

    // 列宽：3 列各 1000000；表格宽 = 列宽之和
    expect(table.colWidths).toEqual([1000000, 1000000, 1000000]);
    expect(table.w).toBe(3000000);

    // 行：2 行 × 3 列，文本正确
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].cells.map((c) => c.text)).toEqual(['A1', 'B1', 'C1']);
    expect(table.rows[1].cells.map((c) => c.text)).toEqual(['A2', 'B2', 'C2']);
    // 样式：字号 sz=1800 → 18pt；加粗；颜色；居中
    expect(table.rows[0].cells[0].fontSize).toBe(18);
    expect(table.rows[0].cells[0].bold).toBe(true);
    expect(table.rows[0].cells[0].color).toBe('#1F3864');
    expect(table.rows[0].cells[0].align).toBe('center');
  });
});

describe('ppt 表格 round-trip', () => {
  it('导出 → 解析：列数/行数/文本一致', async () => {
    const table = buildTable(3, 3);
    const bytes = await exportPptx(buildPres(table));
    const parsed = await parsePptx(bytes);

    const rt = parsed.slides[0].shapes.find((s) => s.type === 'table');
    expect(rt?.type).toBe('table');
    if (!rt || rt.type !== 'table') return;

    expect(rt.colWidths).toHaveLength(3);
    expect(rt.rows).toHaveLength(3);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(rt.rows[r].cells[c].text).toBe(`R${r}C${c}`);
      }
    }
    // 列宽逐列一致
    expect(rt.colWidths).toEqual(table.colWidths);
  });

  it('空表（无行）导出不应崩溃', async () => {
    const empty: JkTableShape = {
      type: 'table',
      id: '1',
      name: '空表',
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      colWidths: [],
      rows: [],
    };
    const bytes = await exportPptx(buildPres(empty));
    expect(bytes.length).toBeGreaterThan(0);
    const xml = await readSlideXml(bytes);
    expect(xml).toContain('<a:tbl>');
  });
});
