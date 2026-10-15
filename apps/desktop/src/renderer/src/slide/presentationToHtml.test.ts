/**
 * presentationToHtml.test.ts —— 演示文稿 → 逐页打印 HTML 验证
 * （文本/形状/图片两路/表格/旋转/超链接/EMU→mm/转义/分页）。
 */
import { describe, expect, it } from 'vitest';
import type { JkPresentation } from '@jareking/presentation';
import { SLIDE_PRINT_CSS, presentationToPrintBody } from './presentationToHtml';

function makePresentation(): JkPresentation {
  return {
    slideWidth: 9144000,
    slideHeight: 6858000,
    slides: [
      {
        shapes: [
          {
            type: 'text',
            x: 914400,
            y: 685800,
            w: 7315200,
            h: 1143000,
            paragraphs: [
              {
                runs: [{ text: '标题<&>', bold: true, fontSize: 32, color: '#1F3864' }],
                align: 'center',
                level: 1,
                bullet: true,
              },
            ],
          },
          {
            type: 'shape',
            geom: 'roundRect',
            x: 0,
            y: 0,
            w: 914400,
            h: 914400,
            fill: '#123456',
            rotation: 45,
            paragraphs: [{ runs: [{ text: '块' }] }],
          },
          { type: 'image', relId: 'rId1', x: 0, y: 0, w: 914400, h: 914400 },
          { type: 'image', relId: 'rId2', x: 0, y: 0, w: 914400, h: 914400 },
          {
            type: 'table',
            x: 0,
            y: 0,
            w: 914400,
            h: 914400,
            colWidths: [457200, 457200],
            rows: [
              {
                cells: [
                  { text: 'a', bold: true, align: 'right', fontSize: 12, color: '#000000' },
                  { text: 'b' },
                ],
              },
            ],
          },
          {
            type: 'text',
            hyperlink: 'https://example.com',
            x: 0,
            y: 0,
            w: 914400,
            h: 914400,
            paragraphs: [{ runs: [{ text: '链接' }] }],
          },
        ],
      },
      {
        shapes: [
          {
            type: 'text',
            x: 0,
            y: 0,
            w: 914400,
            h: 914400,
            paragraphs: [{ runs: [{ text: '第二页' }] }],
          },
        ],
      },
    ],
  };
}

const mediaMap = new Map<string, string>([['0:rId1', 'data:image/png;base64,AAAA']]);

describe('presentationToPrintBody', () => {
  it('EMU → mm 定位：914400 EMU → 25.4mm', () => {
    const html = presentationToPrintBody(makePresentation(), mediaMap);
    expect(html).toContain('left:25.4mm');
    expect(html).toContain('top:19.05mm');
    expect(html).toContain('width:203.2mm');
    // 画布尺寸（9144000 x 6858000 EMU = 254 x 190.5 mm）
    expect(html).toContain('width:254mm');
    expect(html).toContain('height:190.5mm');
  });

  it('文本转义 + 加粗/字号/颜色 + 对齐/缩进/项目符号', () => {
    const html = presentationToPrintBody(makePresentation());
    expect(html).toContain('标题&lt;&amp;&gt;');
    expect(html).toContain('<strong>');
    expect(html).toContain('font-size:32pt');
    expect(html).toContain('color:#1F3864');
    expect(html).toContain('text-align:center');
    expect(html).toContain('padding-left:1.5em');
    expect(html).toContain('jk-bullet');
  });

  it('预设形状：填充色 + roundRect 圆角 + 旋转', () => {
    const html = presentationToPrintBody(makePresentation());
    expect(html).toContain('background-color:#123456');
    expect(html).toContain('border-radius:8px');
    expect(html).toContain('transform:rotate(45deg)');
  });

  it('图片：有 media 走 src，缺 media 走虚线占位 [图片]', () => {
    const html = presentationToPrintBody(makePresentation(), mediaMap);
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(html).toContain('[图片]');
    expect(html).toContain('jk-image-missing');
  });

  it('表格：单元格加粗/对齐映射', () => {
    const html = presentationToPrintBody(makePresentation());
    expect(html).toContain('<table');
    expect(html).toContain('font-weight:bold');
    expect(html).toContain('text-align:right');
    expect(html).toContain('>a<');
  });

  it('超链接：包一层 <a href=... target=_blank rel=noreferrer>', () => {
    const html = presentationToPrintBody(makePresentation());
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer"');
  });

  it('分页：页数 = section 数；page-break-after 数量 = 页数 - 1', () => {
    const html = presentationToPrintBody(makePresentation());
    expect((html.match(/class="jk-slide"/g) ?? []).length).toBe(2);
    expect((html.match(/page-break-after:always/g) ?? []).length).toBe(1);
  });

  it('SLIDE_PRINT_CSS 含 shape 绝对定位规则', () => {
    expect(SLIDE_PRINT_CSS).toContain('.jk-slide{position:relative');
    expect(SLIDE_PRINT_CSS).toContain('.jk-shape{position:absolute');
  });
});
