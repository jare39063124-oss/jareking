/**
 * T1.5 docx 导出器入口。
 *
 * 把 `JkDocument` 反向序列化为合法 .docx（ZIP/OOXML 包），闭合
 * 「打开 → 编辑 → 保存」round-trip。所有字段与单位换算精确逆映射
 * `src/parser/docxParser.ts`（见 units.ts / document.ts / parts.ts 注释）。
 *
 * 页眉/页脚（WPS 对齐「W-批2 深度项」）：当节携带 `header`/`footer` 内容但缺少
 * `headerRefs`/`footerRefs` 时，在此统一分配 relId（避免与图片 rId 冲突）、回填引用、
 * 追加 Content_Types Override 与 document.xml.rels 关系，并写出 word/headerN.xml /
 * word/footerN.xml 部件。已存在引用（解析透传）则优先复用其 relId 与目标部件。
 */

import JSZip from 'jszip';

import type { Block, JkDocument } from '../model/document.js';
import { serializeDocumentXml } from './document.js';
import { serializeHeaderPart, serializeFooterPart } from './document.js';
import {
  serializeContentTypes,
  serializeDocumentRels,
  serializeNumbering,
  serializeRootRels,
  serializeSettings,
  serializeStyles,
} from './parts.js';

/** 已分配/已存在的 relId 集合，用于避免与图片等既有关系冲突 */
function existingRelIds(doc: JkDocument): Set<string> {
  const ids = new Set<string>();
  for (const rel of doc.relationships ?? []) ids.add(rel.id);
  return ids;
}

/**
 * 深拷贝 JkDocument（plain data + media 二进制）。
 * 用 JSON 克隆主体结构，再单独克隆 media 的 Uint8Array，避免 structuredClone
 * 在部分 tsconfig（types:[]）环境下类型缺失，也避免丢弃二进制。
 */
function cloneDoc(doc: JkDocument): JkDocument {
  const media: Record<string, Uint8Array> | undefined = doc.media
    ? Object.fromEntries(
        Object.entries(doc.media).map(([k, v]) => [k, new Uint8Array(v)]),
      )
    : undefined;
  const base = JSON.parse(JSON.stringify(doc)) as JkDocument;
  if (media) base.media = media;
  return base;
}

/** 单个页眉/页脚部件的生成计划 */
interface HfPart {
  kind: 'header' | 'footer';
  /** 部件路径（zip 内，如 word/header1.xml） */
  partPath: string;
  /** 关联 relId（与 sectPr 的 r:id 及 rels 中的 Id 一致） */
  relId: string;
  /** 内容块 */
  blocks: Block[];
}

/**
 * 依据各节 header/footer 内容分配 relId 并回填引用，返回需写出的部件清单。
 * 直接修改传入的 `work`（已深拷贝的文档），不污染调用方原始 `doc`。
 */
function allocateHeaderFooter(work: JkDocument): HfPart[] {
  const taken = existingRelIds(work);
  let relSeq = 0;
  const nextRelId = (): string => {
    let id: string;
    do {
      relSeq += 1;
      id = `rIdHf${relSeq}`;
    } while (taken.has(id));
    taken.add(id);
    return id;
  };

  let headerSeq = 0;
  let footerSeq = 0;
  const parts: HfPart[] = [];

  for (const section of work.sections ?? []) {
    // —— 页眉 ——
    if (section.header && section.header.length > 0) {
      const existing = (section.headerRefs ?? []).find((r) => r.refType === 'default');
      if (existing) {
        // 复用既有引用：从 relationships 取 target 规整部件路径
        const rel = (work.relationships ?? []).find((r) => r.id === existing.relId);
        const target = rel?.target ?? `header1.xml`;
        const partPath = target.startsWith('/') ? target.slice(1) : `word/${target}`;
        parts.push({ kind: 'header', partPath, relId: existing.relId, blocks: section.header });
      } else {
        const relId = nextRelId();
        headerSeq += 1;
        const partPath = `word/header${headerSeq}.xml`;
        section.headerRefs = [...(section.headerRefs ?? []), { refType: 'default', relId }];
        work.relationships = [
          ...(work.relationships ?? []),
          { id: relId, type: 'header', target: `header${headerSeq}.xml` },
        ];
        parts.push({ kind: 'header', partPath, relId, blocks: section.header });
      }
    }
    // —— 页脚 ——
    if (section.footer && section.footer.length > 0) {
      const existing = (section.footerRefs ?? []).find((r) => r.refType === 'default');
      if (existing) {
        const rel = (work.relationships ?? []).find((r) => r.id === existing.relId);
        const target = rel?.target ?? `footer1.xml`;
        const partPath = target.startsWith('/') ? target.slice(1) : `word/${target}`;
        parts.push({ kind: 'footer', partPath, relId: existing.relId, blocks: section.footer });
      } else {
        const relId = nextRelId();
        footerSeq += 1;
        const partPath = `word/footer${footerSeq}.xml`;
        section.footerRefs = [...(section.footerRefs ?? []), { refType: 'default', relId }];
        work.relationships = [
          ...(work.relationships ?? []),
          { id: relId, type: 'footer', target: `footer${footerSeq}.xml` },
        ];
        parts.push({ kind: 'footer', partPath, relId, blocks: section.footer });
      }
    }
  }

  return parts;
}

/**
 * 把文档模型导出为 .docx 字节流（Uint8Array）。
 * @param doc JkDocument 文档模型
 */
export async function exportDocx(doc: JkDocument): Promise<Uint8Array> {
  // 深拷贝后分配页眉/页脚 relId（不污染入参）
  const work: JkDocument = cloneDoc(doc);
  const hfParts = allocateHeaderFooter(work);

  const zip = new JSZip();
  zip.file('[Content_Types].xml', serializeContentTypes(work));
  zip.file('_rels/.rels', serializeRootRels());
  zip.file('word/document.xml', serializeDocumentXml(work));
  zip.file('word/styles.xml', serializeStyles(work));
  zip.file('word/numbering.xml', serializeNumbering(work));
  zip.file('word/settings.xml', serializeSettings(work));

  const rels = serializeDocumentRels(work);
  if (rels) zip.file('word/_rels/document.xml.rels', rels);

  // 写入图片二进制：依据 image 类型关系的 target 落到 word/<target>
  const media = work.media ?? {};
  for (const rel of work.relationships ?? []) {
    if (rel.type !== 'image') continue;
    const bytes = media[rel.id];
    if (!bytes) continue;
    const target = rel.target ?? '';
    if (!target) continue;
    const fullPath = target.startsWith('/') ? target.slice(1) : `word/${target}`;
    zip.file(fullPath, bytes);
  }

  // 写出页眉/页脚部件（仅对有内容的节）
  for (const hf of hfParts) {
    const content =
      hf.kind === 'header'
        ? serializeHeaderPart(hf.blocks)
        : serializeFooterPart(hf.blocks);
    zip.file(hf.partPath, content);
  }

  return zip.generateAsync({ type: 'uint8array' });
}

/**
 * 把文档模型导出并写入本地 .docx 文件（Node / Electron 主进程环境）。
 * @param doc JkDocument 文档模型
 * @param path 目标 .docx 路径
 */
export async function exportDocxToFile(doc: JkDocument, path: string): Promise<void> {
  const buf = await exportDocx(doc);
  // 沙箱未安装 @types/node 且 writer 的 tsconfig 设置 types:[]，
  // 这里用动态导入 + as any 绕过类型，避免触碰 parser 的 node-fs.d.ts 声明。
  const fs = (await import('node:fs/promises')) as any;
  await fs.writeFile(path, buf);
}
