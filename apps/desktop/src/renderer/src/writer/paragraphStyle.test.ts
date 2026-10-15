/**
 * 段落样式引用（样式管理器）HTML/docx 往返测试。
 *
 * 验证「应用样式 → 保存 → 再打开」主链路不丢样式引用：
 *  - jkToHtml：Paragraph.pPr.styleId → `<span data-jk-para-style="…">`；
 *  - htmlToJk：`<span data-jk-para-style>` → Paragraph.pPr.styleId（并剥离外层 span）；
 *  - exportDocx → parseDocx：`<w:pStyle w:val="…">` 与 styles.xml 定义均保留。
 */

import { describe, expect, it } from 'vitest';
import { exportDocx, parseDocx, type JkDocument, type Paragraph, type StyleSheet } from '@jareking/writer';
import { jkToHtml } from './jkToHtml';
import { htmlToJk } from './htmlToJk';

/** 构造含段落样式引用的最小文档 */
function makeDoc(styleId: string): JkDocument {
  return {
    body: [
      {
        type: 'paragraph',
        runs: [{ type: 'run', text: '正文内容' }],
        pPr: { styleId },
      },
    ],
    sections: [{ type: 'section' }],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships: [],
    fidelity: { level: 'L2', features: [] },
  };
}

describe('段落样式引用：HTML/docx 往返', () => {
  it('1. jkToHtml 把 pPr.styleId 渲染为 data-jk-para-style span', () => {
    const html = jkToHtml(makeDoc('MyStyle'));
    expect(html).toContain('data-jk-para-style="MyStyle"');
    expect(html).toContain('正文内容');
  });

  it('2. htmlToJk 读回 data-jk-para-style → Paragraph.pPr.styleId（并剥离外层 span）', () => {
    const doc = htmlToJk('<p><span data-jk-para-style="MyStyle">你好世界</span></p>');
    const p = doc.body[0] as Paragraph;
    expect(p.pPr?.styleId).toBe('MyStyle');
    const text = p.runs.map((r) => (r.type === 'run' ? r.text : '')).join('');
    expect(text).toBe('你好世界');
  });

  it('3. jkToHtml → htmlToJk 往返 styleId 不丢', () => {
    const html = jkToHtml(htmlToJk('<p><span data-jk-para-style="S1">A</span></p>'));
    expect(html).toContain('data-jk-para-style="S1"');
    const back = htmlToJk(html).body[0] as Paragraph;
    expect(back.pPr?.styleId).toBe('S1');
  });

  it('4. exportDocx 写出 w:pStyle 与 w:style，再解析后 styleId 保留', async () => {
    const doc = htmlToJk('<p><span data-jk-para-style="S1">A</span></p>');
    const styleDefs: StyleSheet = {
      styles: [
        {
          type: 'styleDef',
          styleId: 'S1',
          styleType: 'paragraph',
          name: '样式1',
          rPr: { bold: true, size: 28 },
        },
      ],
    };
    doc.styleDefs = styleDefs;

    const out = await exportDocx(doc);
    const re = await parseDocx(out);

    const p = re.body.find((b) => b.type === 'paragraph') as Paragraph;
    expect(p.pPr?.styleId).toBe('S1');
    // 样式定义表存在该样式（Word/WPS 打开后可继续编辑）
    expect(re.styleDefs.styles.some((s) => s.styleId === 'S1')).toBe(true);
  });
});
