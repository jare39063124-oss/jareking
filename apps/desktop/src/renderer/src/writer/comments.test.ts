/**
 * Writer 批注 HTML 往返单测（jkToHtml ↔ htmlToJk）。
 *
 * 验证编辑器侧批注锚点的双向自洽：
 *  - jkToHtml 把 Paragraph.commentRanges 对应的 run 区间包裹为 span[data-jk-comment]；
 *  - htmlToJk 反向把 span[data-jk-comment] 还原为 commentRanges（并剥离外层 span）；
 *  - 往返稳定（再次 jkToHtml 结构一致）。
 *
 * 依赖 DOMParser（jsdom 环境，见 apps/desktop/vitest.config.ts）。
 */

import { describe, expect, it } from 'vitest';
import type { JkDocument, Paragraph } from '@jareking/writer';
import { jkToHtml } from './jkToHtml';
import { htmlToJk } from './htmlToJk';

/** 构造含单条批注（覆盖中间 run）的文档模型 */
function docWithComment(): JkDocument {
  return {
    body: [
      {
        type: 'paragraph',
        runs: [
          { type: 'run', text: '前缀文本' },
          { type: 'run', text: '被批注内容' },
          { type: 'run', text: '后缀文本' },
        ],
        commentRanges: [{ id: '1', start: 1, end: 2 }],
      },
    ],
    sections: [],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships: [],
    fidelity: { level: 'L2', features: [] },
  };
}

describe('Writer 批注 HTML 往返（jkToHtml ↔ htmlToJk）', () => {
  it('jkToHtml 把批注区间包裹为 span[data-jk-comment]，范围外文本不被包裹', () => {
    const html = jkToHtml(docWithComment());
    expect(html).toContain('data-jk-comment="1"');
    // 仅中间 run 被包裹：前缀/后缀在 span 之外
    expect(html).toMatch(
      /前缀文本<[^>]*data-jk-comment="1"[^>]*>被批注内容<\/span>后缀文本/,
    );
  });

  it('htmlToJk 还原 commentRanges 且剥离外层 span（文本完整）', () => {
    const html = jkToHtml(docWithComment());
    const doc = htmlToJk(html);
    const p = doc.body[0] as Paragraph;
    // 文本完整（span 被剥离，无多余空 run 影响文本）
    expect(p.runs.map((r) => (r.type === 'run' ? r.text : '')).join('')).toBe(
      '前缀文本被批注内容后缀文本',
    );
    // 批注区间精确还原
    expect(p.commentRanges).toEqual([{ id: '1', start: 1, end: 2 }]);
  });

  it('往返稳定：htmlToJk → jkToHtml 输出一致的批注结构', () => {
    const html1 = jkToHtml(docWithComment());
    const doc2 = htmlToJk(html1);
    const html2 = jkToHtml(doc2);
    expect(html2).toContain('data-jk-comment="1"');
    expect(html2).toMatch(
      /前缀文本<[^>]*data-jk-comment="1"[^>]*>被批注内容<\/span>后缀文本/,
    );
  });

  it('无批注段落不产生批注 span', () => {
    const doc = docWithComment();
    delete (doc.body[0] as Paragraph).commentRanges;
    const html = jkToHtml(doc);
    expect(html).not.toContain('data-jk-comment');
  });
});
