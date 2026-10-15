/**
 * htmlToJk —— TipTap HTML → JkDocument（T1.4）。
 *
 * 保存流程：编辑器 `getHTML()` → 本函数转回 @jareking/writer 模型 → `exportDocx` 序列化。
 * 使用浏览器 `DOMParser` 解析（渲染进程运行于 Electron 渲染线程，DOM 可用）。
 * 映射严格对齐 `document.ts`：
 *   - h1~h6 → Paragraph(outlineLvl) / p → Paragraph / strong→b / em→i / u→underline / s→strike
 *   - span 的 color / font-size 样式 → RunProperties
 *   - a → Hyperlink（新建 external relationship 并引用 relId）
 *   - ul/ol > li → Paragraph(numPr，引用默认编号定义)
 *   - table → Table（含 rows/cells/grid）
 *
 * 兜底：未知节点忽略；编号/超链接所需定义由本函数补全，确保 exportDocx 可生成合法 docx。
 */

import type {
  AbstractNumbering,
  Block,
  CommentRange,
  ConcreteNumbering,
  Hyperlink,
  Inline,
  JkDocument,
  Numbering,
  NumberingLevel,
  Paragraph,
  ParagraphProperties,
  Relationship,
  Run,
  RunProperties,
  Table as JkTable,
  TableCell as JkTableCell,
  TableRow as JkTableRow,
  TableShading,
} from '@jareking/writer';

/** 默认编号定义（保存时注入）：ol → numId "1"(decimal)，ul → numId "2"(bullet) */
const ORDERED_NUM_ID = '1';
const UNORDERED_NUM_ID = '2';

function defaultNumbering(): Numbering {
  const decimalLevel: NumberingLevel = {
    level: 0,
    format: 'decimal',
    text: '%1.',
    start: 1,
  };
  const bulletLevel: NumberingLevel = {
    level: 0,
    format: 'bullet',
    text: '•',
    start: 1,
  };
  const abstractNum: AbstractNumbering[] = [
    { abstractNumId: ORDERED_NUM_ID, levels: [decimalLevel] },
    { abstractNumId: UNORDERED_NUM_ID, levels: [bulletLevel] },
  ];
  const num: ConcreteNumbering[] = [
    { numId: ORDERED_NUM_ID, abstractNumId: ORDERED_NUM_ID },
    { numId: UNORDERED_NUM_ID, abstractNumId: UNORDERED_NUM_ID },
  ];
  return { abstractNum, num };
}

/** CSS 颜色 → 模型 6 位十六进制（不含 #）；无法识别则原样返回小写 */
function normalizeColor(input: string): string {
  let c = input.trim();
  // rgb()/rgba() → 6 位十六进制（浏览器常把 #fff 规范化为 rgb(...)）
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(c);
  if (rgb) {
    const toHex = (n: string) =>
      Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    return (toHex(rgb[1]) + toHex(rgb[2]) + toHex(rgb[3])).toLowerCase();
  }
  if (c.startsWith('#')) c = c.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(c)) {
    // #rgb → #rrggbb
    c = c
      .split('')
      .map((ch) => ch + ch)
      .join('');
  }
  if (/^[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  return c.toLowerCase();
}

/** pt/px 字号 → 半磅（half-point）。1pt = 1.333px */
function fontSizeToHalfPoint(value: number, unit: string): number {
  const pt = unit === 'px' ? value / 1.3333 : value;
  return Math.round(pt * 2);
}

/** 仅当 rPr 含有效属性时返回，否则 undefined（避免空对象） */
function cleanRPr(rPr: RunProperties): RunProperties | undefined {
  if (Object.keys(rPr).length === 0) return undefined;
  return rPr;
}

/** 从元素的 inline style（或 bgcolor 属性）读取底纹填充；非纯 6 位十六进制返回 undefined */
function readShd(el: Element): TableShading | undefined {
  const style = el.getAttribute('style') ?? '';
  let raw = '';
  const m = /(?:^|;)\s*background-color:\s*([^;]+)/.exec(style);
  if (m) raw = m[1].trim();
  else {
    const bg = el.getAttribute('bgcolor');
    if (bg) raw = bg.trim();
  }
  if (!raw) return undefined;
  const fill = normalizeColor(raw);
  if (!/^[0-9a-f]{6}$/.test(fill)) return undefined;
  return { fill };
}

interface ParseCtx {
  relationships: Relationship[];
  relSeq: number;
  /** 图片二进制载体（data URL 解码后按 rId 存放），随文档返回供导出写入 zip */
  media: Record<string, Uint8Array>;
  mediaSeq: number;
  /** #46-B：Blob URL 图片的 relId → 字节（来自 MediaRegistry），保存时据此取回 */
  mediaBytes?: Map<string, Uint8Array>;
}

/** data: URL → { bytes, ext }；非 data URL 返回 null */
function decodeDataUrl(src: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(src.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const b64 = m[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const extMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
  };
  const ext = extMap[mime] ?? 'png';
  return { bytes, ext };
}

/** 根据标签与 style 推导当前节点的字符属性（继承父级） */
function deriveRPr(tag: string, el: Element, parent: RunProperties): RunProperties {
  const rPr: RunProperties = { ...parent };
  switch (tag) {
    case 'strong':
    case 'b':
      rPr.bold = true;
      break;
    case 'em':
    case 'i':
      rPr.italic = true;
      break;
    case 'u':
      rPr.underline = 'single';
      break;
    case 's':
    case 'strike':
    case 'del':
      rPr.strike = true;
      break;
    case 'span': {
      const style = el.getAttribute('style') ?? '';
      const cm = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,8}|[a-z]+)/.exec(style);
      if (cm) rPr.color = normalizeColor(cm[1]);
      const sm = /(?:^|;)\s*font-size:\s*([\d.]+)\s*(pt|px)/.exec(style);
      if (sm) rPr.size = fontSizeToHalfPoint(parseFloat(sm[1]), sm[2]);
      // 字体族：单引号包裹，可能含空格（如 'Microsoft YaHei'）
      const fm = /(?:^|;)\s*font-family:\s*'?"?([^'";]+)'?"?/.exec(style);
      if (fm) {
        const fam = fm[1].trim();
        rPr.font = { ascii: fam, eastAsia: fam, hAnsi: fam };
      }
      break;
    }
    default:
      break;
  }
  return rPr;
}

/**
 * 递归收集元素内的行内节点（文本 → Run；a/span/strong... → 对应模型）。
 *
 * @param commentRanges 可选。传入时，遇到 `span[data-jk-comment]` 会记录其覆盖的
 *   run 索引区间（左闭右开）并以批注 id 归档，供保存时还原为 Paragraph.commentRanges。
 *   仅在段落顶层传递（超链接内不传，避免索引口径错位）。
 */
function collectInlines(
  node: Node,
  rPr: RunProperties,
  out: Inline[],
  ctx: ParseCtx,
  commentRanges?: CommentRange[],
): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (text) out.push({ type: 'run', text, rPr: cleanRPr(rPr) });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const childRPr = deriveRPr(tag, el, rPr);

  // Word 域 span（data-jk-field）：保留为 field 行内元素，避免降级为纯文本
  if (tag === 'span' && el.getAttribute('data-jk-field')) {
    const instr = el.getAttribute('data-jk-field') ?? '';
    const result = el.textContent ?? '';
    out.push({ type: 'field', instr, result: result || undefined });
    return;
  }

  // 公式 span（data-jk-formula）：保留为 formula 行内元素（导出为 OMML 原生公式）
  if (tag === 'span' && el.getAttribute('data-jk-formula')) {
    const text = el.getAttribute('data-jk-formula') ?? el.textContent ?? '';
    if (text.trim()) out.push({ type: 'formula', text: text.trim() });
    return;
  }

  // 批注 span（data-jk-comment）：记录其覆盖的 run 区间后递归子节点（剥离外层 span）
  if (tag === 'span' && el.getAttribute('data-jk-comment')) {
    const id = el.getAttribute('data-jk-comment') ?? '';
    const start = out.length;
    el.childNodes.forEach((c) => collectInlines(c, childRPr, out, ctx, commentRanges));
    const end = out.length;
    if (commentRanges && id && end > start) commentRanges.push({ id, start, end });
    return;
  }

  if (tag === 'a') {
    const url = el.getAttribute('href') ?? '#';
    const runs: Inline[] = [];
    el.childNodes.forEach((c) => collectInlines(c, childRPr, runs, ctx));
    const relId = `rId${++ctx.relSeq}`;
    ctx.relationships.push({
      id: relId,
      type: 'hyperlink',
      target: url,
      targetMode: /^https?:\/\//i.test(url) ? 'external' : 'internal',
    });
    const h: Hyperlink = { type: 'hyperlink', relId, runs };
    out.push(h);
    return;
  }

  if (tag === 'br') {
    out.push({ type: 'break', breakType: 'textWrapping' });
    return;
  }

  if (tag === 'img') {
    const src = el.getAttribute('src') ?? '';
    const alt = el.getAttribute('alt') ?? undefined;
    const relId = el.getAttribute('data-jk-media') ?? undefined;
    // 优先：来自注册表的 Blob URL 图片——凭 relId 直接取回模型字节，保留 relId 不新建
    if (relId && ctx.mediaBytes && ctx.mediaBytes.has(relId)) {
      const bytes = ctx.mediaBytes.get(relId)!;
      const ext = (relId.split('.').pop() ?? 'png').toLowerCase();
      ctx.media[relId] = bytes;
      if (!ctx.relationships.some((r) => r.id === relId)) {
        ctx.relationships.push({ id: relId, type: 'image', target: `media/${relId}.${ext}` });
      }
      out.push({ type: 'image', embed: relId, alt });
      return;
    }
    const decoded = decodeDataUrl(src);
    if (decoded) {
      // 内嵌图片（新插入的 data URL）：解码为二进制并登记为 image 关系 + media 载体
      const newRelId = `rIdMedia${++ctx.mediaSeq}`;
      ctx.media[newRelId] = decoded.bytes;
      ctx.relationships.push({
        id: newRelId,
        type: 'image',
        target: `media/${newRelId}.${decoded.ext}`,
      });
      out.push({ type: 'image', embed: newRelId, alt });
    } else {
      // 非 data URL（如外链/占位）：保留 src 作为 embed（导出时若无字节将降级）
      out.push({ type: 'image', embed: src, alt });
    }
    return;
  }

  // 其余标签（含 strong/em/u/s/span 及未知容器）递归子节点
  el.childNodes.forEach((c) => collectInlines(c, childRPr, out, ctx, commentRanges));
}

const ALIGN_MAP: Record<string, 'left' | 'center' | 'right' | 'justify'> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'justify',
};

/** 从元素 style 读取 text-align → jc */
function readAlign(el: Element): 'left' | 'center' | 'right' | 'justify' | undefined {
  const style = el.getAttribute('style') ?? '';
  const m = /(?:^|;)\s*text-align:\s*([a-z]+)/.exec(style);
  if (m && ALIGN_MAP[m[1]]) return ALIGN_MAP[m[1]];
  return undefined;
}

/** 默认正文字号（pt），用于把 em 缩进换算为 EMU */
const DEFAULT_BODY_PT = 12;

/**
 * 从元素 style 读取 text-indent → ind.firstLine（EMU）。
 * 支持 "2em"（按本段字号换算）与 px/pt 绝对值。
 */
function readFirstLineIndent(el: Element): number | undefined {
  const style = el.getAttribute('style') ?? '';
  const m = /(?:^|;)\s*text-indent:\s*([\d.]+)\s*(em|px|pt)/.exec(style);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (m[2] === 'em') {
    // 优先取本段内联字号；缺省按小四（12pt）估算
    const fs = /(?:^|;)\s*font-size:\s*([\d.]+)\s*(pt|px)/.exec(style);
    const pt = fs ? (fs[2] === 'px' ? Number(fs[1]) * 0.75 : Number(fs[1])) : DEFAULT_BODY_PT;
    return Math.round(value * pt * 12700);
  }
  return Math.round(value * (m[2] === 'px' ? 9525 : 12700));
}

/**
 * 从元素 style 读取 line-height → spacing.line/lineRule。
 * 无单位倍数（1.5 → 360/auto）；带 pt 绝对值（28pt → 560/exact）。
 */
function readLineHeight(el: Element): ParagraphProperties['spacing'] | undefined {
  const style = el.getAttribute('style') ?? '';
  const m = /(?:^|;)\s*line-height:\s*([\d.]+)\s*(pt|px)?/.exec(style);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (m[2]) {
    const pt = m[2] === 'px' ? value * 0.75 : value;
    return { line: Math.round(pt * 20), lineRule: 'exact' };
  }
  return { line: Math.round(value * 240), lineRule: 'auto' };
}

/** 解析一个段落/标题元素 → Paragraph */
function parseParagraph(el: Element, ctx: ParseCtx, numId?: string): Paragraph {
  const tag = el.tagName.toLowerCase();
  const runs: Inline[] = [];
  const commentRanges: CommentRange[] = [];
  el.childNodes.forEach((c) => collectInlines(c, {}, runs, ctx, commentRanges));

  const pPr: Paragraph['pPr'] = {};
  const hm = /^h([1-6])$/.exec(tag);
  if (hm) pPr.outlineLvl = Number(hm[1]) - 1;
  const jc = readAlign(el);
  if (jc) pPr.jc = jc;
  const firstLine = readFirstLineIndent(el);
  if (firstLine !== undefined) pPr.ind = { ...(pPr.ind ?? {}), firstLine };
  const lineSpacing = readLineHeight(el);
  if (lineSpacing) pPr.spacing = { ...(pPr.spacing ?? {}), ...lineSpacing };
  if (numId) pPr.numPr = { numId, ilvl: 0 };

  const para: Paragraph = {
    type: 'paragraph',
    runs,
    pPr: Object.keys(pPr).length ? pPr : undefined,
  };
  if (commentRanges.length) para.commentRanges = commentRanges;
  return para;
}

/** 解析一个单元格内的块（段落 / 嵌套表格） */
function parseCellBlocks(el: Element, ctx: ParseCtx): Block[] {
  const blocks: Block[] = [];
  el.childNodes.forEach((c) => {
    if (c.nodeType !== Node.ELEMENT_NODE) return;
    const child = c as Element;
    const tag = child.tagName.toLowerCase();
    if (tag === 'p' || /^h[1-6]$/.test(tag)) {
      blocks.push(parseParagraph(child, ctx));
    } else if (tag === 'table') {
      blocks.push(parseTable(child, ctx));
    } else if (tag === 'hr') {
      blocks.push({ type: 'paragraph', runs: [{ type: 'break', breakType: 'page' }] });
    }
    // 列表/其它容器在单元格内扁平化为段落（v1 简化）
  });
  if (!blocks.length) blocks.push({ type: 'paragraph', runs: [] });
  return blocks;
}

/** 解析表格 → Table（含单元格/行/表格三级底纹） */
function parseTable(el: Element, ctx: ParseCtx): JkTable {
  const tableShd = readShd(el);
  const rows: JkTableRow[] = [];
  el.querySelectorAll(':scope > tbody > tr, :scope > tr').forEach((trEl) => {
    const rowEl = trEl as Element;
    const rowShd = readShd(rowEl);
    const cells: JkTableCell[] = [];
    rowEl.querySelectorAll(':scope > td, :scope > th').forEach((tdEl) => {
      const cellEl = tdEl as Element;
      const cellShd = readShd(cellEl);
      const cell: JkTableCell = {
        type: 'tableCell',
        blocks: parseCellBlocks(cellEl, ctx),
      };
      if (cellShd) cell.cellPr = { ...cell.cellPr, shd: cellShd };
      cells.push(cell);
    });
    const row: JkTableRow = { type: 'tableRow', cells };
    if (rowShd) row.rowPr = { ...row.rowPr, shd: rowShd };
    rows.push(row);
  });

  const colCount = rows.length ? rows[0].cells.length : 0;
  const table: JkTable = {
    type: 'table',
    rows,
    grid: { cols: new Array(colCount).fill(0) },
  };
  if (tableShd) table.tablePr = { ...table.tablePr, shd: tableShd };
  return table;
}

/**
 * 主入口：HTML 字符串 → JkDocument。
 * 仅浏览器可用（依赖 DOMParser）。
 *
 * @param mediaBytes 可选。调用方注入的 `relId → 字节` 映射（MediaRegistry）。
 *   当 `<img>` 带 `data-jk-media="relId"` 且该映射含此 relId 时，直接取回模型字节，
 *   避免 Blob URL 不可还原导致保存后图片丢失（#46-B）。不提供时回退 base64 解码。
 * @param relSeqStart 可选。超链接等 `rId<n>` 序号续号起点（#46-A 分块保存用，避免与整文冲突）。
 * @param mediaSeqStart 可选。`rIdMedia<n>` 序号续号起点（#46-A 分块保存用）。
 */
export function htmlToJk(
  html: string,
  mediaBytes?: Map<string, Uint8Array>,
  relSeqStart = 0,
  mediaSeqStart = 0,
): JkDocument {
  const parser = new DOMParser();
  const dom = parser.parseFromString(html, 'text/html');
  const ctx: ParseCtx = {
    relationships: [],
    relSeq: relSeqStart,
    media: {},
    mediaSeq: mediaSeqStart,
    mediaBytes,
  };
  const blocks: Block[] = [];

  dom.body.childNodes.forEach((node) => {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === 'p' || /^h[1-6]$/.test(tag)) {
      blocks.push(parseParagraph(el, ctx));
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      const numId = tag === 'ol' ? ORDERED_NUM_ID : UNORDERED_NUM_ID;
      el.querySelectorAll(':scope > li').forEach((liEl) => {
        blocks.push(parseParagraph(liEl as Element, ctx, numId));
      });
      return;
    }
    if (tag === 'table') {
      blocks.push(parseTable(el, ctx));
      return;
    }
    if (tag === 'hr') {
      // 分页符（jkToHtml 把 Break(page) 渲染为 <hr>；TipTap HorizontalRule 同形）→ 保留为分页 Run
      blocks.push({
        type: 'paragraph',
        runs: [{ type: 'break', breakType: 'page' }],
      });
      return;
    }
    // 其它根级元素忽略
  });

  const doc: JkDocument = {
    body: blocks,
    sections: [],
    styleDefs: { styles: [] },
    numberingDefs: defaultNumbering(),
    settings: {},
    relationships: ctx.relationships,
    fidelity: { level: 'L2', features: [] },
  };
  if (Object.keys(ctx.media).length) doc.media = ctx.media;
  return doc;
}
