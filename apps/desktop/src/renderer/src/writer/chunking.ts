/**
 * chunking —— Writer 大文档分块/分页编辑（#46-A）。
 *
 * 问题：ProseMirror（TipTap）天然全量渲染，100MB+ 文档（大量段落/图片）会一次性
 * 把所有块级节点挂入 DOM，内存与首屏时间随文档长度线性膨胀，存在卡死/OOM 风险。
 *
 * 方案（低风险，与已上线的 PPT 缩略图条同构）：
 *  - 完整 JkDocument 始终留在内存作唯一真源（保存无损）；
 *  - 编辑器每次只渲染 body 的一个「切片」（chunk），DOM 节点数被锁在 chunk 大小；
 *  - 切换/保存前把当前切片经 htmlToJk 解析后的 body 写回整文对应区间；
 *  - 仅当 body 块数超过阈值才启用分块；普通小文档走原单文档路径，零回归。
 *
 * 纯函数，无 DOM 依赖，便于单测。
 */

import type { Block, JkDocument } from '@jareking/writer';

/** 超过此块数（块级元素数）启用分块编辑；普通文档不出现分页条 */
export const WRITER_CHUNK_BLOCK_THRESHOLD = 800;

/** 每个分块的块级元素上限（DOM 节点上限，间接约束首屏内存） */
export const WRITER_CHUNK_SIZE = 300;

/** 分块区间 [start, end) */
export interface ChunkRange {
  start: number;
  end: number;
}

/**
 * 计算 body 的分块区间。空文档返回单空区间。
 * 注意：切片在「块级」边界切分，不会从表格/段落内部切开，保结构完整。
 */
export function computeChunkRanges(
  bodyLen: number,
  chunkSize: number = WRITER_CHUNK_SIZE,
): ChunkRange[] {
  if (bodyLen <= 0) return [{ start: 0, end: 0 }];
  const ranges: ChunkRange[] = [];
  for (let s = 0; s < bodyLen; s += chunkSize) {
    ranges.push({ start: s, end: Math.min(bodyLen, s + chunkSize) });
  }
  return ranges;
}

/**
 * 从完整文档抽取某区间作为独立可渲染子文档。
 * 共享文档级字段引用（relationships/media/numberingDefs/styleDefs/sections），
 * 因此子文档的编号、图片、样式仍可由 jkToHtml 正确解析。
 */
export function extractChunk(doc: JkDocument, range: ChunkRange): JkDocument {
  return {
    ...doc,
    body: doc.body.slice(range.start, range.end),
  };
}

/**
 * 把编辑后的子文档 body 写回完整文档对应区间，并合并编辑过程中新生成的关系/媒体。
 * 区间 [start, end) 被 editedBody 整体替换（长度可不同，支持增删块）。
 * 关系按 id 去重（已存在则不重复添加）；媒体直接按 rId 写入。
 */
export function applyChunkEdits(
  fullDoc: JkDocument,
  range: ChunkRange,
  editedBody: Block[],
  editedDoc?: Pick<JkDocument, 'relationships' | 'media'>,
): void {
  fullDoc.body.splice(range.start, range.end - range.start, ...editedBody);

  if (editedDoc?.relationships?.length) {
    const existing = new Set((fullDoc.relationships ?? []).map((r) => r.id));
    if (!fullDoc.relationships) fullDoc.relationships = [];
    for (const r of editedDoc.relationships) {
      if (!existing.has(r.id)) {
        fullDoc.relationships.push(r);
        existing.add(r.id);
      }
    }
  }
  if (editedDoc?.media && Object.keys(editedDoc.media).length) {
    if (!fullDoc.media) fullDoc.media = {};
    for (const [k, v] of Object.entries(editedDoc.media)) {
      (fullDoc.media as Record<string, Uint8Array>)[k] = v as Uint8Array;
    }
  }
}

/**
 * 递归收集文档（含嵌套表格、超链接内联）中引用的图片 relId。
 * 用于分块时「仅」为当前切片图片构建 Blob URL，避免每次切换都重建全部。
 */
export function collectImageRelIds(doc: JkDocument): Set<string> {
  const ids = new Set<string>();
  const walkInline = (ins: unknown[]): void => {
    for (const it of ins) {
      const node = it as { type?: string; embed?: string; runs?: unknown[] };
      if (node.type === 'image' && node.embed) ids.add(node.embed);
      else if (node.type === 'hyperlink' && node.runs) walkInline(node.runs);
    }
  };
  const walkBlocks = (blocks: unknown[]): void => {
    for (const b of blocks) {
      const blk = b as {
        type?: string;
        runs?: unknown[];
        rows?: { cells?: { blocks?: unknown[] }[] }[];
      };
      if (blk.type === 'paragraph' && blk.runs) walkInline(blk.runs);
      else if (blk.type === 'table') {
        for (const row of blk.rows ?? []) {
          for (const cell of row.cells ?? []) walkBlocks(cell.blocks ?? []);
        }
      }
    }
  };
  walkBlocks(doc.body ?? []);
  return ids;
}

/** 整文中最大的「rId<数字>」（超链接等）序号，供分块保存时续号，避免冲突 */
export function maxRelSeq(fullDoc: JkDocument): number {
  let max = 0;
  for (const r of fullDoc.relationships ?? []) {
    const m = /^rId(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** 整文中最大的「rIdMedia<数字>」序号，供分块保存时续号，避免冲突 */
export function maxMediaSeq(fullDoc: JkDocument): number {
  let max = 0;
  for (const r of fullDoc.relationships ?? []) {
    const m = /^rIdMedia(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
