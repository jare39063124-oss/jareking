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
  ConcreteNumbering,
  Hyperlink,
  Inline,
  JkDocument,
  Numbering,
  NumberingLevel,
  Paragraph,
  Relationship,
  Run,
  RunProperties,
  Table as JkTable,
  TableCell as JkTableCell,
  TableRow as JkTableRow,
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

interface ParseCtx {
  relationships: Relationship[];
  relSeq: number;
  /** 图片二进制载体（data URL 解码后按 rId 存放），随文档返回供导出写入 zip */
  media: Record<string, Uint8Array>;
  mediaSeq: number;
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

/** 递归收集元素内的行内节点（文本 → Run；a/span/strong... → 对应模型） */
function collectInlines(node: Node, rPr: RunProperties, out: Inline[], ctx: ParseCtx): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    if (text) out.push({ type: 'run', text, rPr: cleanRPr(rPr) });
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const childRPr = deriveRPr(tag, el, rPr);

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
    const decoded = decodeDataUrl(src);
    if (decoded) {
      // 内嵌图片：解码为二进制并登记为 image 关系 + media 载体
      const relId = `rIdMedia${++ctx.mediaSeq}`;
      ctx.media[relId] = decoded.bytes;
      ctx.relationships.push({
        id: relId,
        type: 'image',
        target: `media/${relId}.${decoded.ext}`,
      });
      out.push({ type: 'image', embed: relId, alt });
    } else {
      // 非 data URL（如外链/占位）：保留 src 作为 embed（导出时若无字节将降级）
      out.push({ type: 'image', embed: src, alt });
    }
    return;
  }

  // 其余标签（含 strong/em/u/s/span 及未知容器）递归子节点
  el.childNodes.forEach((c) => collectInlines(c, childRPr, out, ctx));
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

/** 解析一个段落/标题元素 → Paragraph */
function parseParagraph(el: Element, ctx: ParseCtx, numId?: string): Paragraph {
  const tag = el.tagName.toLowerCase();
  const runs: Inline[] = [];
  el.childNodes.forEach((c) => collectInlines(c, {}, runs, ctx));

  const pPr: Paragraph['pPr'] = {};
  const hm = /^h([1-6])$/.exec(tag);
  if (hm) pPr.outlineLvl = Number(hm[1]) - 1;
  const jc = readAlign(el);
  if (jc) pPr.jc = jc;
  if (numId) pPr.numPr = { numId, ilvl: 0 };

  return {
    type: 'paragraph',
    runs,
    pPr: Object.keys(pPr).length ? pPr : undefined,
  };
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

/** 解析表格 → Table */
function parseTable(el: Element, ctx: ParseCtx): JkTable {
  const rows: JkTableRow[] = [];
  el.querySelectorAll(':scope > tbody > tr, :scope > tr').forEach((trEl) => {
    const rowEl = trEl as Element;
    const cells: JkTableCell[] = [];
    rowEl.querySelectorAll(':scope > td, :scope > th').forEach((tdEl) => {
      const cellEl = tdEl as Element;
      cells.push({
        type: 'tableCell',
        blocks: parseCellBlocks(cellEl, ctx),
      });
    });
    rows.push({ type: 'tableRow', cells });
  });

  const colCount = rows.length ? rows[0].cells.length : 0;
  return {
    type: 'table',
    rows,
    grid: { cols: new Array(colCount).fill(0) },
  };
}

/**
 * 主入口：HTML 字符串 → JkDocument。
 * 仅浏览器可用（依赖 DOMParser）。
 */
export function htmlToJk(html: string): JkDocument {
  const parser = new DOMParser();
  const dom = parser.parseFromString(html, 'text/html');
  const ctx: ParseCtx = { relationships: [], relSeq: 0, media: {}, mediaSeq: 0 };
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
