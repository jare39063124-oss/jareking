/**
 * T3.1 pptx 解析器：fflate 流式解压 + fast-xml-parser → JkPresentation。
 *
 * 覆盖（基础保真）：幻灯片顺序 / 画布尺寸 / 文本框（段落+run 格式）/
 * 预设几何形状（含形状内文字与纯色填充）/ 图片（记录 relId）/ 表格（graphicFrame → a:tbl）/
 * 幻灯片母版与版式（最小承载：名称、占位符类型、背景色、所属关系）。
 * 动画/切换/SmartArt/图表 v1 降级忽略并记录。
 *
 * 注意：XMLParser 开启 removeNSPrefix，所有标签键不带 p:/a: 前缀
 * （与 docx 解析器同一约定）：sp / pic / spPr / xfrm / off / ext /
 * prstGeom / solidFill / srgbClr / txBody / p / r / t / rPr …
 * 表格：graphicFrame / graphic / graphicData / tbl / tblGrid / gridCol / tr / tc / txBody …
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
  JkSlideLayout,
  JkSlideMaster,
  JkTableCell,
  JkTableRow,
  JkTableShape,
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

/* =========================================================================
 * 表格解析（graphicFrame → a:tbl）
 * ========================================================================= */

/** 单元格文本范围：从 pPr@algn 取水平对齐（l/ctr/r） */
function parseCellAlign(p: any): JkTableCell['align'] {
  const algn = getAttr(p?.pPr, '@_algn');
  if (algn === 'ctr') return 'center';
  if (algn === 'r') return 'right';
  if (algn === 'l') return 'left';
  return undefined;
}

/**
 * a:tc → JkTableCell。
 *
 * 文本：遍历 txBody 下所有 a:p，逐段拼接 run 的 a:t；段落间以 \n 连接。
 * 格式：取首个带格式的 run（字号 sz/100→pt、颜色 solidFill srgbClr、加粗 b="1"），
 * 对齐取首个非空段落 pPr@algn。
 */
function parseTableCell(tc: any): JkTableCell {
  const txBody = tc?.txBody;
  const paragraphs = childArray(txBody, 'p');
  const lines: string[] = [];
  let fontSize: number | undefined;
  let color: string | undefined;
  let bold: boolean | undefined;
  let align: JkTableCell['align'];

  for (const p of paragraphs) {
    let line = '';
    for (const r of childArray(p, 'r')) {
      const t = r?.t;
      line += typeof t === 'string' ? t : (t?.['#text'] ?? '');
      const rPr = r?.rPr;
      if (rPr) {
        if (fontSize === undefined) {
          const sz = num(getAttr(rPr, '@_sz'));
          if (sz !== undefined) fontSize = sz / 100;
        }
        if (color === undefined) {
          const fill = parseSolidFill(rPr?.solidFill);
          if (fill) color = fill;
        }
        if (bold === undefined && getAttr(rPr, '@_b') === '1') bold = true;
      }
    }
    if (align === undefined) {
      const a = parseCellAlign(p);
      if (a) align = a;
    }
    lines.push(line);
  }

  const cell: JkTableCell = { text: lines.join('\n') };
  if (fontSize !== undefined) cell.fontSize = fontSize;
  if (color !== undefined) cell.color = color;
  if (bold !== undefined) cell.bold = bold;
  if (align !== undefined) cell.align = align;
  return cell;
}

/**
 * graphicFrame（表格）→ JkTableShape。
 *
 * 结构（removeNSPrefix 后）：
 *   graphicFrame / nvGraphicFramePr / cNvPr@name
 *   graphicFrame / xfrm / off@x,y + ext@cx,cy
 *   graphicFrame / graphic / graphicData@uri / tbl /
 *     tblGrid / gridCol@w ... ; tr@h / tc / txBody / p / r / t ...
 *
 * 仅处理 uri 含 "table" 的表格；图表（uri 含 chart）等返回 null，由调用方继续降级。
 */
function parseGraphicFrame(gf: any): JkShape | null {
  const data = gf?.graphic?.graphicData;
  const uri = getAttr(data, '@_uri') ?? '';
  if (!uri.includes('table')) return null; // 仅表格；图表等其余 graphicFrame 降级
  const tbl = data?.tbl;
  if (!tbl) return null;

  const pos = gf?.xfrm ? parseXfrm(gf.xfrm) : { x: 0, y: 0, w: 0, h: 0, rotation: undefined };

  // 列宽：tblGrid 下的 gridCol@w（tblGrid 通常为单节点，兜底兼容数组）
  const tblGrid = Array.isArray(tbl.tblGrid) ? tbl.tblGrid[0] : tbl.tblGrid;
  const colWidths: number[] = childArray(tblGrid, 'gridCol').map(
    (gc) => num(getAttr(gc, '@_w')) ?? 0,
  );

  // 行：tr@h + tc → cell
  const rows: JkTableRow[] = childArray(tbl, 'tr').map((tr) => {
    const cells = childArray(tr, 'tc').map(parseTableCell);
    const row: JkTableRow = { cells };
    const h = num(getAttr(tr, '@_h'));
    if (h !== undefined) row.height = h;
    return row;
  });

  const colTotal = colWidths.reduce((a, b) => a + b, 0);
  const cNvPr = gf?.nvGraphicFramePr?.cNvPr;
  const table: JkTableShape = {
    type: 'table',
    id: getAttr(cNvPr, '@_id'),
    name: getAttr(cNvPr, '@_name'),
    x: pos.x,
    y: pos.y,
    w: colTotal || pos.w,
    h: pos.h,
    rotation: pos.rotation,
    colWidths,
    rows,
    height: pos.h,
  };
  return table;
}

/** spTree → JkShape[]（sp/pic/graphicFrame(表格) 按序；图表等 graphicFrame v1 降级） */
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
  for (const gf of childArray(spTree, 'graphicFrame')) {
    const s = parseGraphicFrame(gf);
    if (s) shapes.push(s);
  }
  return shapes;
}

/* =========================================================================
 * 母版 / 版式解析（ppt/slideMasters/*、ppt/slideLayouts/*、ppt/theme/*）
 * ========================================================================= */

/** 从部件名提取序号（slideLayout1.xml → 1；用于稳定排序） */
function partIndex(partName: string): number {
  const m = /(\d+)\.xml$/.exec(partName);
  return m ? Number(m[1]) : 0;
}

/**
 * 关系 Target → 包内绝对部件名。
 *
 * OOXML 的 rels Target 以「源部件所在目录」为基准，可为相对（含 ../ 回退）或
 * 以 `/` 开头的绝对包路径；此处统一规整为 `ppt/...` 形式的包内绝对名。
 */
function resolvePartName(sourcePart: string, target: string): string {
  const t = (target ?? '').replace(/\\/g, '/').trim();
  if (!t) return '';
  if (t.startsWith('/')) return t.replace(/^\/+/, '');
  const baseDir = sourcePart.includes('/') ? sourcePart.replace(/\/[^/]+$/, '') : '';
  const segs = `${baseDir}/${t}`.split('/');
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** 在 rels XML 中查找指定关系类型（后缀匹配）的 Target（规整为包内绝对部件名） */
function findRelTarget(
  relsXml: string | undefined,
  sourcePart: string,
  typeSuffix: string,
): string | undefined {
  if (!relsXml) return undefined;
  const rels = parseXml(relsXml);
  for (const rel of childArray(rels?.Relationships, 'Relationship')) {
    const type = getAttr(rel, '@_Type') ?? '';
    if (!type.endsWith(typeSuffix)) continue;
    const target = getAttr(rel, '@_Target') ?? '';
    if (target) return resolvePartName(sourcePart, target);
  }
  return undefined;
}

/** theme 部件 XML → 主题名（a:theme@name） */
function parseThemeName(xml: string | undefined): string | undefined {
  if (!xml) return undefined;
  const obj = parseXml(xml);
  return getAttr(obj?.theme, '@_name');
}

/** slideMaster XML → JkSlideMaster（名称 / 背景色 / 主题名） */
function parseMaster(partName: string, xml: string, themeName?: string): JkSlideMaster {
  const obj = parseXml(xml);
  const cSld = obj?.sldMaster?.cSld;
  const master: JkSlideMaster = { partName };
  const name = getAttr(cSld, '@_name');
  if (name) master.name = name;
  if (themeName) master.themeName = themeName;
  // 背景色：cSld/bg/bgPr/solidFill（复用 srgbClr 提取）
  const bg = parseSolidFill(cSld?.bg?.bgPr?.solidFill);
  if (bg) master.bgColor = bg;
  return master;
}

/** slideLayout XML → JkSlideLayout（名称 / 占位符类型清单 / 所属母版） */
function parseLayout(partName: string, xml: string, masterPartName?: string): JkSlideLayout {
  const obj = parseXml(xml);
  const cSld = obj?.sldLayout?.cSld;
  const layout: JkSlideLayout = { partName };
  const name = getAttr(cSld, '@_name');
  if (name) layout.name = name;
  if (masterPartName) layout.masterPartName = masterPartName;
  // 占位符类型：spTree 下 sp/graphicFrame 的 nvPr/ph@type（去重，仅记录）
  const placeholders: string[] = [];
  const pushPh = (t: string | undefined) => {
    if (t && !placeholders.includes(t)) placeholders.push(t);
  };
  for (const sp of childArray(cSld?.spTree, 'sp')) {
    pushPh(getAttr(sp?.nvSpPr?.nvPr?.ph, '@_type'));
  }
  for (const gf of childArray(cSld?.spTree, 'graphicFrame')) {
    pushPh(getAttr(gf?.nvGraphicFramePr?.nvPr?.ph, '@_type'));
  }
  if (placeholders.length) layout.placeholders = placeholders;
  return layout;
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
  /** 切换效果：与模型 JkSlide.transition 保持一致（含 slide 推送） */
  transition: 'none' | 'fade' | 'slide';
}

/** 判断 zip 条目是否为解析需要保留的部件（其余条目数据直接丢弃，降峰值） */
function isNeededPart(name: string): boolean {
  return (
    name === 'ppt/presentation.xml' ||
    name === 'ppt/_rels/presentation.xml.rels' ||
    /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
    /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name) ||
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name) ||
    /^ppt\/notesSlides\/_rels\/notesSlide\d+\.xml\.rels$/.test(name) ||
    // 母版 / 版式 / 主题（母版名称、占位符类型、背景色、主题名所需）
    /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name) ||
    /^ppt\/slideMasters\/_rels\/slideMaster\d+\.xml\.rels$/.test(name) ||
    /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name) ||
    /^ppt\/slideLayouts\/_rels\/slideLayout\d+\.xml\.rels$/.test(name) ||
    /^ppt\/theme\/theme\d+\.xml$/.test(name) ||
    /^ppt\/media\//.test(name)
  );
}

/**
 * 解析 notesSlide XML → 备注纯文本。
 *
 * notesSlide 结构（removeNSPrefix 后，标签不带 p:/a: 前缀）：
 *   notes / cSld / spTree / sp / txBody / p / r / t
 * 遍历所有 sp 下的 txBody，收集每个 p 内所有 r.t 文本；段落间以 \n 连接，
 * 整体 .trim() 后返回（与正文同一 childArray 思路）。
 */
function parseNotesSlide(xml: string): string {
  const obj = parseXml(xml);
  const spTree = obj?.notes?.cSld?.spTree;
  if (!spTree) return '';
  const paragraphs: string[] = [];
  for (const sp of childArray(spTree, 'sp')) {
    const txBody = sp?.txBody;
    if (!txBody) continue;
    const text = childArray(txBody, 'p')
      .map((p: any) =>
        childArray(p, 'r')
          .map((r: any) => {
            const t = r?.t;
            return typeof t === 'string' ? t : (t?.['#text'] ?? '');
          })
          .join(''),
      )
      .join('\n');
    if (text) paragraphs.push(text);
  }
  return paragraphs.join('\n').trim();
}

/**
 * 流式解压 pptx 字节 → 收集必要部件。
 * - presXml / presRels：小，保留（决定幻灯片顺序）。
 * - slidesByPart：每页幻灯片 XML 解析为模型后**立即丢弃 XML 字符串**。
 * - notesByPart：每页备注 XML 提取文本（键 ppt/notesSlides/notesSlideN.xml）。
 * - mastersXml / layoutsXml：母版 / 版式 XML（后续解析名称、占位符、背景色）。
 * - masterRels / layoutRels：母版 / 版式关系（定位主题与所属母版）。
 * - themesXml：主题 XML（取主题名）。
 * - mediaByPath：保留显示必需的图片字节。
 * - 其余无关条目（embeddings/docProps/handoutMaster 等）直接丢弃，不占内存。
 */
function streamUnzip(
  u8: Uint8Array,
): Promise<{
  presXml?: string;
  presRels?: string;
  slidesByPart: Map<string, SlideAccum>;
  slideRelsByPart: Map<string, string>;
  notesByPart: Map<string, string>;
  mastersXml: Map<string, string>;
  layoutsXml: Map<string, string>;
  masterRels: Map<string, string>;
  layoutRels: Map<string, string>;
  themesXml: Map<string, string>;
  mediaByPath: Map<string, Uint8Array>;
  skippedNotes: string[];
}> {
  const presXmlRef: { value?: string } = {};
  const presRelsRef: { value?: string } = {};
  const slidesByPart = new Map<string, SlideAccum>();
  const slideRelsByPart = new Map<string, string>();
  const notesByPart = new Map<string, string>();
  const mastersXml = new Map<string, string>();
  const layoutsXml = new Map<string, string>();
  const masterRels = new Map<string, string>();
  const layoutRels = new Map<string, string>();
  const themesXml = new Map<string, string>();
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
            notesByPart,
            mastersXml,
            layoutsXml,
            masterRels,
            layoutRels,
            themesXml,
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
        const tr = slideObj?.sld?.transition;
        const transition: 'none' | 'fade' | 'slide' =
          tr?.fade !== undefined ? 'fade' : tr?.push !== undefined ? 'slide' : 'none';
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
      // 备注页：提取文本（键规整为 ppt/notesSlides/notesSlideN.xml）
      const notesMatch = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(name);
      if (notesMatch) {
        notesByPart.set(name, parseNotesSlide(textDecoder.decode(data)));
        return;
      }
      // 母版 / 版式 / 主题：保留 XML 文本，主入口统一解析
      if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)) {
        mastersXml.set(name, textDecoder.decode(data));
        return;
      }
      if (/^ppt\/slideMasters\/_rels\/slideMaster\d+\.xml\.rels$/.test(name)) {
        masterRels.set(name, textDecoder.decode(data));
        return;
      }
      if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)) {
        layoutsXml.set(name, textDecoder.decode(data));
        return;
      }
      if (/^ppt\/slideLayouts\/_rels\/slideLayout\d+\.xml\.rels$/.test(name)) {
        layoutRels.set(name, textDecoder.decode(data));
        return;
      }
      if (/^ppt\/theme\/theme\d+\.xml$/.test(name)) {
        themesXml.set(name, textDecoder.decode(data));
        return;
      }
      if (/^ppt\/media\//.test(name)) {
        mediaByPath.set(name, data);
        return;
      }
      // 其余条目（embeddings/docProps/notesMaster/handoutMaster/notesSlides rels 等）不保留
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

  const {
    presXml,
    presRels,
    slidesByPart,
    slideRelsByPart,
    notesByPart,
    mastersXml,
    layoutsXml,
    masterRels,
    layoutRels,
    themesXml,
    mediaByPath,
    skippedNotes,
  } = await streamUnzip(u8);

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
  // 母版/版式现已解析保留，降级说明中不再包含「母版样式」
  const notes: string[] = ['动画/切换/SmartArt/图表 v1 降级忽略', ...skippedNotes];

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
    // 本页 media 提取（rId 每页独立，键为 `${index}:${relId}`）+ 版式关联
    const relsPath = partName.replace(/([^/]+)$/, '_rels/$1.rels');
    const relsXml = slideRelsByPart.get(relsPath);
    let layoutPart: string | undefined;
    if (relsXml) {
      const rels = parseXml(relsXml);
      for (const rel of childArray(rels?.Relationships, 'Relationship')) {
        const type = getAttr(rel, '@_Type') ?? '';
        // 版式关联：slide → slideLayout
        if (type.endsWith('/slideLayout')) {
          const target = getAttr(rel, '@_Target') ?? '';
          if (target) layoutPart = resolvePartName(partName, target);
          continue;
        }
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
    const slide: JkSlide = { partName, shapes: accum.shapes, transition: accum.transition };
    if (layoutPart) slide.layout = layoutPart;
    slides.push(slide);
    index++;
  }

  // 母版：名称 / 背景色 / 主题名（主题经 master rels → theme 部件取得）
  const masters: JkSlideMaster[] = [...mastersXml.entries()]
    .map(([partName, xml]) => {
      const relsPath = partName.replace(/([^/]+)$/, '_rels/$1.rels');
      const themePart = findRelTarget(masterRels.get(relsPath), partName, '/theme');
      const themeName = themePart ? parseThemeName(themesXml.get(themePart)) : undefined;
      return parseMaster(partName, xml, themeName);
    })
    .sort((a, b) => partIndex(a.partName) - partIndex(b.partName));

  // 版式：名称 / 占位符类型 / 所属母版（经 layout rels → slideMaster 部件取得）
  const layouts: JkSlideLayout[] = [...layoutsXml.entries()]
    .map(([partName, xml]) => {
      const relsPath = partName.replace(/([^/]+)$/, '_rels/$1.rels');
      const masterPart = findRelTarget(layoutRels.get(relsPath), partName, '/slideMaster');
      return parseLayout(partName, xml, masterPart);
    })
    .sort((a, b) => partIndex(a.partName) - partIndex(b.partName));

  // 备注回填：逐页读取 slide rels，找到指向 notesSlide 的关系，查 notesByPart
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    if (!slide.partName) continue;
    const relsPath = slide.partName.replace(/([^/]+)$/, '_rels/$1.rels');
    const relsXml = slideRelsByPart.get(relsPath);
    if (!relsXml) continue;
    const rels = parseXml(relsXml);
    const target = (() => {
      for (const rel of childArray(rels?.Relationships, 'Relationship')) {
        const type = getAttr(rel, '@_Type') ?? '';
        if (!type.endsWith('/notesSlide')) continue;
        let t = getAttr(rel, '@_Target') ?? '';
        // Target 相对 ppt/slides/ 目录，形如 ../notesSlides/notesSlide1.xml
        while (t.startsWith('../')) t = t.slice(3);
        if (!t.startsWith('ppt/')) t = `ppt/${t}`;
        return t;
      }
      return undefined;
    })();
    if (!target) continue;
    const noteText = notesByPart.get(target);
    if (noteText) slides[i] = { ...slide, notes: noteText };
  }

  return {
    slides,
    slideWidth,
    slideHeight,
    media: Object.keys(media).length ? media : undefined,
    masters: masters.length ? masters : undefined,
    layouts: layouts.length ? layouts : undefined,
    fidelity: { level: 'L1', notes },
  };
}

/** 从文件路径读取并解析 pptx（Node / Electron 主进程） */
export async function parsePptxFile(path: string): Promise<JkPresentation> {
  const fs = (await import('node:fs/promises')) as { readFile: (p: string) => Promise<Buffer> };
  const buf = await fs.readFile(path);
  return parsePptx(new Uint8Array(buf));
}
