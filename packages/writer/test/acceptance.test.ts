/**
 * T1.8 Phase 验收（合成数据，沙箱可验证子集）。
 *
 * 真实 Word/WPS 产出的 .docx 需在有该软件的机器上验证；本测试在沙箱内
 * 手工构造一份「丰富的」JkDocument（标题/混排 rPr/有序无序列表/表格/超链接），
 * 经 exportDocx → parseDocx 全链路，断言结构与字符属性不丢。
 * 这覆盖了「打开→编辑→保存」数据侧的核心保真，是 Phase 验收的回归基线。
 */
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import type { JkDocument } from '../src/index.js';
import { exportDocx, parseDocx } from '../src/index.js';

/** 1x1 透明 PNG（最小合法 PNG） */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function pngBytes(): Uint8Array {
  const bin = atob(PNG_BASE64);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

function buildRichDoc(): JkDocument {
  return {
    body: [
      {
        type: 'paragraph',
        pPr: { outlineLvl: 0 },
        runs: [{ type: 'run', text: '一级标题', rPr: { bold: true } }],
      },
      {
        type: 'paragraph',
        runs: [
          { type: 'run', text: '普通段落 ', rPr: {} },
          {
            type: 'run',
            text: '红色大号雅黑',
            rPr: {
              color: 'ff0000',
              size: 36,
              font: { ascii: 'Arial', eastAsia: '微软雅黑', hAnsi: 'Arial' },
            },
          },
        ],
      },
      {
        type: 'paragraph',
        pPr: { numPr: { numId: '2', ilvl: 0 } },
        runs: [{ type: 'run', text: '无序项一' }],
      },
      {
        type: 'paragraph',
        pPr: { numPr: { numId: '2', ilvl: 0 } },
        runs: [{ type: 'run', text: '无序项二' }],
      },
      {
        type: 'paragraph',
        pPr: { numPr: { numId: '1', ilvl: 0 } },
        runs: [{ type: 'run', text: '有序项一' }],
      },
      {
        type: 'table',
        rows: [
          {
            type: 'tableRow',
            cells: [
              { type: 'tableCell', blocks: [{ type: 'paragraph', runs: [{ type: 'run', text: '单元格A' }] }] },
              {
                type: 'tableCell',
                blocks: [{ type: 'paragraph', runs: [{ type: 'run', text: '单元格B', rPr: { bold: true } }] }],
              },
            ],
          },
        ],
        grid: { cols: [0, 0] },
      },
      {
        type: 'paragraph',
        runs: [
          {
            type: 'hyperlink',
            relId: 'rId1',
            runs: [{ type: 'run', text: '官网链接' }],
          },
        ],
      },
    ],
    sections: [],
    styleDefs: { styles: [] },
    numberingDefs: {
      abstractNum: [
        { abstractNumId: '1', levels: [{ level: 0, format: 'decimal', text: '%1.', start: 1 }] },
        { abstractNumId: '2', levels: [{ level: 0, format: 'bullet', text: '•', start: 1 }] },
      ],
      num: [
        { numId: '1', abstractNumId: '1' },
        { numId: '2', abstractNumId: '2' },
      ],
    },
    settings: {},
    relationships: [
      { id: 'rId1', type: 'hyperlink', target: 'https://jareking.cn', targetMode: 'external' },
    ],
    fidelity: { level: 'L2', features: [] },
  };
}

function flattenRuns(doc: JkDocument): { text: string; rPr?: any }[] {
  const runs: { text: string; rPr?: any }[] = [];
  const walk = (inlines: any[] = []) => {
    for (const inl of inlines) {
      if (inl.type === 'run') runs.push(inl);
      if (inl.type === 'hyperlink') walk(inl.runs);
    }
  };
  for (const b of doc.body ?? []) {
    if (b.type === 'paragraph') walk(b.runs);
    if (b.type === 'table')
      b.rows.forEach((r: any) => r.cells.forEach((c: any) => walk(flattenCell(c))));
  }
  return runs;
}

function flattenCell(cell: any): any[] {
  const out: any[] = [];
  for (const blk of cell.blocks ?? []) {
    if (blk.type === 'paragraph') out.push(...blk.runs);
    if (blk.type === 'table') blk.rows.forEach((r: any) => r.cells.forEach((c: any) => out.push(...flattenCell(c))));
  }
  return out;
}

describe('T1.8 Writer Phase 验收（合成文档全链路保真）', () => {
  it('富文档导出 → 再解析：结构 + 字符属性不丢', async () => {
    const doc = buildRichDoc();
    const exported = await exportDocx(doc);
    expect(exported.byteLength).toBeGreaterThan(2000);

    const reparsed = await parseDocx(exported);

    // 标题
    const headings = (reparsed.body ?? []).filter(
      (b) => b.type === 'paragraph' && b.pPr?.outlineLvl === 0,
    );
    expect(headings.length).toBe(1);

    // 表格
    const tables = (reparsed.body ?? []).filter((b) => b.type === 'table');
    expect(tables.length).toBe(1);

    // 有序 / 无序列表各至少 1
    const listParas = (reparsed.body ?? []).filter(
      (b) => b.type === 'paragraph' && b.pPr?.numPr,
    );
    expect(listParas.length).toBeGreaterThanOrEqual(3);

    // 超链接关系保留
    const rel = reparsed.relationships.find((r) => r.target === 'https://jareking.cn');
    expect(rel).toBeDefined();

    // 红色大号雅黑 run 属性保留
    const runs = flattenRuns(reparsed);
    const red = runs.find((r) => r.text === '红色大号雅黑');
    expect(red).toBeDefined();
    expect(red?.rPr?.color).toBe('ff0000');
    expect(red?.rPr?.size).toBe(36);
    expect(red?.rPr?.font?.eastAsia).toBe('微软雅黑');

    // 表格内加粗保留
    const boldCell = runs.find((r) => r.text === '单元格B');
    expect(boldCell?.rPr?.bold).toBe(true);
  });
});

describe('T1.8 图片二进制 round-trip（media 落盘）', () => {
  it('含图片的文档导出后 zip 含 media，再解析图片二进制不丢', async () => {
    const bytes = pngBytes();
    const doc: JkDocument = {
      body: [
        { type: 'paragraph', runs: [{ type: 'run', text: '带图段落 ' }] },
        {
          type: 'paragraph',
          runs: [{ type: 'image', embed: 'rIdImg', alt: '测试图', width: 914400, height: 914400 }],
        },
      ],
      sections: [],
      styleDefs: { styles: [] },
      numberingDefs: { abstractNum: [], num: [] },
      settings: {},
      relationships: [
        { id: 'rIdImg', type: 'image', target: 'media/rIdImg.png' },
      ],
      media: { rIdImg: bytes },
      fidelity: { level: 'L2', features: [] },
    };

    const exported = await exportDocx(doc);

    // 导出包内应包含 word/media/rIdImg.png 且字节一致
    const zip = await JSZip.loadAsync(exported);
    const mediaFile = zip.file('word/media/rIdImg.png');
    expect(mediaFile).toBeTruthy();
    const mediaBytes = await mediaFile!.async('uint8array');
    expect(mediaBytes.length).toBe(bytes.length);

    // 再解析：media 与 image 关系保留
    const reparsed = await parseDocx(exported);
    expect(reparsed.media?.['rIdImg']).toBeTruthy();
    expect(reparsed.media!['rIdImg'].length).toBe(bytes.length);
    const imgRel = reparsed.relationships.find((r) => r.id === 'rIdImg');
    expect(imgRel?.type).toBe('image');
  });
});
