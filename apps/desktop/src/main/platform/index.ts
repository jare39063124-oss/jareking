/**
 * 平台判定与能力汇总（主进程**唯一**的平台分支来源）。
 *
 * 设计原则（对齐 AGENTS.md 铁律 1.1「单一来源」）：
 *  - `process.platform` 只在本文件出现，其余模块一律 import 这里的常量/函数，
 *    杜绝 `if (process.platform === 'win32')` 散落各处导致多平台分支漂移；
 *  - 平台**专有能力**（Office→PDF、应用菜单、文件打开事件）由 `platform/` 目录下的
 *    同名文件提供各平台实现，上层只认门面（如 `platform/officeConvert.ts`）。
 *
 * 当前支持矩阵：
 *  - win32  ：Windows 10/11 x64（主目标，全能力）
 *  - darwin ：macOS x64 / arm64（Office→PDF 走 LibreOffice headless）
 *  - 其它   ：Linux 未纳入 v1 交付范围（构建可跑，Office→PDF 走 LibreOffice 同路径）
 */
import { release, arch } from 'node:os';

/** 是否 macOS */
export const isMac = process.platform === 'darwin';

/** 是否 Windows */
export const isWindows = process.platform === 'win32';

/** 是否 Linux（v1 未正式交付，仅用于能力判定兜底） */
export const isLinux = process.platform === 'linux';

/**
 * 主修饰键名称（仅用于主进程侧日志/错误文案；渲染层文案见 `renderer/src/lib/platform.ts`）。
 * macOS 为 Command（⌘），其余为 Ctrl。
 */
export const primaryModifierName = isMac ? 'Command' : 'Ctrl';

/** 平台可读名（写入错误提示与系统信息面板） */
export function platformDisplayName(): string {
  if (isMac) return 'macOS';
  if (isWindows) return 'Windows';
  return `Linux/${process.platform}`;
}

/** 平台 + 架构 + 内核版本（诊断信息，用于「存储管理」与问题反馈） */
export function platformDetail(): string {
  return `${platformDisplayName()} ${arch()} (${release()})`;
}
