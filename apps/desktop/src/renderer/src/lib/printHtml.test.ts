/**
 * printHtml.test.ts —— 打印 HTML 包装纯函数验证（@page / charset / title / extraCss / escapeHtml）。
 */
import { describe, expect, it } from 'vitest';
import { PRINT_BASE_CSS, buildPrintDocument, escapeHtml } from './printHtml';

describe('escapeHtml', () => {
  it('转义 & < > " \' 五个字符', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    // 正常文本不受影响
    expect(escapeHtml('正文 A1 单元格')).toBe('正文 A1 单元格');
  });
});

describe('PRINT_BASE_CSS', () => {
  it('含默认 @page 与打印友好规则', () => {
    expect(PRINT_BASE_CSS).toContain('@page { size: 210mm 297mm; margin: 15mm; }');
    expect(PRINT_BASE_CSS).toContain('font-size:10.5pt');
    expect(PRINT_BASE_CSS).toContain('max-width:100%');
    expect(PRINT_BASE_CSS).toContain('border-collapse:collapse');
    expect(PRINT_BASE_CSS).toContain('display:table-header-group');
    expect(PRINT_BASE_CSS).toContain('page-break-inside:avoid');
    expect(PRINT_BASE_CSS).toContain('.jk-page-break{page-break-after:always;}');
  });
});

describe('buildPrintDocument', () => {
  it('默认 A4 纵向：@page 210x297 / margin 15mm，含 charset 与 title', () => {
    const html = buildPrintDocument({ title: '导出', bodyHtml: '<p>hello</p>' });
    expect(html).toContain('@page { size: 210mm 297mm; margin: 15mm; }');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>导出</title>');
    expect(html).toContain('<p>hello</p>');
  });

  it('横向 A4：size 互换为 297mm 210mm', () => {
    const html = buildPrintDocument({ title: 't', bodyHtml: '', landscape: true });
    expect(html).toContain('@page { size: 297mm 210mm; margin: 15mm; }');
  });

  it('自定义纸张与页边距：B5 / 10mm', () => {
    const html = buildPrintDocument({ title: 't', bodyHtml: '', pageSize: 'B5', marginMm: 10 });
    expect(html).toContain('@page { size: 182mm 257mm; margin: 10mm; }');
  });

  it('title 转义特殊字符', () => {
    const html = buildPrintDocument({ title: '<script>', bodyHtml: '' });
    expect(html).toContain('<title>&lt;script&gt;</title>');
  });

  it('extraCss 追加在基础 CSS 之后、</style> 之前', () => {
    const html = buildPrintDocument({ title: 't', bodyHtml: '', extraCss: '.x{color:red;}' });
    const baseIdx = html.indexOf(PRINT_BASE_CSS);
    const extraIdx = html.indexOf('.x{color:red;}');
    const styleEndIdx = html.indexOf('</style>');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(extraIdx).toBeGreaterThan(baseIdx);
    expect(extraIdx).toBeLessThan(styleEndIdx);
  });
});
