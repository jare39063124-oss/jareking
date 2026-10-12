/**
 * 测试夹具：用 JSZip 在运行时构造最小合法 .docx，供 parseDocx 消费。
 *
 * 注意：解析器使用 removeNSPrefix，标签前缀（w:/a:/r:…）会被剥离，
 * 因此这里仍按规范声明命名空间以确保 XML 合法，但实际解析只关心本地名。
 */

import JSZip from 'jszip';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

export interface DocxParts {
  /** <w:body> 内部 XML（块级元素） */
  body: string;
  /** word/_rels/document.xml.rels 内容（可选） */
  rels?: string;
  /** word/styles.xml 内容（可选） */
  styles?: string;
  /** word/numbering.xml 内容（可选） */
  numbering?: string;
  /** word/settings.xml 内容（可选） */
  settings?: string;
}

export function makeDocumentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}">
  <w:body>${body}</w:body>
</w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${REL}">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** 组装一个最小合法的 .docx（返回 Uint8Array） */
export async function buildDocx(parts: DocxParts): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', makeDocumentXml(parts.body));
  if (parts.rels) zip.file('word/_rels/document.xml.rels', parts.rels);
  if (parts.styles) zip.file('word/styles.xml', parts.styles);
  if (parts.numbering) zip.file('word/numbering.xml', parts.numbering);
  if (parts.settings) zip.file('word/settings.xml', parts.settings);
  return zip.generateAsync({ type: 'uint8array' });
}

/* ---------- 常用片段 ---------- */

export const NS = { W, R, REL, WP, A, PIC };

export const DEFAULT_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/><w:qFormat/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:link w:val="Heading1Char"/><w:uiPriority w:val="9"/><w:qFormat/>
  </w:style>
  <w:style w:type="character" w:styleId="Heading1Char">
    <w:name w:val="Heading 1 Char"/><w:basedOn w:val="DefaultParagraphFont"/><w:link w:val="Heading1"/>
  </w:style>
</w:styles>`;

export function hyperlinkRels(target: string, id = 'rId1'): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="${id}" Type="${R}/hyperlink" Target="${target}" TargetMode="External"/>
</Relationships>`;
}

export function imageRels(id = 'rId7', target = 'media/image1.png'): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="${id}" Type="${R}/image" Target="${target}"/>
</Relationships>`;
}

export const DRAWING = (embed = 'rId7') => `
  <w:drawing>
    <wp:inline>
      <wp:extent cx="914400" cy="457200"/>
      <wp:docPr id="1" name="Picture 1" descr="a cat"/>
      <wp:graphic>
        <a:graphicData uri="${PIC}">
          <pic:pic>
            <pic:blipFill><a:blip r:embed="${embed}"/></pic:blipFill>
          </pic:pic>
        </a:graphicData>
      </wp:graphic>
    </wp:inline>
  </w:drawing>`;
