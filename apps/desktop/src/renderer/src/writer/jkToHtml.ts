/**
 * jkToHtml —— JkDocument → TipTap 兼容 HTML（T1.4）。
 *
 * 把数据层（@jareking/writer）的文档模型序列化为 TipTap/StarterKit 能识别的 HTML
 * 字符串，用作编辑器初始 `content`。映射严格对齐 `document.ts` 字段定义：
 *   - Paragraph（含 pPr.outlineLvl / pPr.styleId → h1~h6；pPr.jc → text-align）
 *   - 连续 numPr 段落 → 合并为单组 <ol>/<ul>（编号格式来自 numberingDefs）
 *   - Run 的 rPr → <strong>/<em>/<u>/<s> 与 <span style="color/font-size/font-family">
 *   - Hyperlink → <a href>（URL 经 relationships 由 relId 解析）
 *   - Image → <img src="data:...">（二进制经 doc.media 还原为 data URL，编辑器可直接显示）
 *   - Break → <hr>（page）/ <br>（textWrapping）
 *   - Table → <table><tbody><tr><td>（单元格 blocks 递归）
 *
 * 纯函数、无 DOM 依赖，可在任意环境直接调用（便于单测/自检验证）。
 */

import type {
  Alignment,
  Block,
  Hyperlink,
  Inline,
  JkDocument,
  Paragraph,
  Run,
  RunProperties,
  Table as JkTable,
  TableShading,
} from '@jareking/writer';

/** 转义 HTML 文本节点中的特殊字符 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 模型颜色（6 位十六进制，不含 #）→ 带 # 的 CSS 颜色 */
function colorToCss(color: string): string {
  const c = color.trim().replace(/^#/, '');
  return `#${c}`;
}

/** 半磅字号（half-point）→ 磅（pt）字符串，如 24 → "12pt" */
function halfPointToPt(size: number): string {
  return `${(size / 2).toString()}pt`;
}

/** 底纹填充（6 位十六进制，不含 #）→ CSS background-color 片段；非纯十六进制或缺失返回 '' */
function shdBackground(shd?: TableShading): string {
  if (!shd?.fill) return '';
  if (!/^[0-9A-Fa-f]{6}$/.test(shd.fill)) return '';
  return `background-color:${colorToCss(shd.fill)};`;
}

/** 段落属性 → 标题级别 1~6；无则返回 null（普通段落） */
function headingLevel(pPr?: ParagraphProperties): number | null {
  if (!pPr) return null;
  if (typeof pPr.outlineLvl === 'number' && pPr.outlineLvl >= 0 && pPr.outlineLvl <= 5) {
    return pPr.outlineLvl + 1;
  }
  const sid = pPr.styleId;
  if (sid) {
    const m = /^(?:h|heading)?(\d)$/i.exec(sid.trim());
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 6) return n;
    }
  }
  return null;
}

/** 对齐方式 → CSS text-align 取值；Word 的 start/end 映射为 left/right（LTR） */
function alignToCss(jc?: Alignment): string | null {
  switch (jc) {
    case 'left':
    case 'start':
      return 'left';
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'justify':
    case 'distribute':
      return 'justify';
    default:
      return null;
  }
}

/** 根据编号定义判断某 numId 是有序（ol）还是无序（ul）列表 */
function isOrderedList(doc: JkDocument, numId: string): boolean {
  const numbering = doc.numberingDefs;
  if (!numbering) return false;
  const concrete = numbering.num.find((n) => n.numId === numId);
  if (!concrete) return false;
  const abs = numbering.abstractNum.find((a) => a.abstractNumId === concrete.abstractNumId);
  if (!abs || !abs.levels.length) return false;
  const lvl = abs.levels.find((l) => l.level === 0) ?? abs.levels[0];
  return lvl.format !== 'bullet';
}

/** Uint8Array → base64（兼容 Node/Browser，避免长数组展开溢出） */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 图片扩展名 → MIME */
function extToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

/** 把 rPr 格式化为嵌套的 HTML 标签（粗/斜/下划/删除线/颜色/字号/字体族） */
function wrapFormat(text: string, rPr?: RunProperties): string {
  if (!rPr) return text;
  let out = text;
  const fam = rPr.font?.eastAsia || rPr.font?.ascii || rPr.font?.hAnsi || rPr.font?.cs;
  if (fam) out = `<span style="font-family:'${fam.replace(/'/g, '')}'">${out}</span>`;
  if (rPr.color) out = `<span style="color:${colorToCss(rPr.color)}">${out}</span>`;
  if (rPr.size !== undefined) out = `<span style="font-size:${halfPointToPt(rPr.size)}">${out}</span>`;
  if (rPr.bold) out = `<strong>${out}</strong>`;
  if (rPr.italic) out = `<em>${out}</em>`;
  if (rPr.underline && rPr.underline !== 'none') out = `<u>${out}</u>`;
  if (rPr.strike) out = `<s>${out}</s>`;
  return out;
}

/** 渲染单个行内元素（Run / Hyperlink / Image / Break / FootnoteRef） */
function renderInline(
  inline: Inline,
  relMap: Map<string, string>,
  mediaMap: Map<string, string>,
): string {
  switch (inline.type) {
    case 'run': {
      const r = inline as Run;
      return wrapFormat(escapeHtml(r.text ?? ''), r.rPr);
    }
    case 'hyperlink': {
      const h = inline as Hyperlink;
      const url = (h.relId && relMap.get(h.relId)) || h.anchor || '#';
      const inner = (h.runs ?? []).map((r) => renderInline(r, relMap, mediaMap)).join('');
      return `<a href="${escapeHtml(url)}">${inner}</a>`;
    }
    case 'image': {
      const alt = inline.alt ? escapeHtml(inline.alt) : '';
      const src = mediaMap.get(inline.embed) ?? '';
      return `<img src="${escapeHtml(src)}" alt="${alt}" />`;
    }
    case 'break':
      return inline.breakType === 'page' ? '<hr />' : '<br />';
    case 'footnoteRef':
      return '';
    case 'field': {
      // 域：以带 data-jk-field / data-jk-field-result 的 span 呈现，编辑器（jkField 节点）保留其语义
      const instr = escapeHtml((inline as { instr?: string }).instr ?? '');
      const result = escapeHtml((inline as { result?: string }).result ?? '');
      return `<span data-jk-field="${instr}" data-jk-field-result="${result}" style="background:#EEF2FF;color:#3730A3;padding:0 2px;border-radius:2px">${result}</span>`;
    }
    default:
      return '';
  }
}

/** 渲染段落内部的行内序列 */
function renderRuns(
  runs: Inline[] | undefined,
  relMap: Map<string, string>,
  mediaMap: Map<string, string>,
): string {
  return (runs ?? []).map((r) => renderInline(r, relMap, mediaMap)).join('');
}

/** 渲染一个普通段落（非列表环境：标题或段落） */
function renderParagraph(
  p: Paragraph,
  relMap: Map<string, string>,
  mediaMap: Map<string, string>,
): string {
  const inner = renderRuns(p.runs, relMap, mediaMap);
  const align = alignToCss(p.pPr?.jc);
  const style = align ? ` style="text-align:${align}"` : '';
  const lvl = headingLevel(p.pPr);
  if (lvl) return `<h${lvl}${style}>${inner}</h${lvl}>`;
  return `<p${style}>${inner}</p>`;
}

/** 渲染表格单元格内的一组块（段落 / 嵌套表格），不支持单元格内列表分组 */
function renderCellBlocks(
  blocks: Block[] | undefined,
  relMap: Map<string, string>,
  mediaMap: Map<string, string>,
): string {
  const blocksArr = blocks ?? [];
  if (!blocksArr.length) return '<p></p>';
  return blocksArr
    .map((b) => {
      if (b.type === 'paragraph') return renderParagraph(b, relMap, mediaMap);
      if (b.type === 'table') return renderTable(b, relMap, mediaMap);
      return '';
    })
    .join('');
}

/** 渲染表格 → <table><tbody><tr><td>（含单元格/行/表格三级底纹） */
function renderTable(
  t: JkTable,
  relMap: Map<string, string>,
  mediaMap: Map<string, string>,
): string {
  const jc = alignToCss(t.tablePr?.jc);
  const alignStyle = jc && jc !== 'left' ? 'margin-left:auto;margin-right:auto;' : '';
  const tblBg = shdBackground(t.tablePr?.shd);
  const tableStyle = [alignStyle, tblBg].filter(Boolean).join(' ');
  const tableAttr = tableStyle ? ` style="${tableStyle}"` : '';
  const rows = t.rows
    .map((tr) => {
      const rowBg = shdBackground(tr.rowPr?.shd);
      const trAttr = rowBg ? ` style="${rowBg}"` : '';
      const cells = tr.cells
        .map((cell) => {
          const cellBg = shdBackground(cell.cellPr?.shd);
          const tdAttr = cellBg ? ` style="${cellBg}"` : '';
          return `<td${tdAttr}>${renderCellBlocks(cell.blocks, relMap, mediaMap)}</td>`;
        })
        .join('');
      return `<tr${trAttr}>${cells}</tr>`;
    })
    .join('');
  return `<table${tableAttr}><tbody>${rows}</tbody></table>`;
}

/**
 * 主入口：JkDocument → HTML 字符串。
 * 遍历 body 块；连续带相同 numId 的编号段落合并为单一 <ol>/<ul>。
 */
export function jkToHtml(doc: JkDocument): string {
  const relMap = new Map<string, string>();
  for (const rel of doc.relationships ?? []) {
    if (rel.targetMode === 'external' || /^https?:\/\//i.test(rel.target)) {
      relMap.set(rel.id, rel.target);
    }
  }

  // 图片二进制 → data URL（编辑器可直接显示）
  const mediaMap = new Map<string, string>();
  for (const rel of doc.relationships ?? []) {
    if (rel.type !== 'image') continue;
    const bytes = doc.media?.[rel.id];
    if (!bytes) continue;
    const ext = (rel.target.split('.').pop() ?? 'png').toLowerCase();
    mediaMap.set(rel.id, `data:${extToMime(ext)};base64,${bytesToBase64(bytes)}`);
  }

  const blocks: Block[] = doc.body ?? [];
  const html: string[] = [];
  let i = 0;

  while (i < blocks.length) {
    const blk = blocks[i];

    // 连续编号段落 → 合并为列表
    if (blk.type === 'paragraph' && blk.pPr?.numPr) {
      const numId = blk.pPr.numPr.numId;
      const ordered = isOrderedList(doc, numId);
      const tag = ordered ? 'ol' : 'ul';
      const items: string[] = [];
      while (
        i < blocks.length &&
        blocks[i].type === 'paragraph' &&
        (blocks[i] as Paragraph).pPr?.numPr?.numId === numId
      ) {
        const p = blocks[i] as Paragraph;
        items.push(`<li>${renderRuns(p.runs, relMap, mediaMap)}</li>`);
        i += 1;
      }
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    if (blk.type === 'paragraph') {
      html.push(renderParagraph(blk, relMap, mediaMap));
      i += 1;
      continue;
    }

    if (blk.type === 'table') {
      html.push(renderTable(blk, relMap, mediaMap));
      i += 1;
      continue;
    }

    // sectionBreak / paragraphBreak 等：忽略（v1 占位）
    i += 1;
  }

  return html.join('');
}
