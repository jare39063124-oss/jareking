/**
 * .docx 解析器（T1.2）。
 *
 * 读取 .docx（ZIP/OOXML 包）→ 解析 WordprocessingML → 产出
 * `packages/writer` 的文档模型（`JkDocument`）。
 *
 * 设计要点：
 * - 使用 JSZip 读取 zip 各部件；fast-xml-parser 解析 XML，并开启
 *   `removeNSPrefix` 去掉 w:/a:/r: 等命名空间前缀（标签变成 p/r/t，
 *   属性变成 @_val/@_id），便于按本地名处理。
 * - 对齐 `src/model/document.ts` 的字段名与联合类型，**不引入任何模型外的字段**，
 *   未建模信息一律塞进各节点的 `data` 兜底槽，保证「打开→保存」round-trip 不丢数据（L2）。
 * - 遇到无法完美映射的特性（smartArt/oleObject/field/未知块级元素…）记入
 *   `UnsupportedFeature[]`，并保留原始节点，不抛异常、不丢数据。
 *
 * 单位约定（与 model 注释一致）：所有长度字段按 EMU 存储；
 * WordprocessingML 的 twips（二十分之一磅）统一 ×635 转 EMU；
 * 字号 `sz` 为半磅（half-point），原值存储（如 44 = 22pt）；
 * drawing 的 extent cx/cy 已是 EMU，原值存储。
 * 注：Word 的 w:ind / w:spacing / pgSz / pgMar 原始单位为 twips，
 * 此处按模型约定统一转 EMU；该转换是否合适（与 T1.5 序列化保持一致）作为开放问题见交付报告。
 */

import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

import type {
  Block,
  Break,
  CommentRange,
  ConcreteNumbering,
  DocDefaults,
  DocumentSettings,
  FidelityReport,
  Font,
  Hyperlink,
  Image,
  Inline,
  Indentation,
  JkComment,
  JkDocument,
  Numbering,
  NumberingFormat,
  NumberingLevel,
  NumberingLevelOverride,
  Paragraph,
  ParagraphProperties,
  Relationship,
  RelationshipType,
  RevisionAuthor,
  Run,
  RunProperties,
  RunRevision,
  Section,
  SectionBreak,
  SectionRef,
  Spacing,
  StyleDef,
  StyleSheet,
  Table,
  TableBorders,
  TableCell,
  TableCellMargin,
  TableCellProperties,
  TableGrid,
  TableProperties,
  TableRow,
  TableRowProperties,
  TableShading,
} from '../model/document.js';
import type { UnsupportedFeature, UnsupportedFeatureKind } from '../model/fidelity.js';
import { unsupportedFeature } from '../model/fidelity.js';

/* =========================================================================
 * 0. XML / 辅助工具
 * ========================================================================= */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
  trimValues: true,
  parseAttributeValue: false,
});

/**
 * 保序解析器（preserveOrder）。
 *
 * 默认解析器按「标签首次出现」分组子元素（`r` 分到一个数组、`commentRangeStart`
 * 分到另一个），会丢失同一段落内 run 与批注边界标记的相对顺序，导致无法
 * 定位批注锚点所属的 run 区间。此处额外构建一个保序解析器，**仅**用于从
 * document.xml 提取每段的 `commentRanges`（不影响既有分组解析路径，零回归）。
 * 保序树结构：`[ { tag: [子节点…], ':@': {属性} }, … ]`，文本为 `{ '#text': … }`。
 */
const xmlOrderedParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
  trimValues: true,
  parseAttributeValue: false,
  preserveOrder: true,
});

/** 解析 XML 字符串为去命名空间的普通对象树 */
function parseXml(xml: string): any {
  return xmlParser.parse(xml);
}

/** 解析 XML 字符串为保序树（元素顺序保留，用于批注范围提取） */
function parseXmlOrdered(xml: string): any {
  return xmlOrderedParser.parse(xml);
}

/** 单元素/数组/undefined 统一成数组（fast-xml-parser 对单元素默认不是数组） */
function ensureArray<T = any>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 取属性值（属性名形如 "@_val"）；节点非对象时安全返回 undefined */
function getAttr(node: any, attr: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const v = node[attr];
  if (v === undefined || v === null) return undefined;
  return String(v);
}

/** 标志型元素（w:b / w:i / w:strike…）：存在即 true；@_val 为 false/0/off/none 时为 false */
function hasFlag(node: any, tag: string): boolean {
  const v = node?.[tag];
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v !== 'false' && v !== '0' && v !== 'off' && v !== 'none';
  if (typeof v === 'object') {
    const val = v['@_val'];
    if (val === undefined) return true; // <w:b/> 形式
    return !(val === 'false' || val === '0' || val === 'off' || val === 'none');
  }
  return Boolean(v);
}

/** 拼接某标签下所有文本节点（兼容 t 为字符串/数字与 { "#text": ... } 两种形态，处理多个 t） */
function childText(node: any, tag: string): string {
  const arr = ensureArray(node?.[tag]);
  return arr
    .map((c: any) => {
      if (typeof c === 'string') return c;
      if (typeof c === 'number') return String(c);
      if (c && typeof c === 'object') {
        const t = c['#text'];
        return t === undefined ? '' : String(t);
      }
      return '';
    })
    .join('');
}

/** twips（二十分之一磅）→ EMU（1 twip = 635 EMU） */
function tw2emu(v: string | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 635);
}

/** 在子树中深度查找首个属性值（兼容对象与数组），用于 @_embed / cx / cy 等 */
function findAttrDeep(node: any, attr: string): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const el of node) {
      const found = findAttrDeep(el, attr);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(node, attr)) return node[attr];
  for (const k of Object.keys(node)) {
    if (k.startsWith('@') || k.startsWith('#') || k.startsWith('?')) continue;
    const found = findAttrDeep(node[k], attr);
    if (found !== undefined) return found;
  }
  return undefined;
}

/* =========================================================================
 * 1. 取值集合与映射
 * ========================================================================= */

const ALIGNMENTS = new Set(['start', 'end', 'left', 'right', 'center', 'justify', 'distribute', 'both']);
const UNDERLINES = new Set([
  'none',
  'single',
  'double',
  'thick',
  'dotted',
  'dashed',
  'wave',
  'words',
]);

function isAlignment(v: string | undefined): v is 'start' | 'end' | 'left' | 'right' | 'center' | 'justify' | 'distribute' | 'both' {
  return v !== undefined && ALIGNMENTS.has(v);
}
function isUnderline(v: string | undefined): v is 'none' | 'single' | 'double' | 'thick' | 'dotted' | 'dashed' | 'wave' | 'words' {
  return v !== undefined && UNDERLINES.has(v);
}

/** relationships Type URI → 简短 type（对齐 RelationshipType 联合） */
function relTypeFromUri(uri: string): RelationshipType {
  const seg = uri.split('/').pop() ?? uri;
  return seg as RelationshipType;
}

/** 未知元素标签 → 降级特性类别 */
function mapUnknownKind(tag: string): UnsupportedFeatureKind {
  const t = tag.toLowerCase();
  if (t === 'smartart') return 'smartart';
  if (t === 'object' || t === 'oleobject') return 'ole';
  if (t === 'sdt' || t === 'sdtcontent' || t === 'sdtpr') return 'contentControl';
  if (t === 'fldsimple' || t === 'fldchar' || t === 'instrtxt' || t === 'fldsimple') return 'field';
  if (t === 'omath' || t === 'omathpara') return 'math';
  if (t === 'chart' || t === 'chartxml') return 'chart';
  if (t === 'watermark') return 'watermark';
  return 'other';
}

/** sectPr@w:type → SectionBreak.breakType */
function mapBreakType(v: string | undefined): SectionBreak['breakType'] {
  switch (v) {
    case 'nextColumn':
      return 'nextColumn';
    case 'continuous':
      return 'continuous';
    case 'evenPage':
      return 'evenPage';
    case 'oddPage':
      return 'oddPage';
    default:
      return 'nextPage';
  }
}

/* =========================================================================
 * 2. ZIP 读取
 * ========================================================================= */

type Zip = JSZip;

async function readPart(zip: Zip, path: string): Promise<string | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  return file.async('string');
}

/* =========================================================================
 * 3. 资源引用（.rels）
 * ========================================================================= */

async function parseRelationships(zip: Zip, path: string): Promise<Relationship[]> {
  const xml = await readPart(zip, path);
  if (!xml) return [];
  const obj = parseXml(xml);
  const relsNode = obj.Relationships;
  if (!relsNode) return [];
  return ensureArray(relsNode.Relationship).map((r: any) => ({
    id: getAttr(r, '@_Id') ?? '',
    type: relTypeFromUri(getAttr(r, '@_Type') ?? ''),
    target: getAttr(r, '@_Target') ?? '',
    targetMode:
      (getAttr(r, '@_TargetMode')?.toLowerCase() as 'internal' | 'external') ?? 'internal',
  }));
}

/**
 * 提取图片二进制到 media 映射（键为 rId）。
 * relationship.target 形如 "media/image1.png"，相对 word/ 目录解析。
 */
async function parseMedia(zip: Zip, rels: Relationship[]): Promise<Record<string, Uint8Array>> {
  const media: Record<string, Uint8Array> = {};
  for (const rel of rels) {
    if (rel.type !== 'image') continue;
    const target = rel.target ?? '';
    if (!target) continue;
    // 相对 document.xml.rels 所在目录（word/_rels）→ 实际包内路径
    const fullPath = target.startsWith('/')
      ? target.slice(1)
      : `word/${target}`;
    try {
      const file = zip.file(fullPath);
      if (!file) continue;
      const bytes = await file.async('uint8array');
      media[rel.id] = bytes;
    } catch {
      // 媒体缺失：忽略，导出时该图片占位会被跳过
    }
  }
  return media;
}

/* =========================================================================
 * 4. 样式系统（styles.xml）
 * ========================================================================= */

function mapStyleType(v: string | undefined): StyleDef['styleType'] {
  if (v === 'character' || v === 'table' || v === 'numbering') return v;
  return 'paragraph';
}

function parseStyleDef(s: any): StyleDef {
  const def: StyleDef = {
    type: 'styleDef',
    styleId: getAttr(s, '@_styleId') ?? '',
    styleType: mapStyleType(getAttr(s, '@_type')),
    name: getAttr(s.name, '@_val'),
    basedOn: getAttr(s.basedOn, '@_val'),
    next: getAttr(s.next, '@_val'),
    link: getAttr(s.link, '@_val'),
    isDefault: getAttr(s, '@_default') === '1' || getAttr(s, '@_default') === 'true',
    pPr: s.pPr ? parseParagraphProperties(s.pPr) : undefined,
    rPr: s.rPr ? parseRunProperties(s.rPr) : undefined,
    tblPr: s.tblPr ? parseTableProperties(s.tblPr) : undefined,
    data: { __raw: s },
  };
  return def;
}

function parseDocDefaults(d: any): DocDefaults | undefined {
  if (!d) return undefined;
  const rPr = d.rPrDefault?.rPr ? parseRunProperties(d.rPrDefault.rPr) : undefined;
  const pPr = d.pPrDefault?.pPr ? parseParagraphProperties(d.pPrDefault.pPr) : undefined;
  if (rPr || pPr) return { rPr, pPr };
  return undefined;
}

async function parseStyles(zip: Zip): Promise<StyleSheet> {
  const xml = await readPart(zip, 'word/styles.xml');
  const empty: StyleSheet = { styles: [] };
  if (!xml) return empty;
  const obj = parseXml(xml);
  const stylesNode = obj.styles;
  if (!stylesNode) return empty;
  const styles: StyleDef[] = ensureArray(stylesNode.style).map(parseStyleDef);
  const docDefaults = parseDocDefaults(stylesNode.docDefaults);
  return { styles, docDefaults };
}

/* =========================================================================
 * 5. 编号系统（numbering.xml）
 * ========================================================================= */

function parseNumberingLevel(l: any): NumberingLevel {
  const startRaw = getAttr(l.start, '@_val');
  return {
    level: Number(getAttr(l, '@_ilvl') ?? 0),
    format: getAttr(l.numFmt, '@_val') as NumberingFormat | undefined,
    text: getAttr(l.lvlText, '@_val'),
    start: startRaw !== undefined ? Number(startRaw) : undefined,
    ind: l.ind ? parseIndentation(l.ind) : undefined,
    rPr: l.rPr ? parseRunProperties(l.rPr) : undefined,
    data: { __raw: l },
  };
}

function parseConcreteNum(n: any): ConcreteNumbering {
  const overrides: NumberingLevelOverride[] = ensureArray(n.lvlOverride).map((o: any) => ({
    level: Number(getAttr(o, '@_ilvl') ?? 0),
    startOverride:
      getAttr(o.startOverride, '@_val') !== undefined
        ? Number(getAttr(o.startOverride, '@_val'))
        : undefined,
    levelRedefine: o.lvl ? parseNumberingLevel(o.lvl) : undefined,
    data: { __raw: o },
  }));
  return {
    numId: getAttr(n, '@_numId') ?? '',
    abstractNumId: getAttr(n.abstractNumId, '@_val') ?? '',
    overrides: overrides.length ? overrides : undefined,
    data: { __raw: n },
  };
}

async function parseNumbering(zip: Zip): Promise<Numbering> {
  const xml = await readPart(zip, 'word/numbering.xml');
  const empty: Numbering = { abstractNum: [], num: [] };
  if (!xml) return empty;
  const obj = parseXml(xml);
  const numNode = obj.numbering;
  if (!numNode) return empty;
  const abstractNum = ensureArray(numNode.abstractNum).map((a: any) => ({
    abstractNumId: getAttr(a, '@_abstractNumId') ?? '',
    levels: ensureArray(a.lvl).map(parseNumberingLevel),
    data: { __raw: a },
  }));
  const num = ensureArray(numNode.num).map(parseConcreteNum);
  return { abstractNum, num };
}

/* =========================================================================
 * 6. 文档设置（settings.xml）
 * ========================================================================= */

async function parseSettings(zip: Zip): Promise<DocumentSettings> {
  const xml = await readPart(zip, 'word/settings.xml');
  if (!xml) return {};
  const obj = parseXml(xml);
  const s = obj.settings;
  if (!s) return {};
  const out: DocumentSettings = {};
  const dts = getAttr(s.defaultTabStop, '@_val');
  if (dts !== undefined) out.defaultTabStop = tw2emu(dts);
  if (s.evenAndOddHeaders !== undefined) out.evenAndOddHeaders = true;
  if (s.titlePg !== undefined) out.titlePage = true;
  if (s.compat) {
    out.compat = {};
    for (const child of ensureArray(s.compat)) {
      const name = Object.keys(child).find((k) => !k.startsWith('@') && !k.startsWith('#'));
      if (name) out.compat[name] = getAttr(child, '@_val') ?? '';
    }
  }
  return out;
}

/* =========================================================================
 * 7. 属性解析（pPr / rPr / tblPr / trPr / tcPr）
 * ========================================================================= */

function parseIndentation(ind: any): Indentation | undefined {
  if (!ind) return undefined;
  const out: Indentation = {};
  const left = tw2emu(getAttr(ind, '@_left'));
  const right = tw2emu(getAttr(ind, '@_right'));
  const firstLine = tw2emu(getAttr(ind, '@_firstLine'));
  const hanging = tw2emu(getAttr(ind, '@_hanging'));
  if (left !== undefined) out.left = left;
  if (right !== undefined) out.right = right;
  if (firstLine !== undefined) out.firstLine = firstLine;
  if (hanging !== undefined) out.hanging = hanging;
  return Object.keys(out).length ? out : undefined;
}

function parseSpacing(sp: any): Spacing | undefined {
  if (!sp) return undefined;
  const out: Spacing = {};
  const before = tw2emu(getAttr(sp, '@_before'));
  const after = tw2emu(getAttr(sp, '@_after'));
  const lineRaw = getAttr(sp, '@_line');
  const lineRuleRaw = getAttr(sp, '@_lineRule');
  if (before !== undefined) out.before = before;
  if (after !== undefined) out.after = after;
  if (lineRaw !== undefined) out.line = Number(lineRaw);
  if (lineRuleRaw === 'exact' || lineRuleRaw === 'atLeast') out.lineRule = lineRuleRaw;
  else if (lineRuleRaw === 'auto') out.lineRule = 'auto';
  return Object.keys(out).length ? out : undefined;
}

function parseNumPr(numPr: any): ParagraphProperties['numPr'] {
  if (!numPr) return undefined;
  const numId = getAttr(numPr.numId, '@_val');
  if (numId === undefined) return undefined;
  const ilvlRaw = getAttr(numPr.ilvl, '@_val');
  return { numId, ilvl: ilvlRaw !== undefined ? Number(ilvlRaw) : 0 };
}

function parseParagraphProperties(pPr: any): ParagraphProperties | undefined {
  if (!pPr) return undefined;
  const pp: ParagraphProperties = {};
  const styleId = getAttr(pPr.pStyle, '@_val');
  if (styleId) pp.styleId = styleId;
  const numPr = parseNumPr(pPr.numPr);
  if (numPr) pp.numPr = numPr;
  const jc = getAttr(pPr.jc, '@_val');
  if (isAlignment(jc)) pp.jc = jc;
  const ind = parseIndentation(pPr.ind);
  if (ind) pp.ind = ind;
  const spacing = parseSpacing(pPr.spacing);
  if (spacing) pp.spacing = spacing;
  const ol = getAttr(pPr.outlineLvl, '@_val');
  if (ol !== undefined) pp.outlineLvl = Number(ol);
  if (pPr.keepNext !== undefined) pp.keepNext = true;
  if (pPr.pageBreakBefore !== undefined) pp.pageBreakBefore = true;
  // snapToGrid / widowControl：显式 false 必须记录（WPS 渲染差异敏感）
  const snap = getAttr(pPr.snapToGrid, '@_val');
  if (snap === '0' || snap === 'false') pp.snapToGrid = false;
  else if (snap === '1' || snap === 'true') pp.snapToGrid = true;
  const widow = getAttr(pPr.widowControl, '@_val');
  if (widow === '0' || widow === 'false') pp.widowControl = false;
  else if (widow === '1' || widow === 'true') pp.widowControl = true;
  return Object.keys(pp).length ? pp : undefined;
}

function parseFont(rFonts: any): Font | undefined {
  if (!rFonts) return undefined;
  const f: Font = {};
  const ascii = getAttr(rFonts, '@_ascii');
  const ea = getAttr(rFonts, '@_eastAsia');
  const ha = getAttr(rFonts, '@_hAnsi');
  const cs = getAttr(rFonts, '@_cs');
  const hint = getAttr(rFonts, '@_hint');
  if (ascii) f.ascii = ascii;
  if (ea) f.eastAsia = ea;
  if (ha) f.hAnsi = ha;
  if (cs) f.cs = cs;
  if (hint) f.hint = hint;
  return Object.keys(f).length ? f : undefined;
}

function parseRunProperties(rPr: any): RunProperties | undefined {
  if (!rPr) return undefined;
  const rp: RunProperties = {};
  const styleId = getAttr(rPr.rStyle, '@_val');
  if (styleId) rp.styleId = styleId;
  if (hasFlag(rPr, 'b')) rp.bold = true;
  if (hasFlag(rPr, 'i')) rp.italic = true;
  if (rPr.u !== undefined) {
    const uVal = getAttr(rPr.u, '@_val');
    if (uVal === undefined) rp.underline = 'single';
    else if (isUnderline(uVal)) rp.underline = uVal;
    else rp.underline = 'single';
  }
  if (hasFlag(rPr, 'strike')) rp.strike = true;
  if (hasFlag(rPr, 'dstrike')) rp.doubleStrike = true;
  const va = getAttr(rPr.vertAlign, '@_val');
  if (va === 'sup' || va === 'superscript') rp.verticalAlign = 'superscript';
  else if (va === 'sub' || va === 'subscript') rp.verticalAlign = 'subscript';
  else if (va === 'baseline') rp.verticalAlign = 'baseline';
  const color = getAttr(rPr.color, '@_val');
  if (color) rp.color = color;
  const font = parseFont(rPr.rFonts);
  if (font) rp.font = font;
  const sz = getAttr(rPr.sz, '@_val');
  if (sz !== undefined) rp.size = Number(sz); // half-point，原值存储（44 = 22pt）
  const hl = getAttr(rPr.highlight, '@_val');
  if (hl) rp.highlight = hl;
  return Object.keys(rp).length ? rp : undefined;
}

function parseBorderSide(side: any): { style: string; color?: string; size?: number } {
  const bs: { style: string; color?: string; size?: number } = {
    style: getAttr(side, '@_val') ?? 'single',
  };
  const color = getAttr(side, '@_color');
  if (color) bs.color = color;
  const sz = getAttr(side, '@_sz');
  if (sz !== undefined) bs.size = Number(sz);
  return bs;
}

function parseTableBorders(node: any): TableBorders | undefined {
  if (!node) return undefined;
  const b: TableBorders = {};
  const sides: [string, keyof TableBorders][] = [
    ['top', 'top'],
    ['left', 'left'],
    ['bottom', 'bottom'],
    ['right', 'right'],
    ['insideH', 'insideHorizontal'],
    ['insideV', 'insideVertical'],
  ];
  for (const [tag, key] of sides) {
    if (node[tag] !== undefined) b[key] = parseBorderSide(node[tag]);
  }
  return Object.keys(b).length ? b : undefined;
}

function parseTableCellMargin(node: any): TableCellMargin | undefined {
  if (!node) return undefined;
  const m: TableCellMargin = {};
  const top = tw2emu(getAttr(node, '@_top'));
  const left = tw2emu(getAttr(node, '@_left'));
  const bottom = tw2emu(getAttr(node, '@_bottom'));
  const right = tw2emu(getAttr(node, '@_right'));
  if (top !== undefined) m.top = top;
  if (left !== undefined) m.left = left;
  if (bottom !== undefined) m.bottom = bottom;
  if (right !== undefined) m.right = right;
  return Object.keys(m).length ? m : undefined;
}

function parseTableProperties(tblPr: any): TableProperties | undefined {
  if (!tblPr) return undefined;
  const tp: TableProperties = {};
  const styleId = getAttr(tblPr.tblStyle, '@_val');
  if (styleId) tp.styleId = styleId;
  const jc = getAttr(tblPr.jc, '@_val');
  if (isAlignment(jc)) tp.jc = jc;
  const w = tw2emu(getAttr(tblPr.tblW, '@_w'));
  if (w !== undefined) tp.width = w;
  const borders = parseTableBorders(tblPr.tblBorders);
  if (borders) tp.borders = borders;
  const cellMargin = parseTableCellMargin(tblPr.tblCellMar);
  if (cellMargin) tp.cellMargin = cellMargin;
  const shd = parseShd(tblPr.shd);
  if (shd) tp.shd = shd;
  return Object.keys(tp).length ? tp : undefined;
}

function parseTableRowProperties(trPr: any): TableRowProperties | undefined {
  if (!trPr) return undefined;
  const trp: TableRowProperties = {};
  const h = tw2emu(getAttr(trPr.trHeight, '@_val'));
  if (h !== undefined) trp.height = h;
  if (trPr.tblHeader !== undefined) trp.headerRepeat = true;
  const shd = parseShd(trPr.shd);
  if (shd) trp.shd = shd;
  return Object.keys(trp).length ? trp : undefined;
}

/** 解析底纹（对应 w:shd：单元格/行/表格通用）。无有效属性返回 undefined。 */
function parseShd(shd: any): TableShading | undefined {
  if (!shd) return undefined;
  const val = getAttr(shd, '@_val');
  const color = getAttr(shd, '@_color');
  const fill = getAttr(shd, '@_fill');
  if (!val && !color && !fill) return undefined;
  const out: TableShading = {};
  if (val) out.val = val;
  if (color) out.color = color;
  if (fill) out.fill = fill;
  return out;
}

function parseTableCellProperties(tcPr: any): TableCellProperties | undefined {
  if (!tcPr) return undefined;
  const cp: TableCellProperties = {};
  const w = tw2emu(getAttr(tcPr.tcW, '@_w'));
  if (w !== undefined) cp.width = w;
  const va = getAttr(tcPr.vAlign, '@_val');
  if (va === 'top' || va === 'center' || va === 'bottom') cp.vAlign = va;
  const gs = getAttr(tcPr.gridSpan, '@_val');
  if (gs !== undefined) cp.gridSpan = Number(gs);
  const vm = getAttr(tcPr.vMerge, '@_val');
  if (vm === 'restart' || vm === 'continue') cp.vMerge = vm;
  const borders = parseTableBorders(tcPr.tcBorders);
  if (borders) cp.borders = borders;
  const shd = parseShd(tcPr.shd);
  if (shd) cp.shd = shd;
  return Object.keys(cp).length ? cp : undefined;
}

/* =========================================================================
 * 8. 行内元素（Run / Hyperlink / Image / Break / FootnoteRef）
 * ========================================================================= */

const INLINE_IGNORE = new Set([
  'pPr',
  'rPr',
  'bookmarkStart',
  'bookmarkEnd',
  'proofErr',
  'permStart',
  'permEnd',
  // 注意：commentRangeStart / commentRangeEnd / commentReference 已不再忽略——
  // 它们由「保序解析」用于定位批注锚点（见 extractOrderedParagraphs），
  // 在分组解析中于下方显式跳过，避免被误判为「不支持的行内元素」。
]);

/** 批注锚点/引用标记元素（分组解析中跳过，交由保序解析处理） */
const COMMENT_MARKERS = new Set(['commentRangeStart', 'commentRangeEnd', 'commentReference']);

/** 是否为「批注引用 run」（仅含 w:commentReference、无文本的 w:r）——不计入模型 runs */
function isCommentReferenceRun(r: any): boolean {
  if (!r || typeof r !== 'object') return false;
  if (r.commentReference === undefined) return false;
  // 含文本（t）或图形（drawing）/公式（oMath）的 run 视为普通 run
  if (r.t !== undefined) return false;
  const drawing = r.drawing ?? r.pict;
  if (drawing !== undefined) return false;
  return true;
}

function parseImage(r: any): Image {
  const embed = findAttrDeep(r, '@_embed') ?? '';
  const cx = findAttrDeep(r, '@_cx');
  const cy = findAttrDeep(r, '@_cy');
  const descr = findAttrDeep(r, '@_descr') || findAttrDeep(r, '@_title');
  const img: Image = { type: 'image', embed };
  // drawing extent 已是 EMU，原值存储；缺省给 1 英寸占位（T1.3 再按需加载二进制）
  img.width = cx !== undefined ? Number(cx) : 914400;
  img.height = cy !== undefined ? Number(cy) : 914400;
  if (descr) img.alt = descr;
  return img;
}

function parseRunOrImage(r: any): Inline {
  if (findAttrDeep(r, '@_embed') !== undefined) return parseImage(r);
  return parseRun(r);
}

function parseRun(r: any): Run {
  const rPr = parseRunProperties(r.rPr);
  const text = childText(r, 't');
  return { type: 'run', text, rPr, data: { __raw: r } };
}

/**
 * 解析修订 run（位于 `<w:ins>` / `<w:del>` 内）。
 * - insert：文本取 `<w:t>`（与普通 run 一致）；
 * - delete：文本取 `<w:delText>`（OOXML 约定：删除内容用 delText 而非 t），
 *   兼容极端情况下仍写 `<w:t>` 的实现，做 fallback。
 * 修订元数据（kind/author/date）来自包裹元素。
 */
function parseRevisedRun(r: any, kind: 'insert' | 'delete', author?: string, date?: string): Inline {
  // 图片等非文本行内元素：仍按普通解析（修订一般只作用于文本，保持图片可读）
  if (findAttrDeep(r, '@_embed') !== undefined) return parseImage(r);
  const rPr = parseRunProperties(r.rPr);
  const text =
    kind === 'delete' ? childText(r, 'delText') || childText(r, 't') : childText(r, 't');
  const revision: RunRevision = { kind };
  if (author !== undefined) revision.author = author;
  if (date !== undefined) revision.date = date;
  return { type: 'run', text, rPr, revision, data: { __raw: r } };
}

/** 解析 `<w:ins>` / `<w:del>` 包裹的 run 序列（其内 run 一律视为修订内容） */
function parseRevisionContainer(node: any, kind: 'insert' | 'delete'): Inline[] {
  const out: Inline[] = [];
  const author = getAttr(node, '@_author');
  const date = getAttr(node, '@_date');
  for (const rr of ensureArray(node.r)) {
    // 批注引用 run 不计入模型 runs（与普通路径口径一致）
    if (isCommentReferenceRun(rr)) continue;
    out.push(parseRevisedRun(rr, kind, author, date));
  }
  return out;
}

function parseHyperlink(h: any): Hyperlink {
  const relId = getAttr(h, '@_id');
  const anchor = getAttr(h, '@_anchor');
  const runs = parseContainerInlines(h);
  return { type: 'hyperlink', relId, anchor, runs };
}

function parseBreak(br: any): Break {
  const t = getAttr(br, '@_type');
  const bt: Break['breakType'] = t === 'page' ? 'page' : t === 'column' ? 'column' : 'textWrapping';
  return { type: 'break', breakType: bt };
}

/** 深度拼接节点内所有文本（兼容 #text、数字节点与 t 子元素，处理多段文本/嵌套） */
function deepText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(deepText).join('');
  if (typeof node === 'object') {
    let s = '';
    if (typeof node['#text'] === 'string') s += node['#text'];
    else if (typeof node['#text'] === 'number') s += String(node['#text']);
    for (const k of Object.keys(node)) {
      if (k.startsWith('@') || k.startsWith('#') || k.startsWith('?')) continue;
      s += deepText(node[k]);
    }
    return s;
  }
  return '';
}

function parseContainerInlines(
  container: any,
  unsupported?: UnsupportedFeature[],
): Inline[] {
  const inlines: Inline[] = [];
  if (!container || typeof container !== 'object') return inlines;
  // 复杂域状态机：fldChar(begin) → instrText… → fldChar(separate) → 结果 runs… → fldChar(end)
  let field: { instr: string[]; result: string[]; separated: boolean } | null = null;
  for (const tag of Object.keys(container)) {
    if (tag.startsWith('@') || tag.startsWith('#') || tag.startsWith('?')) continue;
    if (INLINE_IGNORE.has(tag)) continue;
    if (COMMENT_MARKERS.has(tag)) continue; // 批注标记由保序解析处理，分组解析跳过
    const items = ensureArray(container[tag]);
    for (const item of items) {
      if (tag === 'oMath') {
        // OMML 公式：v1 取线性文本（deepText 递归 m:t），导出时重建 m:oMath
        const text = deepText(item).replace(/\s+/g, ' ').trim();
        if (text) inlines.push({ type: 'formula', text, data: { __raw: item } });
        continue;
      }
      if (tag === 'fldSimple') {
        // 简单域：指令在 @_instr，内部缓存文本作为结果
        const instr = (getAttr(item, '@_instr') ?? '').replace(/[{}]/g, '').trim();
        const result = deepText(item).trim();
        inlines.push({ type: 'field', instr, result: result || undefined, data: { __raw: item } });
        continue;
      }
      if (tag === 'fldChar') {
        const t = getAttr(item, '@_fldCharType');
        if (t === 'begin') field = { instr: [], result: [], separated: false };
        else if (t === 'separate') {
          if (field) field.separated = true;
        } else if (t === 'end') {
          if (field) {
            inlines.push({
              type: 'field',
              instr: field.instr.join(' ').replace(/\s+/g, ' ').trim(),
              result: field.result.join('').trim() || undefined,
              data: { __raw: item },
            });
            field = null;
          }
        }
        continue;
      }
      if (tag === 'instrText') {
        if (field && !field.separated) field.instr.push(deepText(item));
        continue;
      }
      if (tag === 'r') {
        // 批注引用 run（仅含 w:commentReference）：不计入模型 runs，避免 round-trip 累积空 run。
        // 其批注锚点位置由保序解析写入 Paragraph.commentRanges。
        if (isCommentReferenceRun(item)) continue;
        // 真实 OOXML 中 fldChar / instrText 都包裹在 w:r 内（而非段落直子级）。
        // 优先识别「域 run」驱动复杂域状态机；否则按普通 run 处理。
        const fldCharType = getAttr(item?.fldChar, '@_fldCharType');
        if (fldCharType) {
          if (fldCharType === 'begin') field = { instr: [], result: [], separated: false };
          else if (fldCharType === 'separate') {
            if (field) field.separated = true;
          } else if (fldCharType === 'end') {
            if (field) {
              inlines.push({
                type: 'field',
                instr: field.instr.join(' ').replace(/\s+/g, ' ').trim(),
                result: field.result.join('').trim() || undefined,
                data: { __raw: item },
              });
              field = null;
            }
          }
          continue;
        }
        const instrText = ensureArray(item?.instrText)
          .map((n: any) => deepText(n))
          .join('')
          .trim();
        if (instrText) {
          if (field && !field.separated) field.instr.push(instrText);
          continue;
        }
        if (field) {
          // 处于域中（已 separate）：结果文本收集进字段，不作为独立 run 入栈
          if (field.separated) field.result.push(childText(item, 't'));
          continue;
        }
        inlines.push(parseRunOrImage(item));
        continue;
      }
      if (tag === 'ins' || tag === 'del') {
        // 修订（track changes）：<w:ins> 内为插入内容，<w:del> 内为删除内容（文本用 w:delText）
        inlines.push(...parseRevisionContainer(item, tag === 'ins' ? 'insert' : 'delete'));
        continue;
      }
      if (tag === 'hyperlink') inlines.push(parseHyperlink(item));
      else if (tag === 'br') inlines.push(parseBreak(item));
      else if (tag === 'cr') inlines.push({ type: 'break', breakType: 'textWrapping' });
      else if (tag === 'footnoteReference')
        inlines.push({ type: 'footnoteRef', id: getAttr(item, '@_id') });
      else if (unsupported) {
        unsupported.push(
          unsupportedFeature(
            mapUnknownKind(tag),
            `不支持的行内元素 <${tag}>，已忽略并保留于兜底数据`,
            'inline',
            'docx',
          ),
        );
      }
    }
  }
  return inlines;
}

/* =========================================================================
 * 8.5 批注（comments.xml + 段落内 commentRangeStart/End）
 * =========================================================================
 * 说明：批注锚点（commentRangeStart/End）与 run 需按**文档顺序**配对，
 * 而分组解析会打乱二者相对顺序，因此本部分改用「保序解析器」对
 * document.xml 做一次独立解析，提取每段的批注 run 区间，再按文本签名
 * 对齐回分组解析产出的 Paragraph 对象（四端一致的索引区间模型）。
 * 复杂/跨段落批注、或含域/图形的复杂段落可安全降级（仅跳过，不错配）。
 */

/** 取保序节点的本地标签名（跳过 ':@' 属性容器与 '#text' 文本节点） */
function orderedTag(node: any): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  for (const k of Object.keys(node)) {
    if (k === ':@' || k === '#text') continue;
    return k;
  }
  return undefined;
}

/** 取保序节点的属性容器（形如 { '@_id': '0' }） */
function orderedAttrs(node: any): Record<string, string> {
  const attrs = node?.[':@'];
  return attrs && typeof attrs === 'object' ? attrs : {};
}

/** 拼接保序 run 子节点内所有 w:t 文本（按文档顺序） */
function orderedRunText(children: any[]): string {
  let text = '';
  for (const child of children) {
    const tag = orderedTag(child);
    if (tag === 't') text += deepText(child);
    else if (tag === 'br' || tag === 'cr') text += '\n';
  }
  return text;
}

/** 保序视图中判断是否为「批注引用 run」（含 commentReference 且无文本/图形） */
function isReferenceRunOrdered(children: any[]): boolean {
  let hasRef = false;
  for (const child of children) {
    const tag = orderedTag(child);
    if (tag === 'commentReference') hasRef = true;
    else if (tag === 't' || tag === 'drawing' || tag === 'pict' || tag === 'object') return false;
  }
  return hasRef;
}

/** 单个段落的保序分析结果：非引用 run 的文本序列 + 批注区间 */
interface OrderedParagraph {
  /** 文本签名（非引用 run 的文本按 \0 连接），用于对齐分组解析结果 */
  signature: string;
  /** 该段内的批注区间（按非引用 run 索引，左闭右开） */
  ranges: CommentRange[];
}

/** 分析一个保序 <w:p> 的子节点：统计 run 索引并配对批注区间 */
function analyzeParagraphOrdered(children: any[]): OrderedParagraph {
  const texts: string[] = [];
  const open = new Map<string, number>();
  const ranges: CommentRange[] = [];
  for (const child of children) {
    const tag = orderedTag(child);
    if (!tag) continue;
    if (tag === 'r') {
      const kids = ensureArray(child[tag]);
      if (isReferenceRunOrdered(kids)) continue; // 引用 run 不计入
      texts.push(orderedRunText(kids));
      continue;
    }
    if (tag === 'commentRangeStart') {
      const id = orderedAttrs(child)['@_id'];
      if (id !== undefined) open.set(String(id), texts.length);
      continue;
    }
    if (tag === 'commentRangeEnd') {
      const id = orderedAttrs(child)['@_id'];
      if (id !== undefined && open.has(String(id))) {
        ranges.push({ id: String(id), start: open.get(String(id))!, end: texts.length });
        open.delete(String(id));
      }
      continue;
    }
    // 其它行内元素（hyperlink 等）：不参与 run 索引计数（与分组解析的顶层 run 口径一致）
  }
  return { signature: texts.join('\u0000'), ranges };
}

/** 递归遍历保序树，按文档顺序收集所有段落（含表格单元格内段落） */
function extractOrderedParagraphs(root: any, out: OrderedParagraph[]): void {
  const walk = (children: any[]): void => {
    for (const child of children) {
      const tag = orderedTag(child);
      if (!tag) continue;
      const kids = child[tag];
      if (!Array.isArray(kids)) continue;
      if (tag === 'p') out.push(analyzeParagraphOrdered(kids));
      else walk(kids);
    }
  };
  if (Array.isArray(root)) walk(root);
}

/** 递归按解析顺序收集 body 中的 Paragraph（含嵌套表格），用于批注区间对齐 */
function collectGroupedParagraphs(blocks: Block[], out: Paragraph[]): void {
  for (const b of blocks) {
    if (b.type === 'paragraph') {
      out.push(b);
    } else if (b.type === 'table') {
      for (const row of b.rows) {
        for (const cell of row.cells) collectGroupedParagraphs(cell.blocks, out);
      }
    }
  }
}

/** 段落文本签名（与保序视图口径一致：仅顶层 run 的文本，\0 连接） */
function groupedParagraphSignature(p: Paragraph): string {
  return p.runs
    .filter((r): r is Run => r.type === 'run')
    .map((r) => r.text ?? '')
    .join('\u0000');
}

/**
 * 把保序解析得到的批注区间对齐回分组解析产出的 Paragraph。
 * 采用「单调文本签名匹配」：按文档顺序扫描保序段落，在分组段落列表中
 * 从前到后寻找首个签名一致的段落并写入 commentRanges；匹配成功即前进游标。
 * 避免因 p/tbl 交错导致的整体错位（匹配失败则安全跳过，不错配）。
 *
 * @returns 未能匹配（降级）的段落数量（>0 时由调用方登记保真说明）
 */
function applyCommentRanges(body: Block[], ordered: OrderedParagraph[]): number {
  const grouped: Paragraph[] = [];
  collectGroupedParagraphs(body, grouped);
  const withRanges = ordered.filter((o) => o.ranges.length > 0);
  if (!withRanges.length) return 0;

  let cursor = 0;
  let unmatched = 0;
  for (const o of withRanges) {
    let idx = -1;
    for (let j = cursor; j < grouped.length; j++) {
      if (groupedParagraphSignature(grouped[j]) === o.signature) {
        idx = j;
        break;
      }
    }
    if (idx >= 0) {
      grouped[idx].commentRanges = o.ranges;
      cursor = idx + 1;
    } else {
      unmatched += 1;
    }
  }
  return unmatched;
}

/** 解析 word/comments.xml → JkComment[]（缺失或无内容时返回空数组） */
async function parseComments(zip: Zip): Promise<JkComment[]> {
  const xml = await readPart(zip, 'word/comments.xml');
  if (!xml) return [];
  const obj = parseXml(xml);
  const root = obj.comments;
  if (!root) return [];
  return ensureArray(root.comment).map((c: any): JkComment => {
    const text = ensureArray(c.p)
      .map((p: any) => deepText(p).trim())
      .join('\n');
    const comment: JkComment = { id: getAttr(c, '@_id') ?? '', text };
    const author = getAttr(c, '@_author');
    if (author !== undefined) comment.author = author;
    const initials = getAttr(c, '@_initials');
    if (initials !== undefined) comment.initials = initials;
    const date = getAttr(c, '@_date');
    if (date !== undefined) comment.date = date;
    const done = getAttr(c, '@_done');
    if (done === '1' || done === 'true') comment.resolved = true;
    return comment;
  });
}

/* =========================================================================
 * 9. 块级元素（Paragraph / Table）与递归容器
 * ========================================================================= */

const BLOCK_SKIP = new Set([
  'pPr',
  'tcPr',
  'trPr',
  'tblPr',
  'tblGrid',
  'sectPr',
  'tblPrEx',
]);

function parseParagraph(p: any): Paragraph {
  const pPr = p.pPr ? parseParagraphProperties(p.pPr) : undefined;
  const runs = parseContainerInlines(p);
  return { type: 'paragraph', runs, pPr, data: { __raw: p } };
}

function parseTableCell(tc: any): TableCell {
  const blocks = parseContainerBlocks(tc);
  const cellPr = tc.tcPr ? parseTableCellProperties(tc.tcPr) : undefined;
  return { type: 'tableCell', blocks, cellPr, data: { __raw: tc } };
}

function parseTableRow(tr: any): TableRow {
  const cells = ensureArray(tr.tc).map(parseTableCell);
  const rowPr = tr.trPr ? parseTableRowProperties(tr.trPr) : undefined;
  return { type: 'tableRow', cells, rowPr, data: { __raw: tr } };
}

function parseTable(tbl: any): Table {
  const rows = ensureArray(tbl.tr).map(parseTableRow);
  const tablePr = tbl.tblPr ? parseTableProperties(tbl.tblPr) : undefined;
  let grid: TableGrid | undefined;
  if (tbl.tblGrid) {
    const cols = ensureArray(tbl.tblGrid.gridCol).map((g: any) => tw2emu(getAttr(g, '@_w')) ?? 0);
    if (cols.length) grid = { cols };
  }
  return { type: 'table', rows, tablePr, grid, data: { __raw: tbl } };
}

function parseContainerBlocks(
  container: any,
  unsupported?: UnsupportedFeature[],
  unparsedBlocks?: any[],
): Block[] {
  const blocks: Block[] = [];
  if (!container || typeof container !== 'object') return blocks;
  for (const tag of Object.keys(container)) {
    if (tag.startsWith('@') || tag.startsWith('#') || tag.startsWith('?')) continue;
    if (BLOCK_SKIP.has(tag)) continue;
    const items = ensureArray(container[tag]);
    for (const item of items) {
      if (tag === 'p') {
        const para = parseParagraph(item);
        // 段内分节符（pPr/sectPr）→ SectionBreak 块
        const sectPr = item.pPr?.sectPr;
        if (sectPr && unsupported) {
          if (para.runs.length === 0) {
            // 空的分节段落：仅产出 SectionBreak（导出时它会还原为带 sectPr 的空段，
            // 若此处同时保留空 Paragraph，round-trip 每保存一次会净增一个空段）
            blocks.push(makeSectionBreak(sectPr));
          } else {
            blocks.push(para);
            blocks.push(makeSectionBreak(sectPr));
          }
        } else {
          blocks.push(para);
        }
      } else if (tag === 'tbl') {
        blocks.push(parseTable(item));
      } else if (unsupported && unparsedBlocks) {
        // 未识别的块级元素：降级保留，不丢数据
        unsupported.push(
          unsupportedFeature(
            mapUnknownKind(tag),
            `不支持的块级元素 <${tag}>，已降级保留于兜底数据`,
            'body',
            'docx',
          ),
        );
        unparsedBlocks.push({ tag, raw: item });
      }
    }
  }
  return blocks;
}

/* =========================================================================
 * 10. 分节与页面（sectPr）
 * ========================================================================= */

function parseSectionRefs(node: any, tag: 'headerReference' | 'footerReference'): SectionRef[] {
  return ensureArray(node[tag]).map((h: any) => ({
    refType: (getAttr(h, '@_type') as SectionRef['refType']) ?? 'default',
    relId: getAttr(h, '@_id') ?? '',
  }));
}

/**
 * 解析页眉/页脚部件（word/headerN.xml 或 word/footerN.xml）。
 * 根节点 <w:hdr>/<w:ftr> 下直接是 <w:p>/<w:tbl>，与 document.xml 的 body 子节点同构，
 * 因此复用 `parseContainerBlocks` 当作「mini body」处理。返回 Block[]。
 * @param xml 部件完整 XML 字符串
 */
function parseHeaderFooter(xml: string): Block[] {
  const obj = parseXml(xml);
  // 去掉命名空间前缀后根节点本地名为 hdr / ftr（极少数情况可能是 document 容器，一并兜底）
  const root: any = obj.hdr ?? obj.ftr ?? obj.document?.body ?? null;
  if (!root) return [];
  return parseContainerBlocks(root);
}

/**
 * 规整 relId → 页眉/页脚部件路径（相对 zip 根）。
 * target 形如 "header1.xml"（相对 word/）或 "/word/header1.xml"（绝对）。
 * @returns 形如 "word/header1.xml" 的部件路径，未找到映射返回 undefined
 */
function hfPartPathForRel(
  relId: string,
  relMap: Map<string, string>,
): string | undefined {
  const target = relMap.get(relId);
  if (!target) return undefined;
  return target.startsWith('/') ? target.slice(1) : `word/${target}`;
}

function parseSectionProps(
  sectPr: any,
  hfParts: Map<string, string> = new Map(),
  hfRelMap: Map<string, string> = new Map(),
): Section {
  const section: Section = { type: 'section' };
  if (sectPr.pgSz) {
    const w = tw2emu(getAttr(sectPr.pgSz, '@_w'));
    const h = tw2emu(getAttr(sectPr.pgSz, '@_h'));
    if (w !== undefined && h !== undefined) section.pageSize = { width: w, height: h };
    const orient = getAttr(sectPr.pgSz, '@_orient');
    if (orient === 'landscape' || orient === 'portrait') section.orientation = orient;
  }
  if (sectPr.pgMar) {
    const m = sectPr.pgMar;
    const top = tw2emu(getAttr(m, '@_top'));
    const right = tw2emu(getAttr(m, '@_right'));
    const bottom = tw2emu(getAttr(m, '@_bottom'));
    const left = tw2emu(getAttr(m, '@_left'));
    if (top !== undefined && right !== undefined && bottom !== undefined && left !== undefined) {
      section.pageMargin = {
        top,
        right,
        bottom,
        left,
        header: tw2emu(getAttr(m, '@_header')),
        footer: tw2emu(getAttr(m, '@_footer')),
        gutter: tw2emu(getAttr(m, '@_gutter')),
      };
    }
  }
  section.headerRefs = parseSectionRefs(sectPr, 'headerReference');
  section.footerRefs = parseSectionRefs(sectPr, 'footerReference');

  // 回填页眉/页脚内容（MVP 只取 type==='default' 的内容，其余保留引用不读取）
  if (section.headerRefs && section.headerRefs.length) {
    const blocks: Block[] = [];
    for (const hr of section.headerRefs) {
      if (hr.refType !== 'default') continue;
      const partPath = hfPartPathForRel(hr.relId, hfRelMap);
      const xml = partPath ? hfParts.get(partPath.toLowerCase()) : undefined;
      if (xml) blocks.push(...parseHeaderFooter(xml));
    }
    if (blocks.length) section.header = blocks;
  }
  if (section.footerRefs && section.footerRefs.length) {
    const blocks: Block[] = [];
    for (const fr of section.footerRefs) {
      if (fr.refType !== 'default') continue;
      const partPath = hfPartPathForRel(fr.relId, hfRelMap);
      const xml = partPath ? hfParts.get(partPath.toLowerCase()) : undefined;
      if (xml) blocks.push(...parseHeaderFooter(xml));
    }
    if (blocks.length) section.footer = blocks;
  }

  return section;
}

function makeSectionBreak(sectPr: any): SectionBreak {
  return {
    type: 'sectionBreak',
    breakType: mapBreakType(getAttr(sectPr, '@_type')),
    section: parseSectionProps(sectPr),
  };
}

function parseSections(
  bodyNode: any,
  unsupported: UnsupportedFeature[],
  hfParts: Map<string, string> = new Map(),
  hfRelMap: Map<string, string> = new Map(),
): Section[] {
  const sections: Section[] = [];
  if (bodyNode?.sectPr) {
    for (const sp of ensureArray(bodyNode.sectPr)) {
      sections.push(parseSectionProps(sp, hfParts, hfRelMap));
    }
  }
  void unsupported;
  return sections;
}

/* =========================================================================
 * 11. 顶层入口
 * ========================================================================= */

/**
 * 扫描正文（含嵌套表格与超链接内 run）收集修订作者清单。
 * 去重：同一作者取「较晚」的修订时间（ISO 字符串可直接字典序比较）。
 * 供 `JkDocument.revisions` 展示使用；无修订返回空数组。
 */
function collectRevisionAuthors(body: Block[]): RevisionAuthor[] {
  const map = new Map<string, string>();
  const walkInlines = (inlines: Inline[]): void => {
    for (const inl of inlines) {
      if (inl.type === 'run') {
        const rev = inl.revision;
        if (rev?.author) {
          const prev = map.get(rev.author);
          const date = rev.date ?? '';
          if (prev === undefined || date > prev) map.set(rev.author, date);
        }
      } else if (inl.type === 'hyperlink') {
        walkInlines(inl.runs);
      }
    }
  };
  const walkBlocks = (blocks: Block[]): void => {
    for (const b of blocks) {
      if (b.type === 'paragraph') walkInlines(b.runs);
      else if (b.type === 'table') {
        for (const row of b.rows) for (const cell of row.cells) walkBlocks(cell.blocks);
      }
    }
  };
  walkBlocks(body);
  return [...map.entries()].map(([author, date]) => ({ author, date }));
}

/**
 * 解析 .docx 字节流为 JkDocument。
 * @param buffer .docx 文件内容（Uint8Array / ArrayBuffer / Node Buffer）
 */
export async function parseDocx(buffer: Uint8Array): Promise<JkDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const docXml = await readPart(zip, 'word/document.xml');
  if (!docXml) {
    throw new Error('docx 缺少 word/document.xml，可能不是有效的 Word 文档');
  }
  const docObj = parseXml(docXml);
  const documentNode = docObj.document ?? {};
  const bodyNode = documentNode.body ?? {};

  const rels = await parseRelationships(zip, 'word/_rels/document.xml.rels');

  // 收集页眉/页脚部件：遍历 zip 内 word/headerN.xml 与 word/footerN.xml
  const hfParts = new Map<string, string>();
  for (const path of Object.keys(zip.files)) {
    if (/^word\/header\d+\.xml$/i.test(path) || /^word\/footer\d+\.xml$/i.test(path)) {
      try {
        const xml = await zip.files[path].async('string');
        if (xml) hfParts.set(path.toLowerCase(), xml);
      } catch {
        // 部件读取失败：跳过该部件（不阻断整体解析）
      }
    }
  }
  // relId → target 映射（target 相对 word/，如 header1.xml），用于把引用解析到具体部件
  const hfRelMap = new Map<string, string>();
  for (const rel of rels) hfRelMap.set(rel.id, rel.target);

  const [styleDefs, numberingDefs, settings, media, comments] = await Promise.all([
    parseStyles(zip),
    parseNumbering(zip),
    parseSettings(zip),
    parseMedia(zip, rels),
    parseComments(zip),
  ]);

  const unsupported: UnsupportedFeature[] = [];
  const unparsedBlocks: any[] = [];

  const body = parseContainerBlocks(bodyNode, unsupported, unparsedBlocks);

  // 批注锚点：用保序解析提取每段 commentRanges，并回写到对应 Paragraph
  const orderedParagraphs: OrderedParagraph[] = [];
  extractOrderedParagraphs(parseXmlOrdered(docXml), orderedParagraphs);
  const unmatchedComments = applyCommentRanges(body, orderedParagraphs);
  if (unmatchedComments > 0) {
    unsupported.push(
      unsupportedFeature(
        'other',
        `有 ${unmatchedComments} 处批注锚点因段落结构复杂（跨段/含域等）未精确还原，已降级`,
        'comments',
        'docx',
      ),
    );
  }

  const sections = parseSections(bodyNode, unsupported, hfParts, hfRelMap);

  const fidelity: FidelityReport = {
    level: 'L2',
    features: unsupported,
  };

  const doc: JkDocument = {
    body,
    sections,
    styleDefs,
    numberingDefs,
    settings,
    relationships: rels,
    media,
    fidelity,
  };

  if (comments.length) doc.comments = comments;

  // 汇总修订作者（可选字段，便于 UI 展示）
  const revisionAuthors = collectRevisionAuthors(body);
  if (revisionAuthors.length) doc.revisions = revisionAuthors;

  if (unparsedBlocks.length) {
    doc.data = { ...doc.data, __unparsedBlocks: unparsedBlocks };
  }

  return doc;
}

/**
 * 从文件路径读取 .docx 并解析（Node / Electron 主进程环境）。
 * @param path 本地 .docx 文件路径
 */
export async function parseDocxFile(path: string): Promise<JkDocument> {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);
  return parseDocx(new Uint8Array(buf));
}
