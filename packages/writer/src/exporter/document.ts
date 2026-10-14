/**
 * document.xml 序列化（T1.5 导出器）。
 *
 * 把 `JkDocument` 的 `body` / `sections` 反向序列化为合法的 WordprocessingML，
 * 字段与单位映射**严格逆映射** `src/parser/docxParser.ts`（见 units.ts 说明）。
 *
 * 命名空间在根 `<w:document>` 上一次性声明：w / r / wp / a / pic，
 * 保证 Word/WPS 可正常打开（解析器虽用 removeNSPrefix，导出必须补全命名空间）。
 */

import type {
  Block,
  Hyperlink,
  Image,
  Inline,
  JkDocument,
  Paragraph,
  ParagraphProperties,
  Run,
  RunProperties,
  Section,
  SectionBreak,
  Table,
  TableBorders,
  TableCell,
  TableCellMargin,
  TableCellProperties,
  TableProperties,
  TableRow,
  TableShading,
} from '../model/document.js';
import { emuToTwips } from './units.js';
import { escapeXmlAttr, escapeXmlText, rawNodeToParts } from './xml.js';

/** 序列化上下文（图片 docPr id 自增等） */
interface Ctx {
  imageId: number;
}

/* =========================================================================
 * 1. 通用属性序列化（pPr / rPr）—— document.xml 与 styles.xml 共用
 * ========================================================================= */

/** 段落属性内部 XML（不含 <w:pPr> 包裹）；空则返回 '' */
export function pPrInner(pPr?: ParagraphProperties): string {
  if (!pPr) return '';
  const parts: string[] = [];
  if (pPr.styleId) parts.push(`<w:pStyle w:val="${escapeXmlAttr(pPr.styleId)}"/>`);
  if (pPr.keepNext) parts.push('<w:keepNext/>');
  if (pPr.pageBreakBefore) parts.push('<w:pageBreakBefore/>');
  if (pPr.numPr) {
    const { numId, ilvl } = pPr.numPr;
    parts.push(
      `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${escapeXmlAttr(numId)}"/></w:numPr>`,
    );
  }
  if (pPr.jc) parts.push(`<w:jc w:val="${escapeXmlAttr(pPr.jc)}"/>`);
  if (pPr.ind) {
    const ind: string[] = [];
    const left = emuToTwips(pPr.ind.left);
    const right = emuToTwips(pPr.ind.right);
    const firstLine = emuToTwips(pPr.ind.firstLine);
    const hanging = emuToTwips(pPr.ind.hanging);
    if (left !== undefined) ind.push(`w:left="${left}"`);
    if (right !== undefined) ind.push(`w:right="${right}"`);
    if (firstLine !== undefined) ind.push(`w:firstLine="${firstLine}"`);
    if (hanging !== undefined) ind.push(`w:hanging="${hanging}"`);
    if (ind.length) parts.push(`<w:ind ${ind.join(' ')}/>`);
  }
  if (pPr.spacing) {
    const sp: string[] = [];
    const before = emuToTwips(pPr.spacing.before);
    const after = emuToTwips(pPr.spacing.after);
    if (before !== undefined) sp.push(`w:before="${before}"`);
    if (after !== undefined) sp.push(`w:after="${after}"`);
    // 注意：line 解析器原值存储，导出原样写回（不除 635）
    if (pPr.spacing.line !== undefined) sp.push(`w:line="${pPr.spacing.line}"`);
    if (pPr.spacing.lineRule) sp.push(`w:lineRule="${escapeXmlAttr(pPr.spacing.lineRule)}"`);
    if (sp.length) parts.push(`<w:spacing ${sp.join(' ')}/>`);
  }
  if (pPr.outlineLvl !== undefined) parts.push(`<w:outlineLvl w:val="${pPr.outlineLvl}"/>`);
  // snapToGrid / widowControl：显式 false 时写回（OOXML 默认 true，丢失会被 WPS 按网格行距渲染致页数暴涨）
  if (pPr.snapToGrid === false) parts.push('<w:snapToGrid w:val="0"/>');
  if (pPr.widowControl === false) parts.push('<w:widowControl w:val="0"/>');
  return parts.join('');
}

/** 字符属性内部 XML（不含 <w:rPr> 包裹）；空则返回 '' */
export function rPrInner(rPr?: RunProperties): string {
  if (!rPr) return '';
  const parts: string[] = [];
  if (rPr.styleId) parts.push(`<w:rStyle w:val="${escapeXmlAttr(rPr.styleId)}"/>`);
  if (rPr.font) {
    const f = rPr.font;
    const fa: string[] = [];
    if (f.ascii) fa.push(`w:ascii="${escapeXmlAttr(f.ascii)}"`);
    if (f.eastAsia) fa.push(`w:eastAsia="${escapeXmlAttr(f.eastAsia)}"`);
    if (f.hAnsi) fa.push(`w:hAnsi="${escapeXmlAttr(f.hAnsi)}"`);
    if (f.cs) fa.push(`w:cs="${escapeXmlAttr(f.cs)}"`);
    if (f.hint) fa.push(`w:hint="${escapeXmlAttr(f.hint)}"`);
    if (fa.length) parts.push(`<w:rFonts ${fa.join(' ')}/>`);
  }
  // 标志型属性：仅在 true 时写空元素（与解析器 hasFlag 互逆）
  if (rPr.bold) parts.push('<w:b/>');
  if (rPr.italic) parts.push('<w:i/>');
  if (rPr.strike) parts.push('<w:strike/>');
  if (rPr.doubleStrike) parts.push('<w:dstrike/>');
  if (rPr.color) parts.push(`<w:color w:val="${escapeXmlAttr(rPr.color)}"/>`);
  // 字号 sz 为 half-point，原值写回（不除 635）；szCs 一并写出提升兼容性
  if (rPr.size !== undefined) {
    parts.push(`<w:sz w:val="${rPr.size}"/>`);
    parts.push(`<w:szCs w:val="${rPr.size}"/>`);
  }
  if (rPr.underline && rPr.underline !== 'none') {
    parts.push(`<w:u w:val="${escapeXmlAttr(rPr.underline)}"/>`);
  }
  if (rPr.verticalAlign) {
    const va =
      rPr.verticalAlign === 'superscript'
        ? 'sup'
        : rPr.verticalAlign === 'subscript'
          ? 'sub'
          : 'baseline';
    parts.push(`<w:vertAlign w:val="${va}"/>`);
  }
  if (rPr.highlight) parts.push(`<w:highlight w:val="${escapeXmlAttr(rPr.highlight)}"/>`);
  return parts.join('');
}

function wrapPPr(pPr?: ParagraphProperties): string {
  const inner = pPrInner(pPr);
  return inner ? `<w:pPr>${inner}</w:pPr>` : '';
}

function wrapRPr(rPr?: RunProperties): string {
  const inner = rPrInner(rPr);
  return inner ? `<w:rPr>${inner}</w:rPr>` : '';
}

/* =========================================================================
 * 2. 行内元素（Run / Hyperlink / Image / Break / FootnoteRef）
 * ========================================================================= */

function serializeRun(r: Run): string {
  const rPr = wrapRPr(r.rPr);
  const t = `<w:t xml:space="preserve">${escapeXmlText(r.text ?? '')}</w:t>`;
  return `<w:r>${rPr}${t}</w:r>`;
}

function serializeHyperlink(h: Hyperlink): string {
  const inner = h.runs.map((r) => serializeInline(r)).join('');
  if (h.relId) return `<w:hyperlink r:id="${escapeXmlAttr(h.relId)}">${inner}</w:hyperlink>`;
  if (h.anchor) return `<w:hyperlink w:anchor="${escapeXmlAttr(h.anchor)}">${inner}</w:hyperlink>`;
  return `<w:hyperlink>${inner}</w:hyperlink>`;
}

function serializeImage(img: Image, ctx: Ctx): string {
  ctx.imageId += 1;
  const id = ctx.imageId;
  const cx = img.width ?? 914400; // EMU 原值（drawing extent 已是 EMU，不除 635）
  const cy = img.height ?? 914400;
  const descr = img.alt ? ` descr="${escapeXmlAttr(img.alt)}"` : '';
  // 用 <w:r> 包裹 drawing：既是合法 OOXML（EG_RunInnerContent 含 w:drawing），
  // 也兼容本包解析器（仅对位于 <w:r> 内的 drawing 识别为 Image）。
  const drawing = `<w:drawing>
  <wp:inline distT="0" distB="0" distL="0" distR="0">
    <wp:extent cx="${cx}" cy="${cy}"/>
    <wp:effectExtent l="0" t="0" r="0" b="0"/>
    <wp:docPr id="${id}" name="Picture ${id}"${descr}/>
    <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
    <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="${escapeXmlAttr(img.embed)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData>
    </a:graphic>
  </wp:inline>
</w:drawing>`;
  return `<w:r>${drawing}</w:r>`;
}

function serializeBreak(b: Extract<Inline, { type: 'break' }>): string {
  if (b.breakType === 'page') return '<w:br w:type="page"/>';
  if (b.breakType === 'column') return '<w:br w:type="column"/>';
  return '<w:br/>';
}

function serializeInline(inline: Inline, ctx: Ctx = { imageId: 0 }): string {
  switch (inline.type) {
    case 'run':
      return serializeRun(inline);
    case 'hyperlink':
      return serializeHyperlink(inline);
    case 'image':
      return serializeImage(inline, ctx);
    case 'break':
      return serializeBreak(inline);
    case 'footnoteRef':
      // footnoteReference 必须位于 w:r 内（OOXML 约束），包裹后导出
      return `<w:r><w:footnoteReference w:id="${escapeXmlAttr(inline.id ?? '')}"/></w:r>`;
    case 'field': {
      // Word 域：以 fldSimple 还原，Word/WPS 打开后按指令重算（PAGE/NUMPAGES/DATE/TOC…）
      const result = inline.result
        ? `<w:r><w:t xml:space="preserve">${escapeXmlText(inline.result)}</w:t></w:r>`
        : '';
      return `<w:fldSimple w:instr="${escapeXmlAttr(inline.instr)}">${result}</w:fldSimple>`;
    }
    case 'formula': {
      // OMML 原生公式：线性文本装入 m:oMath，Word/WPS 打开后为可编辑公式对象
      return `<m:oMath><m:r><m:t xml:space="preserve">${escapeXmlText(inline.text)}</m:t></m:r></m:oMath>`;
    }
    default:
      return '';
  }
}

/* =========================================================================
 * 3. 块级元素（Paragraph / Table / SectionBreak / ParagraphBreak）
 * ========================================================================= */

function serializeParagraph(p: Paragraph, ctx: Ctx): string {
  const pPr = wrapPPr(p.pPr);
  const runs = p.runs.map((r) => serializeInline(r, ctx)).join('');
  return `<w:p>${pPr}${runs}</w:p>`;
}

function serializeTableBorders(b: TableBorders, tag: string): string {
  const sides: [string, keyof TableBorders][] = [
    ['top', 'top'],
    ['left', 'left'],
    ['bottom', 'bottom'],
    ['right', 'right'],
    ['insideH', 'insideHorizontal'],
    ['insideV', 'insideVertical'],
  ];
  const out: string[] = [];
  for (const [wtag, key] of sides) {
    const side = b[key];
    if (!side) continue;
    const attrs: string[] = [`w:val="${escapeXmlAttr(side.style)}"`];
    if (side.color) attrs.push(`w:color="${escapeXmlAttr(side.color)}"`);
    if (side.size !== undefined) attrs.push(`w:sz="${side.size}"`);
    out.push(`<w:${wtag} ${attrs.join(' ')}/>`);
  }
  return out.length ? `<w:${tag}>${out.join('')}</w:${tag}>` : '';
}

function serializeTableCellMargin(m: TableCellMargin): string {
  const map: [string, keyof TableCellMargin][] = [
    ['top', 'top'],
    ['left', 'left'],
    ['bottom', 'bottom'],
    ['right', 'right'],
  ];
  const out: string[] = [];
  for (const [wtag, key] of map) {
    const v = m[key];
    if (v === undefined) continue;
    const tw = emuToTwips(v);
    if (tw !== undefined) out.push(`<w:${wtag} w:w="${tw}" w:type="dxa"/>`);
  }
  return out.length ? `<w:tblCellMar>${out.join('')}</w:tblCellMar>` : '';
}

function serializeTblPr(tp?: TableProperties): string {
  if (!tp) return '';
  const parts: string[] = [];
  if (tp.styleId) parts.push(`<w:tblStyle w:val="${escapeXmlAttr(tp.styleId)}"/>`);
  if (tp.jc) parts.push(`<w:jc w:val="${escapeXmlAttr(tp.jc)}"/>`);
  if (tp.width !== undefined) {
    const w = emuToTwips(tp.width);
    if (w !== undefined) parts.push(`<w:tblW w:w="${w}" w:type="dxa"/>`);
  } else {
    // 无显式宽度（auto）：按页宽 100% 自适应 + autofit 布局。
    // 旧实现误写为 dxa 绝对值导致表格比例异常（用户反馈：表格与内容不匹配）；
    // pct 5000 = 50%×2 = 100%，由 Word/WPS 按内容与页宽自动分配列宽。
    parts.push('<w:tblW w:w="5000" w:type="pct"/>');
  }
  parts.push('<w:tblLayout w:type="autofit"/>');
  if (tp.borders) {
    const b = serializeTableBorders(tp.borders, 'tblBorders');
    if (b) parts.push(b);
  }
  if (tp.cellMargin) {
    const m = serializeTableCellMargin(tp.cellMargin);
    if (m) parts.push(m);
  }
  const shd = serializeShd(tp.shd);
  if (shd) parts.push(shd);
  return parts.length ? `<w:tblPr>${parts.join('')}</w:tblPr>` : '';
}

function serializeTblGrid(t: Table): string {
  let cols: number[] = [];
  if (t.grid && t.grid.cols.length) {
    cols = t.grid.cols.map((c) => emuToTwips(c) ?? 0);
  } else if (t.rows.length) {
    const n = t.rows[0].cells.length;
    for (let i = 0; i < n; i++) {
      const c = t.rows[0].cells[i];
      const w = c.cellPr?.width !== undefined ? emuToTwips(c.cellPr.width) ?? 0 : 0;
      cols.push(w);
    }
  }
  if (!cols.length || cols.every((c) => c === 0)) {
    // 列宽缺失时按页宽（约 9026 twips ≈ A4 减边距）均分，避免 0 宽表格
    const n = t.rows[0]?.cells.length ?? 1;
    const w = Math.floor(9026 / Math.max(1, n));
    cols = Array.from({ length: n }, () => w);
  }
  return `<w:tblGrid>${cols.map((c) => `<w:gridCol w:w="${c}"/>`).join('')}</w:tblGrid>`;
}

function serializeTableRow(tr: TableRow, ctx: Ctx): string {
  const parts: string[] = [];
  if (tr.rowPr) {
    const rp: string[] = [];
    const h = tr.rowPr.height !== undefined ? emuToTwips(tr.rowPr.height) : undefined;
    if (h !== undefined) rp.push(`<w:trHeight w:val="${h}"/>`);
    if (tr.rowPr.headerRepeat) rp.push('<w:tblHeader/>');
    const shd = serializeShd(tr.rowPr.shd);
    if (shd) rp.push(shd);
    if (rp.length) parts.push(`<w:trPr>${rp.join('')}</w:trPr>`);
  }
  for (const cell of tr.cells) parts.push(serializeTableCell(cell, ctx));
  return `<w:tr>${parts.join('')}</w:tr>`;
}

/** 底纹序列化（对应 w:shd）。fill 存在但 val 缺失时补 clear，确保填充生效。 */
function serializeShd(shd?: TableShading): string {
  if (!shd || (!shd.fill && !shd.color && !shd.val)) return '';
  const val = shd.val ?? (shd.fill ? 'clear' : undefined);
  const attrs: string[] = [];
  if (val) attrs.push(`w:val="${escapeXmlAttr(val)}"`);
  if (shd.color) attrs.push(`w:color="${escapeXmlAttr(shd.color)}"`);
  if (shd.fill) attrs.push(`w:fill="${escapeXmlAttr(shd.fill)}"`);
  return `<w:shd ${attrs.join(' ')}/>`;
}

function serializeTableCell(tc: TableCell, ctx: Ctx): string {
  const parts: string[] = [];
  const cp: TableCellProperties | undefined = tc.cellPr;
  if (cp) {
    const cpa: string[] = [];
    if (cp.width !== undefined) {
      const w = emuToTwips(cp.width);
      if (w !== undefined) cpa.push(`<w:tcW w:w="${w}" w:type="dxa"/>`);
    }
    if (cp.vAlign) cpa.push(`<w:vAlign w:val="${escapeXmlAttr(cp.vAlign)}"/>`);
    if (cp.gridSpan !== undefined) cpa.push(`<w:gridSpan w:val="${cp.gridSpan}"/>`);
    if (cp.vMerge) cpa.push(`<w:vMerge w:val="${escapeXmlAttr(cp.vMerge)}"/>`);
    if (cp.borders) {
      const b = serializeTableBorders(cp.borders, 'tcBorders');
      if (b) cpa.push(b);
    }
    const shd = serializeShd(cp.shd);
    if (shd) cpa.push(shd);
    if (cpa.length) parts.push(`<w:tcPr>${cpa.join('')}</w:tcPr>`);
  }
  const blocks = tc.blocks.length
    ? tc.blocks.map((b) => serializeBlock(b, ctx)).join('')
    : '<w:p/>';
  parts.push(blocks);
  return `<w:tc>${parts.join('')}</w:tc>`;
}

function serializeTable(t: Table, ctx: Ctx): string {
  const tblPr = serializeTblPr(t.tablePr);
  const grid = serializeTblGrid(t);
  const rows = t.rows.map((r) => serializeTableRow(r, ctx)).join('');
  return `<w:tbl>${tblPr}${grid}${rows}</w:tbl>`;
}

function buildSectPr(section: Section, breakType?: SectionBreak['breakType']): string {
  const inner: string[] = [];
  if (section.pageSize) {
    const w = emuToTwips(section.pageSize.width);
    const h = emuToTwips(section.pageSize.height);
    const attrs: string[] = [];
    if (w !== undefined) attrs.push(`w:w="${w}"`);
    if (h !== undefined) attrs.push(`w:h="${h}"`);
    if (section.orientation) attrs.push(`w:orient="${escapeXmlAttr(section.orientation)}"`);
    if (attrs.length) inner.push(`<w:pgSz ${attrs.join(' ')}/>`);
  }
  if (section.pageMargin) {
    const m = section.pageMargin;
    const a: string[] = [];
    const top = emuToTwips(m.top);
    const right = emuToTwips(m.right);
    const bottom = emuToTwips(m.bottom);
    const left = emuToTwips(m.left);
    if (top !== undefined) a.push(`w:top="${top}"`);
    if (right !== undefined) a.push(`w:right="${right}"`);
    if (bottom !== undefined) a.push(`w:bottom="${bottom}"`);
    if (left !== undefined) a.push(`w:left="${left}"`);
    if (m.header !== undefined) {
      const v = emuToTwips(m.header);
      if (v !== undefined) a.push(`w:header="${v}"`);
    }
    if (m.footer !== undefined) {
      const v = emuToTwips(m.footer);
      if (v !== undefined) a.push(`w:footer="${v}"`);
    }
    if (m.gutter !== undefined) {
      const v = emuToTwips(m.gutter);
      if (v !== undefined) a.push(`w:gutter="${v}"`);
    }
    if (a.length) inner.push(`<w:pgMar ${a.join(' ')}/>`);
  }
  for (const hr of section.headerRefs ?? []) {
    inner.push(
      `<w:headerReference w:type="${escapeXmlAttr(hr.refType)}" r:id="${escapeXmlAttr(hr.relId)}"/>`,
    );
  }
  for (const fr of section.footerRefs ?? []) {
    inner.push(
      `<w:footerReference w:type="${escapeXmlAttr(fr.refType)}" r:id="${escapeXmlAttr(fr.relId)}"/>`,
    );
  }
  const typeAttr = breakType ? ` w:type="${escapeXmlAttr(breakType)}"` : '';
  return `<w:sectPr${typeAttr}>${inner.join('')}</w:sectPr>`;
}

function serializeSectionBreak(sb: SectionBreak): string {
  // 段内分节符：段落的 pPr 内嵌 sectPr（与解析器 pPr/sectPr → SectionBreak 互逆）
  return `<w:p><w:pPr>${buildSectPr(sb.section, sb.breakType)}</w:pPr></w:p>`;
}

function serializeBlock(block: Block, ctx: Ctx): string {
  switch (block.type) {
    case 'paragraph':
      return serializeParagraph(block, ctx);
    case 'table':
      return serializeTable(block, ctx);
    case 'sectionBreak':
      return serializeSectionBreak(block);
    case 'paragraphBreak':
      return '<w:p/>';
    default:
      return '';
  }
}

/* =========================================================================
 * 4. body 与 document.xml
 * ========================================================================= */

function serializeBody(doc: JkDocument, ctx: Ctx): string {
  const parts: string[] = [];
  for (const block of doc.body) parts.push(serializeBlock(block, ctx));

  // L2 兜底：把未建模的未知块级元素原样插回（避免 round-trip 丢数据）
  const unparsed = doc.data?.__unparsedBlocks as unknown[] | undefined;
  if (Array.isArray(unparsed)) {
    for (const ub of unparsed) {
      const { tag, raw } = ub as { tag?: string; raw?: any };
      if (!tag) continue;
      const { attrs, inner } = rawNodeToParts(raw);
      parts.push(`<w:${tag}${attrs}>${inner}</w:${tag}>`);
    }
  }

  // 文档级 sectPr：写在 body 末尾（段落内的分节符已在前述 SectionBreak 处理）
  const sections = doc.sections ?? [];
  if (sections.length) {
    parts.push(buildSectPr(sections[sections.length - 1]));
  } else {
    parts.push('<w:sectPr/>');
  }
  return parts.join('');
}

/** 生成完整 word/document.xml 字符串（含标准命名空间声明） */
export function serializeDocumentXml(doc: JkDocument): string {
  const ctx: Ctx = { imageId: 0 };
  const body = serializeBody(doc, ctx);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>${body}</w:body>
</w:document>`;
}
