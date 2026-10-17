/**
 * 平台适配层公共工具（跨平台通用，无平台分支）。
 *
 * 目前只有一处逻辑：把输入文档路径推导为目标 PDF 路径（同目录、同主名、换 .pdf 后缀）。
 * Windows / macOS 两个实现共用，避免两份实现各自漂移（铁律 1.1）。
 */
import { basename, dirname, join } from 'node:path';

/**
 * 把路径的扩展名替换为 .pdf（同目录），如 a/b/c.docx → a/b/c.pdf。
 *
 * 注意：以「最后一个点」为准（`报告.v2.docx` → `报告.v2.pdf`）；
 * 无扩展名的文件（`README`）直接追加 `.pdf`。
 */
export function withPdfExtension(filePath: string): string {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return join(dirname(filePath), `${stem}.pdf`);
}

/**
 * 决定最终输出路径：显式传入且非空则用之，否则按输入路径推导。
 */
export function resolveOutputPath(inputPath: string, outputPath?: string): string {
  return outputPath && outputPath.length > 0 ? outputPath : withPdfExtension(inputPath);
}
