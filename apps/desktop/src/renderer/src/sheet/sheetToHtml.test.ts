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
