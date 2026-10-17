/**
 * Office → PDF 门面（**平台分发唯一入口**）。
 *
 * 上层（`main/index.ts` 的 IPC 处理器）只 import 本文件，不感知具体平台：
 *  - win32  → `officeConvertWin.ts`（PowerShell + WPS/Office COM）
 *  - darwin → `officeConvertMac.ts`（LibreOffice headless，需本机安装）
 *  - linux  → 复用 LibreOffice 路径（v1 未正式交付，行为一致便于将来接入）
 *
 * 平台判定来源：`platform/index.ts`（唯一 `process.platform` 出现处）。
 */
import type { OfficeKind } from '../../shared/officePdfScript.js';
import { isWindows } from './index.js';
import { convertOfficeToPdfMac, isOfficePdfAvailable as macOfficePdfAvailable } from './officeConvertMac.js';
import { convertOfficeToPdfWin } from './officeConvertWin.js';

/**
 * 把 Word/Excel/PPT 文档转换为 PDF。
 *
 * 分发规则只有一条分界线：**Windows 走 COM，其余（macOS / Linux）走 LibreOffice headless**。
 * Linux 与 macOS 引擎相同（都是 soffice），因此不需要第三个实现；v1 未交付 Linux 属产品范围问题，
 * 不是技术分支问题。
 *
 * @param kind       文档大类（word / excel / ppt）
 * @param inputPath  输入文档绝对路径
 * @param outputPath 目标 PDF 路径（缺省则与输入同目录、同文件名换 .pdf）
 * @returns 转换后的 PDF 绝对路径
 */
export async function convertOfficeToPdf(
  kind: OfficeKind,
  inputPath: string,
  outputPath?: string,
): Promise<{ outputPath: string }> {
  return isWindows
    ? convertOfficeToPdfWin(kind, inputPath, outputPath)
    : convertOfficeToPdfMac(kind, inputPath, outputPath);
}

/**
 * 「Office 转 PDF」在本机是否可用（用于诊断面板 / 未来 UI 降级提示）。
 *
 * - Windows：取决于本机是否装 WPS/Office（COM 无法低成本探测，一律视为可用，
 *   失败时由转换调用给出明确错误）；
 * - macOS / Linux：取决于是否安装 LibreOffice（可精确探测）。
 */
export function isOfficePdfAvailable(): boolean {
  return isWindows ? true : macOfficePdfAvailable();
}

export type { OfficeKind };
