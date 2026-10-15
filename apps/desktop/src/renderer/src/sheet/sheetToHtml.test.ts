/**
 * sheetToHtml.test.ts —— 工作簿 → 打印 HTML 表格验证（合并/样式/尺寸/裁剪/分页/转义）。
 */
import { describe, expect, it } from 'vitest';
import type { JkWorkbook } from '@jareking/sheet';
import { workbookToPrintBody } from './sheetToHtml';

function makeWorkbook(): JkWorkbook {
  return {
    sheets: [
      {
        name: '表<1>',
        rowCount: 100,
        colCount: 20,
        cells: {
          '0,0': { value: 'A&B', style: { bold: true, bgColor: '#FFFF00', align: 'center' } },
          '0,1': { value: 3.14159, style: { numFmt: '0.00' } },
          '1,0': { value: 0.25, style: { numFmt: '0.00%' } },
        },
        merges: [{ startRow: 2, startCol: 0, endRow: 3, endCol: 1 }],
        colWidths: { 0: 96 },
      },
      {
        name: '第二表',
        rowCount: 3,
        colCount: 2,
        cells: { '0,0': { value: 'x' } },
        merges: [],
      },
    ],
    activeSheetIndex: 0,
  };
}

describe('workbookToPrintBody', () => {
  it('工作表标题转义 + 多表插入分页符', () => {
    const html = workbookToPrintBody(makeWorkbook());
    expect(html).toContain('<h2 class="jk-sheet-title">表&lt;1&gt;</h2>');
    expect(html).toContain('<h2 class="jk-sheet-title">第二表</h2>');
    // 2 个工作表 → 恰好 1 个分页符
    expect((html.match(/jk-page-break/g) ?? []).length).toBe(1);
  });

  it('文本转义（& → &amp;）', () => {
    const html = workbookToPrintBody(makeWorkbook());
    expect(html).toContain('A&amp;B');
  });

  it('合并单元格生成 colspan/rowspan，且被覆盖格跳过', () => {
    const html = workbookToPrintBody(makeWorkbook());
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
    // 第一表 4x2 网格 8 格 − 合并覆盖 3 格 = 5 个 td；第二表 1 个 → 总 td 数 = 6
    expect((html.match(/<td /g) ?? []).length).toBe(6);
  });

  it('样式映射：bold / bgColor / align', () => {
    const html = workbookToPrintBody(makeWorkbook());
    expect(html).toContain('font-weight:bold');
    expect(html).toContain('background-color:#FFFF00');
    expect(html).toContain('text-align:center');
  });

  it('数字格式保守处理：小数位 toFixed，百分比 (v*100)%', () => {
    const html = workbookToPrintBody(makeWorkbook());
    expect(html).toContain('>3.14<');
    expect(html).toContain('>25.00%<');
  });

  it('列宽/行高换算为 mm（96dpi 假设）：96px → 25.40mm，默认列宽 64px', () => {
    const html = workbookToPrintBody(makeWorkbook());
    expect(html).toContain('width:25.40mm');
    // 未指定列宽的列 → 默认 64px → 16.93mm
    expect(html).toContain('width:16.93mm');
    // 默认行高 20px → 5.29mm
    expect(html).toContain('height:5.29mm');
  });

  it('尾部全空行/列裁剪：rowCount=100 但只渲染到有值/合并的最大行列', () => {
    const html = workbookToPrintBody(makeWorkbook());
    // 第一表：maxRow=3（合并）→ 4 行；maxCol=1 → 2 列
    const firstTableRows = (html.split('第二表')[0].match(/<tr /g) ?? []).length;
    expect(firstTableRows).toBe(4);
    const firstTableCols = (html.split('第二表')[0].match(/<col /g) ?? []).length;
    expect(firstTableCols).toBe(2);
  });

  it('activeOnly=true 仅渲染活动工作表（无分页符）', () => {
    const html = workbookToPrintBody(makeWorkbook(), { activeOnly: true });
    expect(html).toContain('表&lt;1&gt;');
    expect(html).not.toContain('第二表');
    expect((html.match(/jk-page-break/g) ?? []).length).toBe(0);
  });
});

/** 构造「合并区超出打印区域」用的最小工作簿（合并 A1:C3） */
function makeMergeWorkbook(): JkWorkbook {
  return {
    sheets: [
      {
        name: 'S',
        rowCount: 10,
        colCount: 10,
        cells: { '0,0': { value: 'M' } },
        merges: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 2 }],
      },
    ],
    activeSheetIndex: 0,
  };
}

describe('workbookToPrintBody 打印区域 / 重复标题行', () => {
  it('打印区域裁剪：区域外单元格不出现（含合并区被整体跳过）', () => {
    const html = workbookToPrintBody(makeWorkbook(), {
      activeOnly: true,
      printArea: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    });
    // 2×2 → 4 个 td；合并锚点（row2）在区域外 → 整块跳过 → 无 colspan/rowspan
    expect((html.match(/<td /g) ?? []).length).toBe(4);
    expect(html).not.toContain('colspan');
    expect(html).not.toContain('rowspan');
    // 区域外单元格（合并区 A3/A4）不出现
    expect(html).not.toContain('data-cell="A3"');
    expect(html).not.toContain('data-cell="A4"');
    // 区域内单元格出现
    expect(html).toContain('data-cell="A1"');
    expect(html).toContain('data-cell="B2"');
  });

  it('合并单元格被打印区域裁剪：colspan/rowspan 收敛到区域内', () => {
    const html = workbookToPrintBody(makeMergeWorkbook(), {
      activeOnly: true,
      printArea: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    });
    // A1:C3 与区域 A1:B2 相交 → 裁为 2×2
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
    expect(html).not.toContain('colspan="3"');
    expect(html).not.toContain('rowspan="3"');
    // 2×2 网格 − 合并覆盖 3 格 = 1 个 td
    expect((html.match(/<td /g) ?? []).length).toBe(1);
  });

  it('锚点在打印区域外的合并被跳过，不产生越界 colspan', () => {
    // makeWorkbook 的合并区 A3:B4 锚点在 row2，区域仅 row0..1 → 整块跳过
    const html = workbookToPrintBody(makeWorkbook(), {
      activeOnly: true,
      printArea: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
    });
    expect(html).not.toContain('colspan');
    expect(html).not.toContain('rowspan');
    expect(html).not.toContain('data-cell="A3"');
  });

  it('repeatRows 生成 <thead>，且表头行不与 <tbody> 重复输出', () => {
    const html = workbookToPrintBody(makeWorkbook(), {
      activeOnly: true,
      repeatRows: { startRow: 0, endRow: 0 },
    });
    expect((html.match(/<thead>/g) ?? []).length).toBe(1);
    expect(html).toContain('</thead>');
    expect(html).toContain('<tbody>');
    // 表头单元格仅出现一次（不重复输出）
    expect((html.match(/data-cell="A1"/g) ?? []).length).toBe(1);
    const theadSeg = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
    expect(theadSeg).toContain('data-cell="A1"');
    expect(theadSeg).not.toContain('data-cell="A2"');
    const tbodySeg = html.slice(html.indexOf('<tbody>'));
    expect(tbodySeg).toContain('data-cell="A2"');
  });

  it('非活动工作表不受 printArea 影响（仍整表输出）', () => {
    // 未加 activeOnly：区域仅作用于活动表（表<1>），第二表仍整表
    const html = workbookToPrintBody(makeWorkbook(), {
      printArea: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
    });
    expect(html).toContain('第二表');
    expect(html).toContain('>x<');
    const firstSeg = html.split('第二表')[0];
    const secondSeg = html.split('第二表')[1];
    // 活动表裁剪到 A1：1 个 td；非活动表整表：1 个 td
    expect((firstSeg.match(/<td /g) ?? []).length).toBe(1);
    expect((secondSeg.match(/<td /g) ?? []).length).toBe(1);
  });

  it('不传 opts（或空对象）时旧行为保持不变', () => {
    const a = workbookToPrintBody(makeWorkbook());
    const b = workbookToPrintBody(makeWorkbook(), {});
    expect(a).toBe(b);
    expect(a).not.toContain('<thead>');
  });

  it('repeatRows 与打印区域取交集，正文段保留合并 rowspan', () => {
    const html = workbookToPrintBody(makeWorkbook(), {
      activeOnly: true,
      printArea: { startRow: 0, startCol: 0, endRow: 3, endCol: 1 },
      repeatRows: { startRow: 0, endRow: 1 },
    });
    const theadSeg = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
    expect(theadSeg).toContain('data-cell="A1"');
    expect(theadSeg).toContain('data-cell="A2"');
    expect(theadSeg).not.toContain('data-cell="A3"');
    const tbodySeg = html.slice(html.indexOf('<tbody>'));
    // 合并区 A3:B4 落在正文段，rowspan 保持 2
    expect(tbodySeg).toContain('data-cell="A3"');
    expect(tbodySeg).toContain('rowspan="2"');
  });

  it('合并跨 thead/tbody 边界被裁剪，rowspan 不跨表段', () => {
    const wb: JkWorkbook = {
      sheets: [
        {
          name: 'S',
          rowCount: 10,
          colCount: 5,
          cells: { '0,0': { value: 'H' } },
          // 竖向合并 A1:A3，与「重复首行」表段边界相交
          merges: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 0 }],
        },
      ],
      activeSheetIndex: 0,
    };
    const html = workbookToPrintBody(wb, {
      activeOnly: true,
      repeatRows: { startRow: 0, endRow: 0 },
    });
    const theadSeg = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
    // 表头段内 rowspan 被裁为 1（不跨入正文导致结构错乱）
    expect(theadSeg).toContain('data-cell="A1"');
    expect(theadSeg).toContain('rowspan="1"');
    const tbodySeg = html.slice(html.indexOf('<tbody>'));
    expect(tbodySeg).toContain('data-cell="A2"');
    expect(tbodySeg).toContain('data-cell="A3"');
  });
});
