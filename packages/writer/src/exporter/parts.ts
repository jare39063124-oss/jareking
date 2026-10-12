/**
 * 其它 OOXML 部件序列化（T1.5 导出器）。
 *
 * 覆盖：styles.xml / numbering.xml / settings.xml / Content_Types /
 * 根 _rels/.rels / word/_rels/document.xml.rels。
 * 字段与单位映射同样逆映射 `src/parser/docxParser.ts`。
 */

import type {
  DocDefaults,
  JkDocument,
  NumberingLevel,
  Relationship,
  StyleDef,
  TableBorders,
  TableCellMargin,
  TableProperties,
} from '../model/document.js';
import { emuToTwips } from './units.js';
import { escapeXmlAttr, escapeXmlText } from './xml.js';
import { pPrInner, rPrInner } from './document.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/* =========================================================================
 * styles.xml
 * ========================================================================= */

function serializeStyleDef(s: StyleDef): string {
  const attrs: string[] = [
    `w:type="${escapeXmlAttr(s.styleType)}"`,
    `w:styleId="${escapeXmlAttr(s.styleId)}"`,
  ];
  if (s.isDefault) attrs.push('w:default="1"');
  const inner: string[] = [];
  if (s.name) inner.push(`<w:name w:val="${escapeXmlAttr(s.name)}"/>`);
  if (s.basedOn) inner.push(`<w:basedOn w:val="${escapeXmlAttr(s.basedOn)}"/>`);
  if (s.next) inner.push(`<w:next w:val="${escapeXmlAttr(s.next)}"/>`);
  if (s.link) inner.push(`<w:link w:val="${escapeXmlAttr(s.link)}"/>`);
  const pPr = pPrInner(s.pPr);
  if (pPr) inner.push(`<w:pPr>${pPr}</w:pPr>`);
  const rPr = rPrInner(s.rPr);
  if (rPr) inner.push(`<w:rPr>${rPr}</w:rPr>`);
  if (s.tblPr) {
    // 表格样式属性直接写 tblPr
    inner.push(serializeTblPrForStyle(s.tblPr));
  }
  return `<w:style ${attrs.join(' ')}>${inner.join('')}</w:style>`;
}

function serializeTblPrForStyle(tp: TableProperties): string {
  const parts: string[] = [];
  if (tp.styleId) parts.push(`<w:tblStyle w:val="${escapeXmlAttr(tp.styleId)}"/>`);
  if (tp.jc) parts.push(`<w:jc w:val="${escapeXmlAttr(tp.jc)}"/>`);
  if (tp.width !== undefined) {
    const w = emuToTwips(tp.width);
    if (w !== undefined) parts.push(`<w:tblW w:w="${w}" w:type="dxa"/>`);
  }
  if (tp.borders) {
    const b = serializeTblBordersForStyle(tp.borders);
    if (b) parts.push(b);
  }
  if (tp.cellMargin) {
    const m = serializeTableCellMarginForStyle(tp.cellMargin);
    if (m) parts.push(m);
  }
  return parts.length ? `<w:tblPr>${parts.join('')}</w:tblPr>` : '';
}

function serializeTblBordersForStyle(b: TableBorders): string {
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
  return out.length ? `<w:tblBorders>${out.join('')}</w:tblBorders>` : '';
}

function serializeTableCellMarginForStyle(m: TableCellMargin): string {
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

function serializeDocDefaults(dd: DocDefaults): string {
  let rd = '';
  const r = rPrInner(dd.rPr);
  if (r) rd += `<w:rPrDefault><w:rPr>${r}</w:rPr></w:rPrDefault>`;
  const p = pPrInner(dd.pPr);
  if (p) rd += `<w:pPrDefault><w:pPr>${p}</w:pPr></w:pPrDefault>`;
  return rd ? `<w:docDefaults>${rd}</w:docDefaults>` : '';
}

/** 生成 word/styles.xml */
export function serializeStyles(doc: JkDocument): string {
  const styleDefs = doc.styleDefs ?? { styles: [] };
  const docDefaults = serializeDocDefaults(styleDefs.docDefaults ?? {});
  const styles = (styleDefs.styles ?? []).map(serializeStyleDef).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">${docDefaults}${styles}</w:styles>`;
}

/* =========================================================================
 * numbering.xml
 * ========================================================================= */

function serializeNumberingLevel(l: NumberingLevel): string {
  const inner: string[] = [];
  if (l.start !== undefined) inner.push(`<w:start w:val="${l.start}"/>`);
  if (l.format) inner.push(`<w:numFmt w:val="${escapeXmlAttr(l.format)}"/>`);
  if (l.text) inner.push(`<w:lvlText w:val="${escapeXmlAttr(l.text)}"/>`);
  inner.push('<w:lvlJc w:val="left"/>');
  if (l.ind) {
    const ind: string[] = [];
    const left = emuToTwips(l.ind.left);
    const firstLine = emuToTwips(l.ind.firstLine);
    const hanging = emuToTwips(l.ind.hanging);
    if (left !== undefined) ind.push(`w:left="${left}"`);
    if (firstLine !== undefined) ind.push(`w:firstLine="${firstLine}"`);
    if (hanging !== undefined) ind.push(`w:hanging="${hanging}"`);
    if (ind.length) inner.push(`<w:pPr><w:ind ${ind.join(' ')}/></w:pPr>`);
  }
  const rPr = rPrInner(l.rPr);
  if (rPr) inner.push(`<w:rPr>${rPr}</w:rPr>`);
  return `<w:lvl w:ilvl="${l.level}">${inner.join('')}</w:lvl>`;
}

/** 生成 word/numbering.xml */
export function serializeNumbering(doc: JkDocument): string {
  const num = doc.numberingDefs ?? { abstractNum: [], num: [] };
  const abstract = (num.abstractNum ?? []).map((a) => {
    const lvls = (a.levels ?? []).map(serializeNumberingLevel).join('');
    return `<w:abstractNum w:abstractNumId="${escapeXmlAttr(a.abstractNumId)}">${lvls}</w:abstractNum>`;
  });
  const concrete = (num.num ?? []).map((n) => {
    let inner = `<w:abstractNumId w:val="${escapeXmlAttr(n.abstractNumId)}"/>`;
    for (const o of n.overrides ?? []) {
      let ov = '';
      if (o.startOverride !== undefined) ov += `<w:startOverride w:val="${o.startOverride}"/>`;
      if (o.levelRedefine) ov += serializeNumberingLevel(o.levelRedefine);
      inner += `<w:lvlOverride w:ilvl="${o.level}">${ov}</w:lvlOverride>`;
    }
    return `<w:num w:numId="${escapeXmlAttr(n.numId)}">${inner}</w:num>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">${abstract.join('')}${concrete.join('')}</w:numbering>`;
}

/* =========================================================================
 * settings.xml
 * ========================================================================= */

/** 生成 word/settings.xml */
export function serializeSettings(doc: JkDocument): string {
  const s = doc.settings ?? {};
  const inner: string[] = [];
  if (s.defaultTabStop !== undefined) {
    const v = emuToTwips(s.defaultTabStop);
    if (v !== undefined) inner.push(`<w:defaultTabStop w:val="${v}"/>`);
  }
  if (s.evenAndOddHeaders) inner.push('<w:evenAndOddHeaders/>');
  if (s.titlePage) inner.push('<w:titlePg/>');
  if (s.compat) {
    const c = Object.entries(s.compat)
      .map(([k, v]) => `<w:${escapeXmlText(k)} w:val="${escapeXmlAttr(String(v))}"/>`)
      .join('');
    if (c) inner.push(`<w:compat>${c}</w:compat>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="${W}" xmlns:r="${R}">${inner.join('')}</w:settings>`;
}

/* =========================================================================
 * [Content_Types].xml + _rels/.rels
 * ========================================================================= */

/** 生成 [Content_Types].xml（含常用图片扩展名兜底，避免 Word 报损坏） */
export function serializeContentTypes(_doc: JkDocument): string {
  const imageExts = ['png', 'jpeg', 'jpg', 'gif', 'bmp', 'emf', 'wmf', 'tiff', 'svg'];
  const defaults = [
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
    ...imageExts.map(
      (e) =>
        `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`,
    ),
  ];
  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`,
    `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>`,
  ];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${REL}">${defaults.join('')}${overrides.join('')}</Types>`;
}

/** 生成根 _rels/.rels（指向 word/document.xml） */
export function serializeRootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

/* =========================================================================
 * word/_rels/document.xml.rels
 * ========================================================================= */

/** 短类型名 → 完整关系 Type URI（与解析器 relTypeFromUri 互逆） */
function relTypeUri(type: Relationship['type']): string {
  switch (type) {
    case 'hyperlink':
      return `${R}/hyperlink`;
    case 'image':
      return `${R}/image`;
    case 'header':
      return `${R}/header`;
    case 'footer':
      return `${R}/footer`;
    case 'footnotes':
      return `${R}/footnotes`;
    case 'endnotes':
      return `${R}/endnotes`;
    case 'styles':
      return `${R}/styles`;
    case 'numbering':
      return `${R}/numbering`;
    case 'settings':
      return `${R}/settings`;
    case 'officeDocument':
      return `${R}/officeDocument`;
    default:
      return `${R}/${type}`;
  }
}

/**
 * 生成 word/_rels/document.xml.rels。
 * 返回 null 表示无关系（调用方据此决定是否写入该部件）。
 */
export function serializeDocumentRels(doc: JkDocument): string | null {
  const rels = doc.relationships ?? [];
  if (!rels.length) return null;
  const items = rels
    .map((r) => {
      const type = relTypeUri(r.type);
      const mode = r.targetMode === 'external' ? ' TargetMode="External"' : '';
      return `<Relationship Id="${escapeXmlAttr(r.id)}" Type="${escapeXmlAttr(type)}" Target="${escapeXmlAttr(r.target)}"${mode}/>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">${items}</Relationships>`;
}
