/**
 * T3.4 pptx 导出器：JkPresentation → 最小合法 pptx（ZIP/OOXML 包）。
 *
 * 与解析器（parser/pptxParser.ts）互逆：
 * EMU 原值回写、字号 pt → sz 百分之一磅、旋转度 → rot ×60000、
 * 颜色 #RRGGBB → srgbClr、图片字节经图片签名嗅探扩展名写入 ppt/media/*。
 * 表格经 p:graphicFrame → a:tbl 写回原生表格（WPS/PowerPoint 可直接打开编辑）。
 * 母版/版式：解析到 masters/layouts 时写回最小合法 part + 关系 + content-types，
 * 支持最小模型的 round-trip；动画/主题细节 v1 不生成（保真报告记录降级）。
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

function shapeHeader(s: JkShape, id: number): string {
  const rot = s.rotation !== undefined ? ` rot="${Math.round(s.rotation * 60000)}"` : '';
  return (
    `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXmlAttr(s.name ?? `Shape ${id}`)}"/>` +
    `<p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm${rot}><a:off x="${Math.round(s.x)}" y="${Math.round(s.y)}"/>` +
    `<a:ext cx="${Math.round(s.w)}" cy="${Math.round(s.h)}"/></a:xfrm>`
  );
}

function serializeTextShape(s: JkTextShape, id: number): string {
  const geom = s.geom ?? 'rect';
  return (
    `<p:sp>${shapeHeader(s, id)}` +
    `<a:prstGeom prst="${escapeXmlAttr(geom)}"><a:avLst/></a:prstGeom></p:spPr>` +
    serializeTxBody(s.paragraphs) +
    `</p:sp>`
  );
}

function serializeAutoShape(s: JkAutoShape, id: number): string {
  const fill = s.fill
    ? `<a:solidFill><a:srgbClr val="${escapeXmlAttr(s.fill.replace(/^#/, ''))}"/></a:solidFill>`
    : '';
  return (
    `<p:sp>${shapeHeader(s, id)}` +
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
function serializeTableShape(s: JkTableShape, id: number): string {
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
  return (
    `<p:graphicFrame><p:nvGraphicFramePr>` +
    `<p:cNvPr id="${id}" name="${escapeXmlAttr(s.name ?? `表格 ${id}`)}"/>` +
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
): string {
  let id = 2; // id=1 保留给 spTree 组
  const parts: string[] = [];
  for (const s of shapes) {
    if (s.type === 'text') {
      parts.push(serializeTextShape(s, id++));
    } else if (s.type === 'shape') {
      parts.push(serializeAutoShape(s, id++));
    } else if (s.type === 'table') {
      parts.push(serializeTableShape(s, id++));
    } else if (s.type === 'image') {
      const img = images.find((im) => im.modelKey === `${slideIndex}:${s.relId}`);
      if (!img) continue; // 无字节：降级跳过（fidelity 记录由调用方汇总）
      parts.push(
        `<p:pic><p:nvPicPr><p:cNvPr id="${id++}" name="${escapeXmlAttr(s.name ?? '图片')}"/>` +
          `<p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
          `<p:blipFill><a:blip r:embed="${escapeXmlAttr(img.relId)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
          `<p:spPr><a:xfrm><a:off x="${Math.round(s.x)}" y="${Math.round(s.y)}"/>` +
          `<a:ext cx="${Math.round(s.w)}" cy="${Math.round(s.h)}"/></a:xfrm>` +
          `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
      );
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    ${parts.join('')}
  </p:spTree></p:cSld>
      ${transition === 'fade' ? '<p:transition><p:fade/></p:transition>' : transition === 'slide' ? '<p:transition><p:push dir="u"/></p:transition>' : ''}
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
 * 母版 / 版式 / 主题序列化（最小合法部件，支撑最小模型 round-trip）
 * ========================================================================= */

/** 从部件名提取序号（slideLayout1.xml → 1；缺省回退 fallback） */
function partNum(partName: string | undefined, fallback: number): number {
  const m = partName ? /(\d+)\.xml$/.exec(partName) : null;
  return m ? Number(m[1]) : fallback;
}

/** 主题部件（最小合法 a:theme；仅用于承载主题名，供解析回读） */
function serializeTheme(themeName: string): string {
  const name = escapeXmlAttr(themeName);
  // 配色/字体/格式方案各给最小占位，WPS/PowerPoint 可读取名称与配色
  const schemeClr = (tag: string, val: string) => `<a:${tag}><a:srgbClr val="${val}"/></a:${tag}>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}">
  <a:themeElements>
    <a:clrScheme name="${name}">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      ${schemeClr('dk2', '44546A')}${schemeClr('lt2', 'E7E6E6')}
      ${schemeClr('accent1', '4472C4')}${schemeClr('accent2', 'ED7D31')}${schemeClr('accent3', 'A5A5A5')}
      ${schemeClr('accent4', 'FFC000')}${schemeClr('accent5', '5B9BD5')}${schemeClr('accent6', '70AD47')}
      ${schemeClr('hlink', '0563C1')}${schemeClr('folHlink', '954F72')}
    </a:clrScheme>
    <a:fontScheme name="${name}">
      <a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="${name}">
      <a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst>
      <a:lnStyleLst>${'<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3)}</a:lnStyleLst>
      <a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>
      <a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;
}

/** 幻灯片母版部件（最小合法 p:sldMaster；承载名称与背景色） */
function serializeSlideMaster(master: JkSlideMaster): string {
  const name = escapeXmlAttr(master.name ?? 'Office Theme');
  const bg = master.bgColor
    ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${escapeXmlAttr(
        master.bgColor.replace(/^#/, ''),
      )}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    : '';
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
</p:sldMaster>`;
}

/** 版式部件（最小合法 p:sldLayout；承载名称与占位符类型） */
function serializeSlideLayout(layout: JkSlideLayout): string {
  const name = escapeXmlAttr(layout.name ?? 'Layout');
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
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:cSld name="${name}"><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
    ${phs}
  </p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
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

  // 母版 / 版式：仅当存在时写回最小部件（支撑最小模型 round-trip）
  const masters = pres.masters ?? [];
  const layouts = pres.layouts ?? [];
  // partName → 部件序号（保留原始序号，缺省按出现顺序），去重
  const masterIdxByPart = new Map<string, number>();
  masters.forEach((m, i) => {
    if (!masterIdxByPart.has(m.partName)) masterIdxByPart.set(m.partName, partNum(m.partName, i + 1));
  });
  const layoutIdxByPart = new Map<string, number>();
  layouts.forEach((l, i) => {
    if (!layoutIdxByPart.has(l.partName)) layoutIdxByPart.set(l.partName, partNum(l.partName, i + 1));
  });
  const masterParts = [...masterIdxByPart.entries()].map(([partName, idx]) => ({
    idx,
    master: masters.find((x) => x.partName === partName)!,
  }));
  const layoutParts = [...layoutIdxByPart.entries()].map(([partName, idx]) => ({
    idx,
    layout: layouts.find((x) => x.partName === partName)!,
  }));
  // presentation → slideMaster 关系（rId 续在备注之后）
  const masterPresRel = masterParts.map(({ idx }) => {
    presRidSeq++;
    return { idx, rid: `rId${presRidSeq}` };
  });

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
      masterParts
        .map(
          ({ idx }) =>
            `<Override PartName="/ppt/slideMasters/slideMaster${idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
        )
        .join('') +
      layoutParts
        .map(
          ({ idx }) =>
            `<Override PartName="/ppt/slideLayouts/slideLayout${idx}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
        )
        .join('') +
      masterParts
        .filter(({ master }) => master.themeName)
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

  // presentation.xml（每页一个 rId；rId1 起）
  const slideRids = slides.map((_, i) => `rId${i + 1}`);
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      (masterPresRel.length
        ? `<p:sldMasterIdLst>${masterPresRel
            .map(({ idx, rid }) => `<p:sldMasterId id="${2147483648 + idx}" r:id="${rid}"/>`)
            .join('')}</p:sldMasterIdLst>`
        : '') +
      `<p:sldIdLst>${slides
        .map((_, i) => `<p:sldId id="${256 + i}" r:id="${slideRids[i]}"/>`)
        .join('')}</p:sldIdLst>` +
      (notesIdxWithText.length
        ? `<p:notesSldIdLst>${notesIdxWithText
            .map((i) => `<p:notesSldId id="${512 + i}" r:id="rId${notesPresRid[i]}"/>`)
            .join('')}</p:notesSldIdLst>`
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
            `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
        )
        .join('') +
      notesIdxWithText
        .map(
          (i) =>
            `<Relationship Id="rId${notesPresRid[i]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="notesSlides/notesSlide${i + 1}.xml"/>`,
        )
        .join('') +
      masterPresRel
        .map(
          ({ idx, rid }) =>
            `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster${idx}.xml"/>`,
        )
        .join('') +
      `</Relationships>`,
  );

  // 母版部件 + 主题部件 + 母版 rels（指向主题）
  for (const { idx, master } of masterParts) {
    zip.file(`ppt/slideMasters/slideMaster${idx}.xml`, serializeSlideMaster(master));
    if (master.themeName) {
      zip.file(`ppt/theme/theme${idx}.xml`, serializeTheme(master.themeName));
      zip.file(
        `ppt/slideMasters/_rels/slideMaster${idx}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme${idx}.xml"/></Relationships>`,
      );
    }
  }

  // 版式部件 + 版式 rels（指向所属母版）
  for (const { idx, layout } of layoutParts) {
    zip.file(`ppt/slideLayouts/slideLayout${idx}.xml`, serializeSlideLayout(layout));
    const masterIdx = layout.masterPartName
      ? masterIdxByPart.get(layout.masterPartName)
      : undefined;
    if (masterIdx !== undefined) {
      zip.file(
        `ppt/slideLayouts/_rels/slideLayout${idx}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster${masterIdx}.xml"/></Relationships>`,
      );
    }
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

    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      serializeSlide(slide.shapes ?? [], i, images, slide.transition),
    );

    // 汇总本页 rels 关系（图片 + 备注 + 版式）
    const rels: string[] = [];
    for (const im of images) {
      rels.push(
        `<Relationship Id="${im.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${++mediaSeq}.${im.ext}"/>`,
      );
    }
    // 图片已用 rId2…rId(1+images.length)，后续关系从 rId(images.length+2) 起递增
    let relSeq = images.length + 2;
    if (notesText) {
      rels.push(
        `<Relationship Id="rId${relSeq++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>`,
      );
    }
    // 版式关联：仅当本页 layout 指向已写出的版式部件
    const slideLayoutIdx = slide.layout ? layoutIdxByPart.get(slide.layout) : undefined;
    if (slideLayoutIdx !== undefined) {
      rels.push(
        `<Relationship Id="rId${relSeq++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${slideLayoutIdx}.xml"/>`,
      );
    }
    if (rels.length) {
      zip.file(
        `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          rels.join('') +
          `</Relationships>`,
      );
    }

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
