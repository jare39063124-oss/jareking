/**
 * pdfView 纯函数单测（PDF 阅读器：缩放 / 页码 / 搜索 / 可见页）。
 */
import { describe, it, expect } from 'vitest';
import {
  PDF_ZOOM_MIN,
  PDF_ZOOM_MAX,
  clampPdfZoom,
  fitScale,
  parsePageInput,
  countMatches,
  makeSnippet,
  resolveVisiblePage,
  shouldWarnContinuous,
} from './pdfView';

describe('clampPdfZoom', () => {
  it('钳制到 [MIN, MAX] 且保留两位小数', () => {
    expect(clampPdfZoom(0.1)).toBe(PDF_ZOOM_MIN);
    expect(clampPdfZoom(99)).toBe(PDF_ZOOM_MAX);
    expect(clampPdfZoom(1.1 + 0.2)).toBe(1.3); // 避免浮点误差（1.3000000000000003 → 1.3）
  });

  it('非有限值回退 100%', () => {
    expect(clampPdfZoom(Number.NaN)).toBe(1);
    expect(clampPdfZoom(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('fitScale', () => {
  const page = { width: 600, height: 800 };

  it('适应宽度按容器宽/页宽计算', () => {
    // 900 / 600 = 1.5
    expect(fitScale(page, { width: 900, height: 100 }, 'width')).toBe(1.5);
  });

  it('适应页面取宽高较小的 scale', () => {
    // 宽 900/600=1.5，高 400/800=0.5 → 取 0.5
    expect(fitScale(page, { width: 900, height: 400 }, 'page')).toBe(0.5);
  });

  it('结果同样受缩放区间钳制', () => {
    // 6000/600 = 10 → 钳制到 MAX
    expect(fitScale(page, { width: 6000, height: 6000 }, 'width')).toBe(PDF_ZOOM_MAX);
  });

  it('容器尺寸非法时回退 1', () => {
    expect(fitScale(page, { width: 0, height: 0 }, 'width')).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, { width: 800, height: 600 }, 'page')).toBe(1);
  });
});

describe('parsePageInput', () => {
  it('合法正整数原样返回', () => {
    expect(parsePageInput('3', 10)).toBe(3);
  });

  it('超出总页数钳制到末页', () => {
    expect(parsePageInput('999', 10)).toBe(10);
  });

  it('非法输入返回 null', () => {
    expect(parsePageInput('', 10)).toBeNull();
    expect(parsePageInput('0', 10)).toBeNull();
    expect(parsePageInput('-2', 10)).toBeNull();
    expect(parsePageInput('2.5', 10)).toBeNull();
    expect(parsePageInput('abc', 10)).toBeNull();
  });

  it('无页面（pageCount=0）返回 null', () => {
    expect(parsePageInput('1', 0)).toBeNull();
  });
});

describe('countMatches', () => {
  it('大小写不敏感且不重叠计数', () => {
    expect(countMatches('Foo foo FOO', 'foo')).toBe(3);
    expect(countMatches('aaaa', 'aa')).toBe(2); // 不重叠
  });

  it('空查询返回 0', () => {
    expect(countMatches('abc', '   ')).toBe(0);
  });
});

describe('makeSnippet', () => {
  it('居中截取并加省略号、折叠空白', () => {
    const text = `${'前'.repeat(30)}目标${'后'.repeat(30)}`;
    const idx = text.indexOf('目标');
    const snippet = makeSnippet(text, idx, 2, 5);
    expect(snippet).toContain('目标');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('短文本不裁剪时不加省略号', () => {
    expect(makeSnippet('hello world', 6, 5, 24)).toBe('hello world');
  });
});

describe('resolveVisiblePage', () => {
  it('返回距离容器顶部最近的页（1 基）', () => {
    expect(resolveVisiblePage([-500, -40, 900], 0)).toBe(2);
    expect(resolveVisiblePage([10, 800, 1600], 0)).toBe(1);
  });

  it('空数组回退到第 1 页', () => {
    expect(resolveVisiblePage([], 0)).toBe(1);
  });
});

describe('shouldWarnContinuous', () => {
  it('超过阈值告警', () => {
    expect(shouldWarnContinuous(201)).toBe(true);
    expect(shouldWarnContinuous(50)).toBe(false);
  });
});
