/**
 * #46-B 图片 Blob URL 化 —— 注册表与 jkToHtml/htmlToJk 闭环单测。
 * 验证：Blob URL 替代 base64 后，图片字节在「加载→编辑器→保存」往返中不丢失。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MediaRegistry } from './mediaRegistry';
import { jkToHtml, extToMime } from './jkToHtml';
import { htmlToJk } from './htmlToJk';
import type { JkDocument } from '@jareking/writer';

// jsdom 未实现 URL.createObjectURL / revokeObjectURL，桩掉以便测试注册表生命周期
let created: string[] = [];
let revoked: string[] = [];
beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>).URL = Object.assign(
    (globalThis as unknown as { URL: typeof URL }).URL,
    {
      createObjectURL: (blob: Blob) => {
        const u = `blob:fake/${created.length}`;
        created.push(u);
        void blob;
        return u;
      },
      revokeObjectURL: (u: string) => {
        revoked.push(u);
      },
    },
  );
});
afterEach(() => {
  created = [];
  revoked = [];
});

describe('MediaRegistry', () => {
  it('set/blobUrl/bytes/entries 基本契约（blobUrl 幂等）', () => {
    const reg = new MediaRegistry();
    const bytes = new Uint8Array([1, 2, 3]);
    reg.set('rId1', bytes, 'image/png');
    expect(reg.bytes('rId1')).toBe(bytes);
    const url = reg.blobUrl('rId1');
    expect(typeof url).toBe('string');
    expect(reg.blobUrl('rId1')).toBe(url); // 幂等：第二次返回同一 URL
    const entries = [...reg.entries()];
    expect(entries.length).toBe(1);
    expect(entries[0][0]).toBe('rId1');
  });

  it('revokeAll 释放 Blob URL；clear 清空登记', () => {
    const reg = new MediaRegistry();
    reg.set('rId1', new Uint8Array([1]), 'image/png');
    const url = reg.blobUrl('rId1')!;
    reg.revokeAll();
    expect(revoked).toContain(url);
    // revoke 后再次 blobUrl 应重新创建（不同句柄）
    const url2 = reg.blobUrl('rId1')!;
    expect(url2).not.toBe(url);
    reg.clear();
    expect(reg.bytes('rId1')).toBeUndefined();
  });
});

/** 构造最小文档（含一张图片），仅用于 #46-B 链路验证 */
function makeImageDoc(): JkDocument {
  const bytes = new Uint8Array([137, 80, 78, 71]); // PNG 文件头
  return {
    body: [{ type: 'paragraph', runs: [{ type: 'image', embed: 'rId1', alt: '图' }] }],
    sections: [],
    styleDefs: { styles: [] },
    numberingDefs: { abstractNum: [], num: [] },
    settings: {},
    relationships: [{ id: 'rId1', type: 'image', target: 'media/rId1.png' }],
    media: { rId1: bytes },
    fidelity: { level: 'L2', features: [] },
  } as unknown as JkDocument;
}

describe('#46-B jkToHtml/htmlToJk Blob URL 闭环', () => {
  it('jkToHtml 输出 data-jk-media，且 mediaMap 注入 Blob URL（不回退 base64）', () => {
    const doc = makeImageDoc();
    const html = jkToHtml(doc, new Map([['rId1', 'blob:fake/abc']]));
    expect(html).toContain('data-jk-media="rId1"');
    expect(html).toContain('src="blob:fake/abc"');
    // 不提供 mediaMap 时回退 base64（向后兼容，测试/无 DOM 环境无回归）
    const html2 = jkToHtml(doc);
    expect(html2).toContain('data:image/png;base64,');
  });

  it('htmlToJk 凭 data-jk-media + mediaBytes 取回字节（保存不丢图）', () => {
    const doc = makeImageDoc();
    const html = jkToHtml(doc, new Map([['rId1', 'blob:fake/abc']]));
    const mediaBytes = new Map<string, Uint8Array>([['rId1', doc.media!.rId1]]);
    const jk = htmlToJk(html, mediaBytes);
    // 字节被保留到 media
    expect(jk.media?.rId1).toEqual(doc.media!.rId1);
    // 关系被保留（type=image, id=rId1）
    expect(jk.relationships?.some((r) => r.id === 'rId1' && r.type === 'image')).toBe(true);
    // 再导出 HTML 仍带 data-jk-media（往返稳定）
    const html3 = jkToHtml(jk, new Map([['rId1', 'blob:fake/abc']]));
    expect(html3).toContain('data-jk-media="rId1"');
  });

  it('新插入的 data URL 图片仍走解码分支（不被注册表路径误吞）', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const html = `<p><img src="${dataUrl}" alt="新图" /></p>`;
    const jk = htmlToJk(html); // 不传 mediaBytes
    const img = jk.body[0] && (jk.body[0] as { runs?: unknown[] }).runs?.[0] as { type: string; embed?: string };
    expect(img?.type).toBe('image');
    expect(img?.embed?.startsWith('rIdMedia')).toBe(true); // 新建 relId
  });

  it('extToMime 覆盖常见格式', () => {
    expect(extToMime('png')).toBe('image/png');
    expect(extToMime('jpg')).toBe('image/jpeg');
    expect(extToMime('jpeg')).toBe('image/jpeg');
    expect(extToMime('svg')).toBe('image/svg+xml');
    expect(extToMime('webp')).toBe('image/webp');
  });
});
