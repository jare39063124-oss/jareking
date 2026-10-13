/**
 * T3.1 pptx 解析器：JSZip + fast-xml-parser → JkPresentation。
 *
 * 覆盖（基础保真）：幻灯片顺序 / 画布尺寸 / 文本框（段落+run 格式）/
 * 预设几何形状（含形状内文字与纯色填充）/ 图片（记录 relId）。
 * 动画/切换/主题母版/SmartArt/图表 v1 降级忽略并记录。
 *
 * 注意：XMLParser 开启 removeNSPrefix，所有标签键不带 p:/a: 前缀
 * （与 docx 解析器同一约定）：sp / pic / spPr / xfrm / off / ext /
 * prstGeom / solidFill / srgbClr / txBody / p / r / t / rPr …
 */
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type {
  JkAutoShape,
  JkPresentation,
  JkShape,
  JkSlide,
  JkTextShape,
  TextParagraph,
  TextRun,
} from '../model/index.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  textNodeName: '#text',
  trimValues: true,
  parseAttributeValue: false,
});

function parseXml(xml: string): any {
  return xmlParser.parse(xml);
}

function ensureArray<T = any>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function getAttr(node: any, attr: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const v = node[attr];
  return v === undefined || v === null ? undefined : String(v);
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function readPart(zip: JSZip, path: string): Promise<string | undefined> {
  const file = zip.file(path);
  if (!file) return undefined;
  return file.async('string');
}

/** 通用子节点取值：兼容对象/数组形态 */
function childArray(node: any, key: string): any[] {
  if (!node || typeof node !== 'object') return [];
  return ensureArray(node[key]);
}

/* =========================================================================
 * 形状树解析
 * ========================================================================= */

/** xfrm → 位置尺寸（EMU 原值） */
function parseXfrm(xfrm: any): { x: number; y: number; w: number; h: number; rotation?: number } {
  const off = xfrm?.off;
  const ext = xfrm?.ext;
  const rot = num(getAttr(xfrm, '@_rot'));
  return {
    x: num(getAttr(off, '@_x')) ?? 0,
    y: num(getAttr(off, '@_y')) ?? 0,
    w: num(getAttr(ext, '@_cx')) ?? 0,
    h: num(getAttr(ext, '@_cy')) ?? 0,
    rotation: rot !== undefined ? rot / 60000 : undefined,
  };
}

/** srgbClr 纯色填充 → #RRGGBB（主题色/渐变降级为空） */
function parseSolidFill(solidFill: any): string | undefined {
  const val = getAttr(solidFill?.srgbClr, '@_val');
  if (val && /^[0-9A-Fa-f]{6}$/.test(val)) return `#${val.toUpperCase()}`;
  return undefined;
}

/** a:p（→ p）→ TextParagraph（含 run 格式） */
function parseParagraph(p: any): TextParagraph {
  const para: TextParagraph = { runs: [] };
  const pPr = p?.pPr;
  const align = getAttr(pPr, '@_algn');
  if (align === 'l' || align === 'ctr' || align === 'r' || align === 'just') {
    const alignMap = { l: 'left', ctr: 'center', r: 'right', just: 'justify' } as const;
    para.align = alignMap[align];
  }
  const lvl = num(getAttr(pPr, '@_lvl'));
  if (lvl !== undefined) para.level = lvl;
  if (pPr?.buChar !== undefined || pPr?.buAutoNum !== undefined) para.bullet = true;

  for (const r of childArray(p, 'r')) {
    const t = r?.t;
    const text = typeof t === 'string' ? t : (t?.['#text'] ?? '');
    const run: TextRun = { text: String(text) };
    const rPr = r?.rPr;
    if (rPr) {
      if (getAttr(rPr, '@_b') === '1') run.bold = true;
      if (getAttr(rPr, '@_i') === '1') run.italic = true;
      const u = getAttr(rPr, '@_u');
      if (u && u !== 'none') run.underline = true;
      const sz = num(getAttr(rPr, '@_sz'));
      if (sz !== undefined) run.fontSize = sz / 100;
      const fill = parseSolidFill(rPr?.solidFill);
      if (fill) run.color = fill;
      const latin = getAttr(rPr?.latin, '@_typeface');
      if (latin) run.fontFamily = latin;
    }
    if (run.text || Object.keys(run).length > 1) para.runs.push(run);
  }
  return para;
}

/** txBody → TextParagraph[] */
function parseTextBody(txBody: any): TextParagraph[] {
  if (!txBody) return [];
  return childArray(txBody, 'p').map(parseParagraph);
}

/** sp（形状/文本框）→ JkShape */
function parseSp(sp: any): JkShape | null {
  const spPr = sp?.spPr;
  const xfrm = spPr?.xfrm;
  if (!xfrm) return null; // 无位置的连接线等，v1 跳过
  const pos = parseXfrm(xfrm);
  const cNvPr = sp?.nvSpPr?.cNvPr;
  const geom = getAttr(spPr?.prstGeom, '@_prst');
  const ph = getAttr(sp?.nvSpPr?.nvPr?.ph, '@_type');
  const paragraphs = parseTextBody(sp?.txBody);

  const base = {
    id: getAttr(cNvPr, '@_id'),
    name: getAttr(cNvPr, '@_name'),
    ...pos,
  };

  // 分类规则：无几何或 rect 几何 + 有文本 → 文本框（真实 PPT 文本框都带 prstGeom rect）；
  // 其余几何 → 预设形状（可携带文字）
  const isPlainBox = !geom || geom === 'rect';
  if (isPlainBox) {
    const text: JkTextShape = {
      type: 'text',
      ...base,
      paragraphs,
      placeholder: ph,
      geom: geom || undefined,
    };
    return text;
  }

  const shape: JkAutoShape = {
    type: 'shape',
    geom,
    ...base,
    paragraphs: paragraphs.length ? paragraphs : undefined,
    fill: parseSolidFill(spPr?.solidFill),
  };
  return shape;
}

/** pic（图片）→ JkImageShape */
function parsePic(pic: any): JkShape | null {
  const xfrm = pic?.spPr?.xfrm;
  if (!xfrm) return null;
  const pos = parseXfrm(xfrm);
  const relId = getAttr(pic?.blipFill?.blip, '@_embed');
  return {
    type: 'image',
    relId: relId ?? '',
    id: getAttr(pic?.nvPicPr?.cNvPr, '@_id'),
    name: getAttr(pic?.nvPicPr?.cNvPr, '@_name'),
    ...pos,
  };
}

/** spTree → JkShape[]（sp/pic 按序；graphicFrame 表格/图表 v1 降级） */
function parseShapeTree(spTree: any): JkShape[] {
  const shapes: JkShape[] = [];
  for (const sp of childArray(spTree, 'sp')) {
    const s = parseSp(sp);
    if (s) shapes.push(s);
  }
  for (const pic of childArray(spTree, 'pic')) {
    const s = parsePic(pic);
    if (s) shapes.push(s);
  }
  return shapes;
}

/* =========================================================================
 * 主入口
 * ========================================================================= */

export async function parsePptx(buffer: Uint8Array | ArrayBuffer): Promise<JkPresentation> {
  const zip = await JSZip.loadAsync(buffer as any);

  const presXml = await readPart(zip, 'ppt/presentation.xml');
  if (!presXml) throw new Error('pptx 缺少 ppt/presentation.xml，可能不是有效的演示文稿');
  const presObj = parseXml(presXml);
  const sldSz = presObj?.presentation?.sldSz;
  const slideWidth = num(getAttr(sldSz, '@_cx')) ?? 9144000;
  const slideHeight = num(getAttr(sldSz, '@_cy')) ?? 6858000;

  // presentation.xml.rels: rId → slides/slideN.xml
  const relsXml = await readPart(zip, 'ppt/_rels/presentation.xml.rels');
  const relMap = new Map<string, string>();
  if (relsXml) {
    const rels = parseXml(relsXml);
    for (const rel of childArray(rels?.Relationships, 'Relationship')) {
      relMap.set(getAttr(rel, '@_Id') ?? '', getAttr(rel, '@_Target') ?? '');
    }
  }

  const sldIdLst = presObj?.presentation?.sldIdLst;
  const slideRefs = childArray(sldIdLst, 'sldId');
  const notes: string[] = ['动画/切换/母版样式/SmartArt/图表 v1 降级忽略'];

  const slides: JkSlide[] = [];
  for (const ref of slideRefs) {
    const rid = getAttr(ref, '@_id');
    let target = relMap.get(rid ?? '');
    if (!target) continue;
    // rels 的 Target 相对 ppt/ 目录（可能是 "slides/slide1.xml" 或 "../slides/…"）
    target = target.replace(/^\.\.\//, '');
    if (!target.startsWith('slides/')) target = `slides/${target}`;
    const partName = `ppt/${target}`;
    const slideXml = await readPart(zip, partName);
    if (!slideXml) continue;
    const slideObj = parseXml(slideXml);
    const spTree = slideObj?.sld?.cSld?.spTree;
    slides.push({ partName, shapes: parseShapeTree(spTree) });
  }

  // 兜底：无 sldIdLst 时按包内 slideN.xml 排序
  if (!slides.length) {
    const slideFiles = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(/slide(\d+)\.xml/.exec(a)?.[1] ?? 0);
        const nb = Number(/slide(\d+)\.xml/.exec(b)?.[1] ?? 0);
        return na - nb;
      });
    for (const name of slideFiles) {
      const slideXml = await readPart(zip, name);
      if (!slideXml) continue;
      const slideObj = parseXml(slideXml);
      slides.push({ partName: name, shapes: parseShapeTree(slideObj?.sld?.cSld?.spTree) });
    }
  }

  return {
    slides,
    slideWidth,
    slideHeight,
    fidelity: { level: 'L1', notes },
  };
}

/** 从文件路径读取并解析 pptx（Node / Electron 主进程） */
export async function parsePptxFile(path: string): Promise<JkPresentation> {
  const fs = (await import('node:fs/promises')) as { readFile: (p: string) => Promise<Buffer> };
  const buf = await fs.readFile(path);
  return parsePptx(new Uint8Array(buf));
}
