/**
 * T1.5 docx 导出器入口。
 *
 * 把 `JkDocument` 反向序列化为合法 .docx（ZIP/OOXML 包），闭合
 * 「打开 → 编辑 → 保存」round-trip。所有字段与单位换算精确逆映射
 * `src/parser/docxParser.ts`（见 units.ts / document.ts / parts.ts 注释）。
 */

import JSZip from 'jszip';

import type { JkDocument } from '../model/document.js';
import { serializeDocumentXml } from './document.js';
import {
  serializeContentTypes,
  serializeDocumentRels,
  serializeNumbering,
  serializeRootRels,
  serializeSettings,
  serializeStyles,
} from './parts.js';

/**
 * 把文档模型导出为 .docx 字节流（Uint8Array）。
 * @param doc JkDocument 文档模型
 */
export async function exportDocx(doc: JkDocument): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', serializeContentTypes(doc));
  zip.file('_rels/.rels', serializeRootRels());
  zip.file('word/document.xml', serializeDocumentXml(doc));
  zip.file('word/styles.xml', serializeStyles(doc));
  zip.file('word/numbering.xml', serializeNumbering(doc));
  zip.file('word/settings.xml', serializeSettings(doc));

  const rels = serializeDocumentRels(doc);
  if (rels) zip.file('word/_rels/document.xml.rels', rels);

  // 写入图片二进制：依据 image 类型关系的 target 落到 word/<target>
  const media = doc.media ?? {};
  for (const rel of doc.relationships ?? []) {
    if (rel.type !== 'image') continue;
    const bytes = media[rel.id];
    if (!bytes) continue;
    const target = rel.target ?? '';
    if (!target) continue;
    const fullPath = target.startsWith('/') ? target.slice(1) : `word/${target}`;
    zip.file(fullPath, bytes);
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
