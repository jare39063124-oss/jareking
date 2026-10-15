/**
 * T3.4 pptx 导出器：JkPresentation → 最小合法 pptx（ZIP/OOXML 包）。
 *
 * 与解析器（parser/pptxParser.ts）互逆：
 * EMU 原值回写、字号 pt → sz 百分之一磅、旋转度 → rot ×60000、
 * 颜色 #RRGGBB → srgbClr、图片字节经图片签名嗅探扩展名写入 ppt/media/*。
 * 表格经 p:graphicFrame → a:tbl 写回原生表格（WPS/PowerPoint 可直接打开编辑）。
 *
 * 母版/版式/主题（Bug1/Bug2 修复）：
 *   - 当 JkPresentation **未携带** masters/layouts（如「新建演示」的默认模型）时，
 *     导出器**合成最小但完全合法的默认骨架**（theme / slideMaster / slideLayout +
 *     对应关系 + content-types + 每页 slideLayout 关系），保证**任何**演示文稿
 *     都能导出被 WPS/PowerPoint 正常打开的 pptx；
 *   - 当携带 masters/layouts 时走既有路径，但同样补全 OOXML 要求的结构
 *     （母版含 <p:sldLayoutIdLst> 与 txStyles、母版 rels 同时含 theme 与 slideLayout）。
 * 动画/主题细节 v1 不生成（保真报告记录降级）。
 */
import JSZip from 'jszip';
import type {
  JkAutoShape,
  JkPresentation,
  JkShape,
  JkSlideLayout,
  JkSlideMaster,
  JkTableCell,
  JkTableShape,
  JkTextShape,
  TextParagraph,
  TextRun,
} from '../model/index.js';

const escapeXmlText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeXmlAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** OOXML 关系命名空间根（拼接各关系 Type 后缀） */
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 字节签名 → 扩展名（PNG/JPEG/GIF/BMP/WEBP） */
function sniffImageExt(bytes: Uint8Array): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  if (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  if (
    bytes.length > 12 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return 'webp';
  return 'png';
}

/* =========================================================================
 * 文字序列化
 * ========================================================================= */

function serializeRun(r: TextRun): string {
  const attrs: string[] = [`lang="zh-CN"`];
  if (r.fontSize !== undefined) attrs.push(`sz="${Math.round(r.fontSize * 100)}"`);
  if (r.bold) attrs.push(`b="1"`);
  if (r.italic) attrs.push(`i="1"`);
  if (r.underline) attrs.push(`u="sng"`);
  const inner: string[] = [];
  if (r.color) {
    inner.push(`<a:solidFill><a:srgbClr val="${escapeXmlAttr(r.color.replace(/^#/, ''))}"/></a:solidFill>`);
  }
  if (r.fontFamily) inner.push(`<a:latin typeface="${escapeXmlAttr(r.fontFamily)}"/>`);
  const rPr = `<a:rPr ${attrs.join(' ')}>${inner.join('')}</a:rPr>`;
  return `<a:r>${rPr}<a:t>${escapeXmlText(r.text)}</a:t></a:r>`;
}

function serializeParagraph(p: TextParagraph): string {
  const pPrAttrs: string[] = [];
  if (p.align) {
    const map = { left: 'l', center: 'ctr', right: 'r', justify: 'just' } as const;
    pPrAttrs.push(`algn="${map[p.align]}"`);
  }
  if (p.level !== undefined) pPrAttrs.push(`lvl="${p.level}"`);
  const pPr = pPrAttrs.length || p.bullet
    ? `<a:pPr ${pPrAttrs.join(' ')}>${p.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : ''}</a:pPr>`
    : '';
  const runs = p.runs.map(serializeRun).join('');
  return `<a:p>${pPr}${runs}</a:p>`;
}

function serializeTxBody(paragraphs: TextParagraph[] | undefined): string {
  const ps = paragraphs?.length ? paragraphs.map(serializeParagraph).join('') : '<a:p/>';
  return `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${ps}</p:txBody>`;
}

/* =========================================================================
 * 形状序列化
 * ========================================================================= */

/**
 * 形状公共头：p:nvSpPr(cNvPr) + p:spPr(a:xfrm)。
 *
 * 当 hrefRid 存在（该形状带外部超链接）时，在 p:cNvPr 内写 <a:hlinkClick r:id="rIdX"/>，
 * rIdX 指向本页 rels 中的 hyperlink 关系（由 exportPptx 统一分配，避免与图片等冲突）。
 */
function shapeHeader(s: JkShape, id: number, hrefRid?: string): string {
  const rot = s.rotation !== undefined ? ` rot="${Math.round(s.rotation * 60000)}"` : '';
  const nameAttr = `id="${id}" name="${escapeXmlAttr(s.name ?? `Shape ${id}`)}"`;
  const cNvPr = hrefRid
    ? `<p:cNvPr ${nameAttr}><a:hlinkClick r:id="${escapeXmlAttr(hrefRid)}"/></p:cNvPr>`
    : `<p:cNvPr ${nameAttr}/>`;
  return (
    `<p:nvSpPr>${cNvPr}` +
    `<p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm${rot}><a:off x="${Math.round(s.x)}" y="${Math.round(s.y)}"/>` +
    `<a:ext cx="${Math.round(s.w)}" cy="${Math.round(s.h)}"/></a:xfrm>`
  );
}

function serializeTextShape(s: JkTextShape, id: number, hrefRid?: string): string {
  const geom = s.geom ?? 'rect';
  return (
    `<p:sp>${shapeHeader(s, id, hrefRid)}` +
    `<a:prstGeom prst="${escapeXmlAttr(geom)}"><a:avLst/></a:prstGeom></p:spPr>` +
    serializeTxBody(s.paragraphs) +
    `</p:sp>`
  );
}

function serializeAutoShape(s: JkAutoShape, id: number, hrefRid?: string): string {
  const fill = s.fill
    ? `<a:solidFill><a:srgbClr val="${escapeXmlAttr(s.fill.replace(/^#/, ''))}"/></a:solidFill>`
    : '';
  return (
    `<p:sp>${shapeHeader(s, id, hrefRid)}` +
    `<a:prstGeom prst="${escapeXmlAttr(s.geom)}"><a:avLst/></a:prstGeom>${fill}</p:spPr>` +
    (s.paragraphs?.length ? serializeTxBody(s.paragraphs) : '') +
    `</p:sp>`
  );
}

/* =========================================================================
 * 表格序列化（p:graphicFrame → a:graphicData → a:tbl）
 * ========================================================================= */

/** 默认表样式 id（Office 内置「中浅色样式 2 - 强调 1」，WPS/PowerPoint 均识别） */
const DEFAULT_TABLE_STYLE_ID = '{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}';
/** 单元格默认边框色（浅灰蓝，贴合 WPS 默认表格观感） */
const TABLE_BORDER_COLOR = 'D0D7E5';
/** 边框线宽（EMU，12700 ≈ 1pt） */
const TABLE_BORDER_W = 12700;
/** 单行缺省高（EMU，≈0.4 英寸），用于未显式给出尺寸的兜底 */
const DEFAULT_ROW_H = 370840;

/** 单元格四边实线边框（lnL/lnR/lnT/lnB），保证 WPS/PowerPoint 渲染出网格线 */
function serializeTableCellBorders(): string {
  const side = (tag: 'lnL' | 'lnR' | 'lnT' | 'lnB') =>
    `<a:${tag} w="${TABLE_BORDER_W}" cap="flat" cmpd="sng" algn="ctr">` +
    `<a:solidFill><a:srgbClr val="${TABLE_BORDER_COLOR}"/></a:solidFill></a:${tag}>`;
  return side('lnL') + side('lnR') + side('lnT') + side('lnB');
}

/** 单元格 → a:tc（txBody + tcPr）；文本内 \n 拆分为多个 a:p */
function serializeTableCell(cell: JkTableCell): string {
  const lines = (cell.text ?? '').split('\n');
  const alignAttr =
    cell.align === 'center' ? ' algn="ctr"' : cell.align === 'right' ? ' algn="r"' : '';
  const rPrAttrs: string[] = ['lang="zh-CN"'];
  if (cell.fontSize !== undefined) rPrAttrs.push(`sz="${Math.round(cell.fontSize * 100)}"`);
  if (cell.bold) rPrAttrs.push('b="1"');
  const fill = cell.color
    ? `<a:solidFill><a:srgbClr val="${escapeXmlAttr(cell.color.replace(/^#/, ''))}"/></a:solidFill>`
    : '';
  const rPr = `<a:rPr ${rPrAttrs.join(' ')}>${fill}</a:rPr>`;
  const ps = lines
    .map(
      (line) =>
        `<a:p>${alignAttr ? `<a:pPr${alignAttr}/>` : ''}` +
        `<a:r>${rPr}<a:t>${escapeXmlText(line)}</a:t></a:r></a:p>`,
    )
    .join('');
  const txBody = `<a:txBody><a:bodyPr/><a:lstStyle/>${ps}</a:txBody>`;
  return `<a:tc>${txBody}<a:tcPr>${serializeTableCellBorders()}</a:tcPr></a:tc>`;
}

/**
 * 表格形状 → p:graphicFrame。
 *
 * 结构：nvGraphicFramePr(cNvPr/cNvGraphicFramePr/nvPr) + xfrm + graphic/graphicData[a:tbl]。
 * 列宽由 colWidths 求和得外框宽；行高逐行取 row.height，缺省按 (height|h)/行数 均分，
 * 再兜底 DEFAULT_ROW_H。表格高 = height ?? h ?? 行高之和。
 */
function serializeTableShape(s: JkTableShape, id: number, hrefRid?: string): string {
  const cols = s.colWidths.length ? s.colWidths : [s.w];
  const rows = s.rows.length ? s.rows : [{ cells: [] }];
  const cx = cols.reduce((a, b) => a + b, 0) || s.w;
  const perRow = Math.round((s.height ?? s.h) / Math.max(1, rows.length));
  const rowHeights = rows.map((r) => (r.height ?? (perRow || DEFAULT_ROW_H)));
  const cy = s.height ?? s.h ?? rowHeights.reduce((a, b) => a + b, 0);

  const gridCols = cols.map((w) => `<a:gridCol w="${Math.round(w)}"/>`).join('');
  const trs = rows
    .map(
      (r, i) =>
        `<a:tr h="${Math.round(rowHeights[i])}">${r.cells
          .map(serializeTableCell)
          .join('')}</a:tr>`,
    )
    .join('');
  const tbl =
    `<a:tbl><a:tblPr firstRow="1" bandRow="1">` +
    `<a:tableStyleId>${DEFAULT_TABLE_STYLE_ID}</a:tableStyleId></a:tblPr>` +
    `<a:tblGrid>${gridCols}</a:tblGrid>${trs}</a:tbl>`;

  const rot = s.rotation !== undefined ? ` rot="${Math.round(s.rotation * 60000)}"` : '';
  const cNvPr = hrefRid
    ? `<p:cNvPr id="${id}" name="${escapeXmlAttr(s.name ?? `表格 ${id}`)}"><a:hlinkClick r:id="${escapeXmlAttr(hrefRid)}"/></p:cNvPr>`
    : `<p:cNvPr id="${id}" name="${escapeXmlAttr(s.name ?? `表格 ${id}`)}"/>`;
  return (
    `<p:graphicFrame><p:nvGraphicFramePr>` +
    cNvPr +
    `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm${rot}><a:off x="${Math.round(s.x)}" y="${Math.round(s.y)}"/>` +
    `<a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `${tbl}</a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/* =========================================================================
 * 幻灯片与包
 * ========================================================================= */

interface SlideImage {
  relId: string; // 每页内分配（rId2 起）
  ext: string;
  bytes: Uint8Array;
  modelKey: string; // `${slideIndex}:${shape.relId}`
}

function serializeSlide(
  shapes: JkShape[],
  slideIndex: number,
  images: SlideImage[],
  transition?: 'none' | 'fade' | 'slide',
  /** 形状在 shapes 中的下标 → 超链接关系 id（仅含带 hyperlink 的形状） */
  hlinkByIndex?: Map<number, string>,
  /** 自动换片时间（毫秒，排练计时结果）；合法（有限数且 > 0）时写入 p:transition@advTm */
  advanceAfterMs?: number,
): string {
  let id = 2; // id=1 保留给 spTree 组
  const parts: string[] = [];
  shapes.forEach((s, i) => {
    const hrefRid = hlinkByIndex?.get(i);
    if (s.type === 'text') {
      parts.push(serializeTextShape(s, id++, hrefRid));
    } else if (s.type === 'shape') {
      parts.push(serializeAutoShape(s, id++, hrefRid));
    } else if (s.type === 'table') {
      parts.push(serializeTableShape(s, id++, hrefRid));
    } else if (s.type === 'image') {
      const img = images.find((im) => im.modelKey === `${slideIndex}:${s.relId}`);
      if (!img) return; // 无字节：降级跳过（fidelity 记录由调用方汇总）
      const picId = id++;
      const cNvPr = hrefRid
        ? `<p:cNvPr id="${picId}" name="${escapeXmlAttr(s.name ?? '图片')}"><a:hlinkClick r:id="${escapeXmlAttr(hrefRid)}"/></p:cNvPr>`
        : `<p:cNvPr id="${picId}" name="${escapeXmlAttr(s.name ?? '图片')}"/>`;
      parts.push(
        `<p:pic><p:nvPicPr>${cNvPr}` +
          `<p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
          `<p:blipFill><a:blip r:embed="${escapeXmlAttr(img.relId)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
          `<p:spPr><a:xfrm><a:off x="${Math.round(s.x)}" y="${Math.round(s.y)}"/>` +
          `<a:ext cx="${Math.round(s.w)}" cy="${Math.round(s.h)}"/></a:xfrm>` +
          `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
      );
    }
  });
  // 切换效果子元素（无效果时为空串）
  const effectXml =
    transition === 'fade' ? '<p:fade/>' : transition === 'slide' ? '<p:push dir="u"/>' : '';
  // 自动换片时间属性：先四舍五入取整，仅当取整结果 > 0 才写出——
  // 否则 `0 < advTm < 0.5`（如 0.4）会写出无意义的 advTm="0"（语义为「立即换片」），
  // 此时整页回落到「不输出 p:transition 或仅输出切换效果」。
  const advRoundedMs =
    advanceAfterMs !== undefined && Number.isFinite(advanceAfterMs) ? Math.round(advanceAfterMs) : 0;
  const advTmAttr = advRoundedMs > 0 ? ` advTm="${advRoundedMs}"` : '';
  // 组装 <p:transition>：切换效果与 advTm 合并到同一元素——
  //   · 仅效果：<p:transition><p:fade/></p:transition>
  //   · 仅 advTm：<p:transition advTm="3000"/>
  //   · 两者都有：<p:transition advTm="3000"><p:fade/></p:transition>
  //   · 都没有：不输出（与改造前逐字节一致，保证零回归）
  const transitionXml =
    effectXml && advTmAttr
      ? `<p:transition${advTmAttr}>${effectXml}</p:transition>`
      : effectXml
        ? `<p:transition>${effectXml}</p:transition>`
        : advTmAttr
          ? `<p:transition${advTmAttr}/>`
          : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    ${parts.join('')}
  </p:spTree></p:cSld>
      ${transitionXml}
</p:sld>`;
}

/** 备注页（最小合法 notesSlide 结构，命名空间与 slide 一致） */
function serializeNotesSlide(notes: string): string {
  const paragraphs = notes
    .split('\n')
    .map((line) => `<a:p><a:r><a:t>${escapeXmlText(line)}</a:t></a:r></a:p>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`;
}

/* =========================================================================
 * 母版 / 版式 / 主题序列化（最小但完全合法，支撑 WPS/PowerPoint 打开）
 * ========================================================================= */

/** 合成骨架用默认主题名（与 Office 默认主题一致） */
const DEFAULT_THEME_NAME = 'Office Theme';
/** 合成默认母版 / 版式的部件名 */
const DEFAULT_MASTER_PART = 'ppt/slideMasters/slideMaster1.xml';
const DEFAULT_LAYOUT_PART = 'ppt/slideLayouts/slideLayout1.xml';
/** p:sldMasterId / p:sldLayoutId 起始 id（沿用 Office 约定） */
const SLD_MASTER_ID_BASE = 2147483648;
const SLD_LAYOUT_ID_BASE = 2147483649;

/** 从部件名提取序号（slideLayout1.xml → 1；缺省回退 fallback） */
function partNum(partName: string | undefined, fallback: number): number {
  const m = partName ? /(\d+)\.xml$/.exec(partName) : null;
  return m ? Number(m[1]) : fallback;
}

/**
 * 主题部件（完整最小合法 a:theme，WPS/PowerPoint 可直接读取）。
 *
 * 严格校验（ECMA-376）要求 clrScheme 的 12 个色槽、fontScheme 的 major/minor 字体
 * （含 a:latin）、fmtScheme 的四组样式列表（fillStyleLst / lnStyleLst /
 * effectStyleLst / bgFillStyleLst，各 ≥3 项）齐备，缺项会被拒绝加载，
 * 故此处内置一份标准 Office 主题结构（仅主题名可按需覆盖）。
 */
function serializeTheme(themeName: string): string {
  const name = escapeXmlAttr(themeName || DEFAULT_THEME_NAME);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}">
  <a:themeElements>
    <a:clrScheme name="${name}">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="${name}">
      <a:majorFont>
        <a:latin typeface="Calibri Light" panose="020F0302020204030204"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri" panose="020F0502020204030204"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="${name}">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:gradFill rotWithShape="1">
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs>
            <a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs>
            <a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs>
          </a:gsLst>
          <a:lin ang="5400000" scaled="0"/>
        </a:gradFill>
        <a:gradFill rotWithShape="1">
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs>
            <a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs>
            <a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs>
          </a:gsLst>
          <a:lin ang="5400000" scaled="0"/>
        </a:gradFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>
        <a:gradFill rotWithShape="1">
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs>
            <a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs>
            <a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs>
          </a:gsLst>
          <a:lin ang="5400000" scaled="0"/>
        </a:gradFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;
}

/** 生成九级段落属性（保证 txStyles 各风格非空，符合严格校验） */
function serializeStyleLevels(marLStep: number, indent: number): string {
  let out = '';
  for (let i = 0; i < 9; i++) {
    out += `<a:lvl${i + 1}pPr marL="${marLStep * i}" indent="${indent}"/>`;
  }
  return out;
}

/**
 * 幻灯片母版部件（最小合法 p:sldMaster）。
 *
 * 关键（Bug2 修复）：依次写出 <p:cSld>（含空 spTree）、<p:clrMap>、
 * <p:sldLayoutIdLst>（关联本母版所辖版式）与 <p:txStyles>（title/body/otherStyle
 * 各含 9 级段落属性）。缺 sldLayoutIdLst 或 txStyles 会被 WPS/PowerPoint
 * 的严格校验判定为损坏 → 打不开/要求修复。
 *
 * @param layoutRels 本母版所辖版式的（关系 id，布局 id）列表，与母版 rels 一一对应
 */
function serializeSlideMaster(
  master: JkSlideMaster,
  layoutRels: { rid: string; layoutId: number }[],
): string {
  const name = escapeXmlAttr(master.name ?? DEFAULT_THEME_NAME);
  const bg = master.bgColor
    ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${escapeXmlAttr(
        master.bgColor.replace(/^#/, ''),
      )}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    : '';
  const layoutIdLst = layoutRels
    .map((r) => `<p:sldLayoutId id="${r.layoutId}" r:id="${escapeXmlAttr(r.rid)}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld name="${name}">
    ${bg}
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    </p:spTree>
  </p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst>${layoutIdLst}</p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle>${serializeStyleLevels(0, 0)}</p:titleStyle>
    <p:bodyStyle>${serializeStyleLevels(342900, -342900)}</p:bodyStyle>
    <p:otherStyle>${serializeStyleLevels(0, 0)}</p:otherStyle>
  </p:txStyles>
</p:sldMaster>`;
}

/** 由占位符推断 p:sldLayout@type（ST_SlideLayoutType 枚举；无占位符 → blank） */
function layoutTypeOf(layout: JkSlideLayout): string {
  const ph = layout.placeholders ?? [];
  const hasTitle = ph.some((t) => t === 'title' || t === 'ctrTitle');
  const hasBody = ph.some((t) => t === 'body' || t === 'subTitle' || t === 'obj');
  if (hasTitle && hasBody) return 'obj';
  if (hasTitle) return 'titleOnly';
  return 'blank';
}

/** 版式部件（最小合法 p:sldLayout；type 按占位符推断，无则 blank） */
function serializeSlideLayout(layout: JkSlideLayout): string {
  const name = escapeXmlAttr(layout.name ?? 'Layout');
  const type = layoutTypeOf(layout);
  const phs = (layout.placeholders ?? [])
    .map(
      (t, i) =>
        `<p:sp><p:nvSpPr>` +
        `<p:cNvPr id="${i + 2}" name="${escapeXmlAttr(t)} Placeholder ${i + 1}"/>` +
        `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
        `<p:nvPr><p:ph type="${escapeXmlAttr(t)}" idx="${i + 1}"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" type="${type}" preserve="1">
  <p:cSld name="${name}"><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    ${phs}
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

/* =========================================================================
 * 母版 / 版式骨架规划（解析归属关系，缺失时合成默认项）
 * ========================================================================= */

/** 规划后的版式（含序号与所属母版序号） */
interface PlannedLayout {
  idx: number;
  layout: JkSlideLayout;
  masterIdx: number;
}

/** 规划后的母版（含主题部件、所辖版式的关系 id 与布局 id） */
interface PlannedMaster {
  idx: number;
  master: JkSlideMaster;
  themeName: string;
  /** 本母版所辖版式（关系 id rId2 起；layoutId 全局唯一） */
  layoutRels: { layoutIdx: number; rid: string; layoutId: number }[];
  /** presentation.xml.rels 中指向本母版的关系 id（稍后分配） */
  presRid: string;
}

/**
 * 规整母版 / 版式骨架：去重、缺失时合成默认项、解析归属、保证母版均有版式。
 *
 * 返回：处理后的 masters / layouts、版式序号索引、规划结果（母版/版式）。
 * 该函数是「任何 JkPresentation 都能导出被 WPS/Office 打开的 pptx」的核心保障。
 */
function planSkeleton(pres: JkPresentation): {
  plannedMasters: PlannedMaster[];
  plannedLayouts: PlannedLayout[];
  layoutIdxByPart: Map<string, number>;
} {
  // 输入母版 / 版式（过滤空项）；按 partName 去重、保留出现顺序
  const masters: JkSlideMaster[] = [];
  const seenMaster = new Set<string>();
  for (const m of pres.masters ?? []) {
    if (!m || !m.partName || seenMaster.has(m.partName)) continue;
    seenMaster.add(m.partName);
    masters.push(m);
  }
  const layouts: JkSlideLayout[] = [];
  const seenLayout = new Set<string>();
  for (const l of pres.layouts ?? []) {
    if (!l || !l.partName || seenLayout.has(l.partName)) continue;
    seenLayout.add(l.partName);
    layouts.push(l);
  }

  // 母版缺失 → 合成默认母版（保证 sldMasterIdLst 非空）
  if (masters.length === 0) {
    masters.push({
      partName: DEFAULT_MASTER_PART,
      name: DEFAULT_THEME_NAME,
      themeName: DEFAULT_THEME_NAME,
    });
  }
  const masterIdxByPart = new Map<string, number>();
  masters.forEach((m, i) => masterIdxByPart.set(m.partName, partNum(m.partName, i + 1)));

  // 版式缺失 → 合成默认空白版式（归属第一个母版）
  if (layouts.length === 0) {
    layouts.push({
      partName: DEFAULT_LAYOUT_PART,
      name: 'Blank',
      masterPartName: masters[0].partName,
    });
  }
  // 版式序号：保留原始序号（缺省按出现顺序）；按 partName 去重
  let layoutSeq = 0;
  const layoutIdxByPart = new Map<string, number>();
  for (const l of layouts) {
    if (layoutIdxByPart.has(l.partName)) continue;
    layoutIdxByPart.set(l.partName, partNum(l.partName, ++layoutSeq));
  }

  // 版式 → 母版：显式 masterPartName 命中则用之，否则归第一个母版
  const firstMasterIdx = masterIdxByPart.get(masters[0].partName)!;
  const plannedLayouts: PlannedLayout[] = [];
  for (const [partName, idx] of layoutIdxByPart) {
    const layout = layouts.find((x) => x.partName === partName)!;
    const explicit = layout.masterPartName ? masterIdxByPart.get(layout.masterPartName) : undefined;
    plannedLayouts.push({ idx, layout, masterIdx: explicit ?? firstMasterIdx });
  }

  // 保证每个母版至少有一个版式（OOXML 要求 p:sldLayoutIdLst 非空）：
  // 为无归属版式的母版合成一个空白版式
  const covered = new Set(plannedLayouts.map((p) => p.masterIdx));
  let nextLayoutIdx =
    Math.max(0, ...plannedLayouts.map((p) => p.idx), ...masterIdxByPart.values()) + 1;
  for (const [partName, masterIdx] of masterIdxByPart) {
    if (covered.has(masterIdx)) continue;
    const partNameNew = `ppt/slideLayouts/slideLayout${nextLayoutIdx}.xml`;
    const idx = nextLayoutIdx++;
    const layout: JkSlideLayout = { partName: partNameNew, name: 'Blank', masterPartName: partName };
    layoutIdxByPart.set(partNameNew, idx);
    plannedLayouts.push({ idx, layout, masterIdx });
    covered.add(masterIdx);
  }
  plannedLayouts.sort((a, b) => a.idx - b.idx);

  // 母版规划：主题名（缺省用默认）、所辖版式的关系 id 与布局 id
  const plannedMasters: PlannedMaster[] = [];
  let layoutIdSeq = SLD_LAYOUT_ID_BASE;
  for (const [partName, idx] of masterIdxByPart) {
    const master = masters.find((m) => m.partName === partName)!;
    let ridSeq = 2; // rId1 固定给 theme
    const layoutRels = plannedLayouts
      .filter((lp) => lp.masterIdx === idx)
      .map((lp) => ({ layoutIdx: lp.idx, rid: `rId${ridSeq++}`, layoutId: layoutIdSeq++ }));
    plannedMasters.push({
      idx,
      master,
      themeName: master.themeName ?? DEFAULT_THEME_NAME,
      layoutRels,
      presRid: '',
    });
  }

  return { plannedMasters, plannedLayouts, layoutIdxByPart };
}

/** JkPresentation → pptx 字节流 */
export async function exportPptx(pres: JkPresentation): Promise<Uint8Array> {
  const zip = new JSZip();
  const slides = pres.slides ?? [];
  const media = pres.media ?? {};

  // 备注页：仅含非空备注的页生成关联
  const notesIdxWithText = slides
    .map((s, i) => ({ notes: (s.notes ?? '').trim(), i }))
    .filter((x) => x.notes.length > 0)
    .map((x) => x.i);
  // presentation 级 rId 序号：slide 已占用 rId1..rIdN，备注从 N+1 起递增
  let presRidSeq = slides.length;
  const notesPresRid: Record<number, number> = {};
  for (const idx of notesIdxWithText) {
    presRidSeq++;
    notesPresRid[idx] = presRidSeq;
  }

  // 母版 / 版式骨架：缺失时合成最小合法默认骨架（Bug1/Bug2 修复）
  const { plannedMasters, plannedLayouts, layoutIdxByPart } = planSkeleton(pres);
  // presentation → slideMaster 关系（rId 续在备注之后）
  for (const pm of plannedMasters) {
    presRidSeq++;
    pm.presRid = `rId${presRidSeq}`;
  }
  // 每页实际使用的版式序号：slide.layout 命中已规划版式则用之，否则回退到首个版式
  const fallbackLayoutIdx = plannedLayouts[0].idx;
  const slideLayoutIdxOf = (layoutPart: string | undefined): number => {
    const idx = layoutPart ? layoutIdxByPart.get(layoutPart) : undefined;
    return idx ?? fallbackLayoutIdx;
  };

  // [Content_Types].xml
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>` +
      `<Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>` +
      `<Default Extension="bmp" ContentType="image/bmp"/><Default Extension="webp" ContentType="image/webp"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      slides
        .map(
          (_, i) =>
            `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
        )
        .join('') +
      notesIdxWithText
        .map(
          (i) =>
            `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
        )
        .join('') +
      plannedMasters
        .map(
          ({ idx }) =>
            `<Override PartName="/ppt/slideMasters/slideMaster${idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
        )
        .join('') +
      plannedLayouts
        .map(
          ({ idx }) =>
            `<Override PartName="/ppt/slideLayouts/slideLayout${idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
        )
        .join('') +
      plannedMasters
        .map(
          ({ idx }) =>
            `<Override PartName="/ppt/theme/theme${idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
        )
        .join('') +
      `</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );

  // presentation.xml：先 <p:sldMasterIdLst>（母版必存在），再 <p:sldIdLst>，
  // 最后 <p:sldSz>/<p:notesSz>（顺序须符合 CT_Presentation 的 sequence）。
  // 0 页时省略 <p:sldIdLst>（sldIdLst 若出现则 sldId 至少 1 项）。
  const slideRids = slides.map((_, i) => `rId${i + 1}`);
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<p:sldMasterIdLst>${plannedMasters
        .map((pm, mi) => `<p:sldMasterId id="${SLD_MASTER_ID_BASE + mi}" r:id="${pm.presRid}"/>`)
        .join('')}</p:sldMasterIdLst>` +
      (slides.length
        ? `<p:sldIdLst>${slides
            .map((_, i) => `<p:sldId id="${256 + i}" r:id="${slideRids[i]}"/>`)
            .join('')}</p:sldIdLst>`
        : '') +
      `<p:sldSz cx="${Math.round(pres.slideWidth)}" cy="${Math.round(pres.slideHeight)}"/>` +
      `<p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );

  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      slideRids
        .map(
          (rid, i) =>
            `<Relationship Id="${rid}" Type="${REL_NS}/slide" Target="slides/slide${i + 1}.xml"/>`,
        )
        .join('') +
      notesIdxWithText
        .map(
          (i) =>
            `<Relationship Id="rId${notesPresRid[i]}" Type="${REL_NS}/notesSlide" Target="notesSlides/notesSlide${i + 1}.xml"/>`,
        )
        .join('') +
      plannedMasters
        .map(
          (pm) =>
            `<Relationship Id="${pm.presRid}" Type="${REL_NS}/slideMaster" Target="slideMasters/slideMaster${pm.idx}.xml"/>`,
        )
        .join('') +
      `</Relationships>`,
  );

  // 母版部件 + 主题部件 + 母版 rels（theme + 所辖版式）
  for (const pm of plannedMasters) {
    zip.file(`ppt/slideMasters/slideMaster${pm.idx}.xml`, serializeSlideMaster(pm.master, pm.layoutRels));
    zip.file(`ppt/theme/theme${pm.idx}.xml`, serializeTheme(pm.themeName));
    const rels: string[] = [
      `<Relationship Id="rId1" Type="${REL_NS}/theme" Target="../theme/theme${pm.idx}.xml"/>`,
      ...pm.layoutRels.map(
        (lr) =>
          `<Relationship Id="${lr.rid}" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout${lr.layoutIdx}.xml"/>`,
      ),
    ];
    zip.file(
      `ppt/slideMasters/_rels/slideMaster${pm.idx}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
    );
  }

  // 版式部件 + 版式 rels（均指向所属母版）
  for (const lp of plannedLayouts) {
    zip.file(`ppt/slideLayouts/slideLayout${lp.idx}.xml`, serializeSlideLayout(lp.layout));
    zip.file(
      `ppt/slideLayouts/_rels/slideLayout${lp.idx}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="../slideMasters/slideMaster${lp.masterIdx}.xml"/></Relationships>`,
    );
  }

  // 每页：slide XML + 图片收集 + 每页 rels + 备注页
  let mediaSeq = 0;
  slides.forEach((slide, i) => {
    const notesText = (slide.notes ?? '').trim();
    // 收集本页图片（按 shape 顺序分配 rId，从 rId2 起）
    const images: SlideImage[] = [];
    for (const s of slide.shapes ?? []) {
      if (s.type !== 'image') continue;
      const modelKey = `${i}:${s.relId}`;
      const bytes = media[modelKey];
      if (!bytes) continue;
      const existing = images.find((im) => im.modelKey === modelKey);
      if (existing) continue;
      images.push({ relId: `rId${images.length + 2}`, ext: sniffImageExt(bytes), bytes, modelKey });
    }

    // 收集本页对象超链接（按 shape 顺序分配 rId，续在图片之后，从 rId(images.length+2) 起）
    const hlinkByIndex = new Map<number, string>();
    const hyperlinks: { shapeIndex: number; relId: string; url: string }[] = [];
    (slide.shapes ?? []).forEach((s, si) => {
      if (!s.hyperlink) return;
      const relId = `rId${images.length + 2 + hyperlinks.length}`;
      hlinkByIndex.set(si, relId);
      hyperlinks.push({ shapeIndex: si, relId, url: s.hyperlink });
    });

    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      serializeSlide(slide.shapes ?? [], i, images, slide.transition, hlinkByIndex, slide.advanceAfterMs),
    );

    // 汇总本页 rels 关系（图片 + 超链接 + 备注 + 版式）
    const rels: string[] = [];
    for (const im of images) {
      rels.push(
        `<Relationship Id="${im.relId}" Type="${REL_NS}/image" Target="../media/image${++mediaSeq}.${im.ext}"/>`,
      );
    }
    // 对象超链接关系：仅外部 URL，TargetMode="External"；每条 hyperlink 一个关系
    for (const h of hyperlinks) {
      rels.push(
        `<Relationship Id="${h.relId}" Type="${REL_NS}/hyperlink" Target="${escapeXmlAttr(h.url)}" TargetMode="External"/>`,
      );
    }
    // 图片已用 rId2…rId(1+images.length)，超链接续用 rId(images.length+2)…，
    // 备注 / 版式关系再依次递增，保证本页 rId 全局唯一、互不冲突
    let relSeq = images.length + 2 + hyperlinks.length;
    if (notesText) {
      rels.push(
        `<Relationship Id="rId${relSeq++}" Type="${REL_NS}/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`,
      );
    }
    // 版式关联：每页必须且仅关联一个版式（缺失时回退到首个版式）——
    // 缺该关系会导致 WPS/PowerPoint 判定幻灯片损坏
    rels.push(
      `<Relationship Id="rId${relSeq++}" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout${slideLayoutIdxOf(slide.layout)}.xml"/>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        rels.join('') +
        `</Relationships>`,
    );

    // 图片字节（target 序号与 rels 中出现顺序一致）
    let imgNo = mediaSeq - images.length;
    for (const im of images) {
      zip.file(`ppt/media/image${++imgNo}.${im.ext}`, im.bytes);
    }

    // 备注页 XML + 空关系（notesSlide 不引用 notesMaster，v1 自包含即可）
    if (notesText) {
      zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`, serializeNotesSlide(notesText));
      zip.file(
        `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
      );
    }
  });

  return zip.generateAsync({ type: 'uint8array' });
}

/** 导出并写入本地 .pptx 文件（Node / Electron 主进程） */
export async function exportPptxToFile(pres: JkPresentation, path: string): Promise<void> {
  const buf = await exportPptx(pres);
  const fs = (await import('node:fs/promises')) as unknown as {
    writeFile: (p: string, d: Uint8Array) => Promise<void>;
  };
  await fs.writeFile(path, buf);
}
