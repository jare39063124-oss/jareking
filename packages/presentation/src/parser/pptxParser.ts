/**
 * T3.1 pptx 解析器：fflate 流式解压 + fast-xml-parser → JkPresentation。
 *
 * 覆盖（基础保真）：幻灯片顺序 / 画布尺寸 / 文本框（段落+run 格式）/
 * 预设几何形状（含形状内文字与纯色填充）/ 图片（记录 relId）。
 * 动画/切换/主题母版/SmartArt/图表 v1 降级忽略并记录。
 *
 * 注意：XMLParser 开启 removeNSPrefix，所有标签键不带 p:/a: 前缀
 * （与 docx 解析器同一约定）：sp / pic / spPr / xfrm / off / ext /
 * prstGeom / solidFill / srgbClr / txBody / p / r / t / rPr …
 *
 * #46-C（2026-10-15）：原实现用 JSZip.loadAsync 一次性把整包解压进内存，
 * 大文件峰值高。现改为 fflate 流式逐条目解压——
 *   - 每个 zip 条目按需解压，幻灯片 XML 解析完即丢弃（不堆内存）；
 *   - 仅保留显示必需的 media 字节；
 *   - theme/embeddings/docProps/notesMaster 等无关条目直接丢弃，不占内存。
 * 解析逻辑（parseSp/parsePic/parseShapeTree 等）与旧版完全一致，零行为回归。
 */

import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from 'fflate';
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
 * 流式 zip 读取（fflate）—— 逐条目解压，降低解析峰值
 * ========================================================================= */

const textDecoder = new TextDecoder();

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

interface SlideAccum {
  partName: string;
  shapes: JkShape[];
  transition: 'none' | 'fade';
}

/** 判断 zip 条目是否为解析需要保留的部件（其余条目数据直接丢弃，降峰值） */
function isNeededPart(name: string): boolean {
  return (
    name === 'ppt/presentation.xml' ||
    name === 'ppt/_rels/presentation.xml.rels' ||
    /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
    /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name) ||
    /^ppt\/media\//.test(name)
  );
}

/**
 * 流式解压 pptx 字节 → 收集必要部件。
 * - presXml / presRels：小，保留（决定幻灯片顺序）。
 * - slidesByPart：每页幻灯片 XML 解析为模型后**立即丢弃 XML 字符串**。
 * - mediaByPath：保留显示必需的图片字节。
 * - 其余无关条目（theme/embeddings/docProps/notesMaster 等）直接丢弃，不占内存。
 */
function streamUnzip(
  u8: Uint8Array,
): Promise<{
  presXml?: string;
  presRels?: string;
  slidesByPart: Map<string, SlideAccum>;
  slideRelsByPart: Map<string, string>;
  mediaByPath: Map<string, Uint8Array>;
  skippedNotes: string[];
}> {
  const presXmlRef: { value?: string } = {};
  const presRelsRef: { value?: string } = {};
  const slidesByPart = new Map<string, SlideAccum>();
  const slideRelsByPart = new Map<string, string>();
  const mediaByPath = new Map<string, Uint8Array>();
  const skippedNotes: string[] = [];

  return new Promise((resolve, reject) => {
    const unzip = new Unzip();
    // 注册解码器：deflate（8）与 stored（0）覆盖 OOXML 包的全部压缩方式；
    // 未注册压缩方式的条目 start() 会抛错，按条目跳过不致命
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);
    let pending = 0;
    let finalPushed = false;

    const maybeFinish = () => {
      if (finalPushed && pending === 0) {
        try {
          resolve({
            presXml: presXmlRef.value,
            presRels: presRelsRef.value,
            slidesByPart,
            slideRelsByPart,
            mediaByPath,
            skippedNotes,
          });
        } catch (e) {
          reject(e);
        }
      }
    };

    unzip.onfile = (file: UnzipFile) => {
      // 目录条目：无数据，直接终止
      if (file.name.endsWith('/')) {
        file.terminate();
        return;
      }
      pending++;
      const keep = isNeededPart(file.name);
      const chunks: Uint8Array[] = [];
      file.ondata = (err, chunk, final) => {
        if (err) {
          pending--;
          file.terminate();
          reject(new Error(`解压失败 ${file.name}: ${String(err)}`));
          return;
        }
        // 无关条目的 chunk 直接丢弃（不累积，内存瞬时）
        if (keep && chunk) chunks.push(chunk);
        if (final) {
          if (keep) routeEntry(file.name, concatBytes(chunks));
          pending--;
          maybeFinish();
        }
      };
      try {
        file.start();
      } catch {
        // 压缩方式未注册（如 LZMA）：按条目降级跳过
        pending--;
        file.terminate();
        skippedNotes.push(`跳过不支持的压缩条目 ${file.name}`);
        maybeFinish();
      }
    };

    const routeEntry = (name: string, data: Uint8Array) => {
      if (name === 'ppt/presentation.xml') {
        presXmlRef.value = textDecoder.decode(data);
        return;
      }
      if (name === 'ppt/_rels/presentation.xml.rels') {
        presRelsRef.value = textDecoder.decode(data);
        return;
      }
      const slideMatch = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
      if (slideMatch) {
        const xml = textDecoder.decode(data);
        const slideObj = parseXml(xml);
        const spTree = slideObj?.sld?.cSld?.spTree;
        const transition = slideObj?.sld?.transition?.fade !== undefined ? 'fade' : 'none';
        // 解析后立即丢弃 XML 字符串（仅留模型），降低峰值
        slidesByPart.set(name, {
          partName: name,
          shapes: parseShapeTree(spTree),
          transition,
        });
        return;
      }
      const relsMatch = /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/.exec(name);
      if (relsMatch) {
        slideRelsByPart.set(name, textDecoder.decode(data));
        return;
      }
      if (/^ppt\/media\//.test(name)) {
        mediaByPath.set(name, data);
        return;
      }
      // 其余条目（theme/embeddings/docProps/notesMaster 等）不保留
    };

    try {
      // 整文件已在内存在手，一次性喂入；fflate 仍按需逐条目解压（非全量同时驻留）
      unzip.push(u8, true);
      finalPushed = true;
      maybeFinish();
    } catch (e) {
      reject(e);
    }
  });
}

/* =========================================================================
 * 主入口
 * ========================================================================= */

export async function parsePptx(buffer: Uint8Array | ArrayBuffer): Promise<JkPresentation> {
  const u8 = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;

  const { presXml, presRels, slidesByPart, slideRelsByPart, mediaByPath, skippedNotes } =
    await streamUnzip(u8);

  if (!presXml) throw new Error('pptx 缺少 ppt/presentation.xml，可能不是有效的演示文稿');
  const presObj = parseXml(presXml);
  const sldSz = presObj?.presentation?.sldSz;
  const slideWidth = num(getAttr(sldSz, '@_cx')) ?? 9144000;
  const slideHeight = num(getAttr(sldSz, '@_cy')) ?? 6858000;

  const relMap = new Map<string, string>();
  if (presRels) {
    const rels = parseXml(presRels);
    for (const rel of childArray(rels?.Relationships, 'Relationship')) {
      relMap.set(getAttr(rel, '@_Id') ?? '', getAttr(rel, '@_Target') ?? '');
    }
  }

  const sldIdLst = presObj?.presentation?.sldIdLst;
  const slideRefs = childArray(sldIdLst, 'sldId');
  const notes: string[] = ['动画/切换/母版样式/SmartArt/图表 v1 降级忽略', ...skippedNotes];

  let orderedParts: string[];
  if (slideRefs.length) {
    orderedParts = [];
    for (const ref of slideRefs) {
      const rid = getAttr(ref, '@_id');
      let target = relMap.get(rid ?? '');
      if (!target) continue;
      // rels 的 Target 相对 ppt/ 目录（可能是 "slides/slide1.xml" 或 "../slides/…"）
      target = target.replace(/^\.\.\//, '');
      if (!target.startsWith('slides/')) target = `slides/${target}`;
      orderedParts.push(`ppt/${target}`);
    }
  } else {
    // 兜底：无 sldIdLst 时按包内 slideN.xml 排序
    orderedParts = [...slidesByPart.keys()]
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(/slide(\d+)\.xml/.exec(a)?.[1] ?? 0);
        const nb = Number(/slide(\d+)\.xml/.exec(b)?.[1] ?? 0);
        return na - nb;
      });
  }

  const slides: JkSlide[] = [];
  const media: Record<string, Uint8Array> = {};
  let index = 0;
  for (const partName of orderedParts) {
    const accum = slidesByPart.get(partName);
    if (!accum) continue;
    // 本页 media 提取（rId 每页独立，键为 `${index}:${relId}`）
    const relsPath = partName.replace(/([^/]+)$/, '_rels/$1.rels');
    const relsXml = slideRelsByPart.get(relsPath);
    if (relsXml) {
      const rels = parseXml(relsXml);
      for (const rel of childArray(rels?.Relationships, 'Relationship')) {
        const type = getAttr(rel, '@_Type') ?? '';
        if (!type.endsWith('/image')) continue;
        const id = getAttr(rel, '@_Id') ?? '';
        if (!id) continue;
        let target = getAttr(rel, '@_Target') ?? '';
        while (target.startsWith('../')) target = target.slice(3);
        if (!target.startsWith('ppt/')) target = `ppt/${target}`;
        const bytes = mediaByPath.get(target);
        if (bytes) media[`${index}:${id}`] = bytes;
      }
    }
    slides.push({ partName, shapes: accum.shapes, transition: accum.transition });
    index++;
  }

  return {
    slides,
    slideWidth,
    slideHeight,
    media: Object.keys(media).length ? media : undefined,
    fidelity: { level: 'L1', notes },
  };
}

/** 从文件路径读取并解析 pptx（Node / Electron 主进程） */
export async function parsePptxFile(path: string): Promise<JkPresentation> {
  const fs = (await import('node:fs/promises')) as { readFile: (p: string) => Promise<Buffer> };
  const buf = await fs.readFile(path);
  return parsePptx(new Uint8Array(buf));
}
