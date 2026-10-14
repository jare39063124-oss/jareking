/**
 * chunking.test.ts —— #46-A 分块编辑纯函数验证。
 * 覆盖：区间计算、切片抽取、写回（含关系/媒体合并）、图片 relId 收集、ID 续号计数。
 */
import { describe, expect, it } from 'vitest';
import type { Block, JkDocument, Relationship } from '@jareking/writer';
import {
  applyChunkEdits,
  collectImageRelIds,
  computeChunkRanges,
  extractChunk,
  maxMediaSeq,
  maxRelSeq,
} from './chunking';
import { htmlToJk } from './htmlToJk';
import { jkToHtml } from './jkToHtml';

function makeDoc(body: Block[], relationships: Relationship[] = []): JkDocument {
  return {
    body,
    sections: [],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships,
    fidelity: { level: 'L2', features: [] },
  };
}

function para(text: string): Block {
  return { type: 'paragraph', runs: [{ type: 'run', text }] } as Block;
}

function imageBlock(embed: string): Block {
  return {
    type: 'paragraph',
    runs: [{ type: 'image', embed }],
  } as unknown as Block;
}

describe('computeChunkRanges', () => {
  it('空文档返回单空区间', () => {
    expect(computeChunkRanges(0)).toEqual([{ start: 0, end: 0 }]);
  });
  it('恰好一个 chunk 大小返回单区间', () => {
    expect(computeChunkRanges(300)).toEqual([{ start: 0, end: 300 }]);
  });
  it('超过 chunk 大小按 300 切分', () => {
    expect(computeChunkRanges(350)).toEqual([
      { start: 0, end: 300 },
      { start: 300, end: 350 },
    ]);
  });
});

describe('extractChunk', () => {
  it('抽取区间切片且共享文档级字段', () => {
    const doc = makeDoc([para('a'), para('b'), para('c')]);
    const chunk = extractChunk(doc, { start: 1, end: 3 });
    expect(chunk.body.map((b) => (b as { runs: { text: string }[] }).runs[0].text)).toEqual([
      'b',
      'c',
    ]);
    expect(chunk.relationships).toBe(doc.relationships);
  });
});

describe('applyChunkEdits', () => {
  it('替换区间并合并新关系/媒体', () => {
    const doc = makeDoc([para('a'), para('b'), para('c'), para('d')]);
    const editedDoc = makeDoc([para('B'), para('C')]);
    editedDoc.relationships = [{ id: 'rId9', type: 'image', target: 'media/rId9.png' }];
    editedDoc.media = { rId9: new Uint8Array([1, 2, 3]) };
    applyChunkEdits(doc, { start: 1, end: 3 }, editedDoc.body, editedDoc);
    expect(doc.body.map((b) => (b as { runs: { text: string }[] }).runs[0].text)).toEqual([
      'a',
      'B',
      'C',
      'd',
    ]);
    expect(doc.relationships?.some((r) => r.id === 'rId9')).toBe(true);
    expect(doc.media?.rId9).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('合并时按 id 去重，避免重复关系', () => {
    const doc = makeDoc([para('a'), para('b')], [
      { id: 'rId1', type: 'image', target: 'media/rId1.png' },
    ]);
    const editedDoc = makeDoc([para('A')]);
    // 编辑时重复登记了已存在的 rId1（data-jk-media 还原路径）
    editedDoc.relationships = [{ id: 'rId1', type: 'image', target: 'media/rId1.png' }];
    editedDoc.media = { rId1: new Uint8Array([9]) };
    applyChunkEdits(doc, { start: 0, end: 1 }, editedDoc.body, editedDoc);
    const rId1Count = doc.relationships?.filter((r) => r.id === 'rId1').length ?? 0;
    expect(rId1Count).toBe(1);
    expect(doc.media?.rId1).toEqual(new Uint8Array([9]));
  });
});

describe('collectImageRelIds', () => {
  it('收集段落与嵌套表格中的图片 relId', () => {
    const table: Block = {
      type: 'table',
      rows: [
        {
          type: 'tableRow',
          cells: [
            {
              type: 'tableCell',
              blocks: [{ type: 'paragraph', runs: [{ type: 'image', embed: 'rId2' }] } as Block],
            },
          ],
        },
      ],
      grid: { cols: [1] },
    } as unknown as Block;
    const doc = makeDoc([imageBlock('rId1'), para('x'), table]);
    const ids = collectImageRelIds(doc);
    expect([...ids].sort()).toEqual(['rId1', 'rId2']);
  });

  it('收集超链接内的图片 relId', () => {
    const hyper: Block = {
      type: 'paragraph',
      runs: [
        {
          type: 'hyperlink',
          relId: 'rIdH',
          runs: [{ type: 'image', embed: 'rId3' }],
        } as unknown as never,
      ],
    } as Block;
    const doc = makeDoc([hyper]);
    expect([...collectImageRelIds(doc)]).toEqual(['rId3']);
  });
});

describe('ID 续号计数', () => {
  it('maxRelSeq 取 rId<n> 最大值', () => {
    const rels: Relationship[] = [
      { id: 'rId5', type: 'image', target: 'x' },
      { id: 'rIdMedia2', type: 'image', target: 'y' },
    ];
    expect(maxRelSeq(makeDoc([], rels))).toBe(5);
  });
  it('maxMediaSeq 取 rIdMedia<n> 最大值', () => {
    const rels: Relationship[] = [
      { id: 'rId5', type: 'image', target: 'x' },
      { id: 'rIdMedia2', type: 'image', target: 'y' },
      { id: 'rIdMedia7', type: 'image', target: 'z' },
    ];
    expect(maxMediaSeq(makeDoc([], rels))).toBe(7);
  });
});

describe('分块往返（切片→渲染→解析→写回）保留图片', () => {
  it('图片在切片往返后 embed 与字节不变', () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const doc = makeDoc(
      [para('a'), imageBlock('rId1'), para('b'), para('c'), para('d')],
      [{ id: 'rId1', type: 'image', target: 'media/rId1.png' }],
    );
    doc.media = { rId1: bytes };

    // 抽取含图片的切片 [1,3]
    const chunk = extractChunk(doc, { start: 1, end: 3 });
    // 渲染（需提供 mediaMap）
    const mediaMap = new Map<string, string>([['rId1', 'blob:fake']]);
    const html = jkToHtml(chunk, mediaMap);
    expect(html).toContain('data-jk-media="rId1"');

    // 解析回来（凭 mediaBytes 还原）
    const mediaBytes = new Map<string, Uint8Array>([['rId1', bytes]]);
    const edited = htmlToJk(html, mediaBytes);

    // 写回整文
    applyChunkEdits(doc, { start: 1, end: 3 }, edited.body, edited);
    const img = doc.body[1] as unknown as { runs: { type: string; embed?: string }[] };
    expect(img.runs[0].embed).toBe('rId1');
    expect(doc.media?.rId1).toEqual(bytes);
    // 关系去重后仍存在
    expect(doc.relationships?.some((r) => r.id === 'rId1')).toBe(true);
  });
});
