/**
 * 保真等级（Fidelity Level）语义定义与降级特性模型。
 *
 * 对齐 spec 4.2 / 7.3 的三级保真策略：
 *   L1 文本与结构保真 —— 能读能看，格式可能丢失
 *   L2 常规格式全量读写高保真（v1 目标）—— 常见排版可保真编辑/保存
 *   L3 高级特性（像素级/排版引擎级）—— 复杂特性（OLE/SmartArt/修订…）降级提示
 *
 * 注意：`FidelityLevel` 字面量类型由 `packages/core/contracts/document.ts`
 * （被 DocumentMeta.fidelity 使用）作为单一事实源定义，本文件再导出它以保持
 * 跨包一致，并补充「语义描述常量」与「降级特性类型」。
 */

import type { FidelityLevel } from '@jareking/core';

/** 再导出核心库的保真等级字面量类型（单一事实源，避免两包各定义一份导致类型不兼容） */
export type { FidelityLevel };

/** 单级保真等级的语义描述 */
export interface FidelityMeta {
  /** 等级标识 */
  level: FidelityLevel;
  /** 一句话语义 */
  label: string;
  /** 详细说明（本等级能保什么、缺什么） */
  description: string;
  /** 是否触发「部分内容可能无法完美编辑/保存」提示 */
  degrades: boolean;
}

/**
 * 保真等级语义常量表（UI / 解析器 / 导出器共用，避免魔法字符串）。
 * 解析器在 T1.2 依据实际还原能力回填 JkDocument.fidelity.level。
 */
export const FIDELITY_META: Record<FidelityLevel, FidelityMeta> = {
  L1: {
    level: 'L1',
    label: '文本与结构保真',
    description:
      '保证文字内容与段落/表格等结构可读，复杂排版（样式/编号/图片/页眉页脚）可能丢失或降级。',
    degrades: true,
  },
  L2: {
    level: 'L2',
    label: '常规格式全量读写高保真',
    description:
      '覆盖字体/段落/样式/列表/表格/图片/超链接/分节等常规格式，可保真编辑并回写 docx；个别高级特性仍降级标注。',
    degrades: false,
  },
  L3: {
    level: 'L3',
    label: '高级特性 / 排版引擎级保真',
    description:
      '像素级或排版引擎级还原（SmartArt、OLE、修订痕迹、复杂域、数学公式等），本版本对其中部分特性采用降级提示而非完美还原。',
    degrades: true,
  },
};

/** 降级特性类别 */
export type UnsupportedFeatureKind =
  | 'ole'
  | 'smartart'
  | 'revision'
  | 'contentControl'
  | 'field'
  | 'math'
  | 'chart'
  | 'watermark'
  | 'other';

/** 无法完美还原的特性（如 OLE 对象、SmartArt、修订痕迹），触发 UI 降级提示 */
export interface UnsupportedFeature {
  /** 特性类别 */
  kind: UnsupportedFeatureKind;
  /** 人类可读说明 */
  description: string;
  /** 出现位置（可选，如 "paragraph#12" / "table#3.row1" 便于定位） */
  scope?: string;
  /** 来源格式（可选） */
  source?: 'docx' | 'rtf' | 'html' | 'jare' | (string & {});
}

/** 便捷构造降级特性记录 */
export function unsupportedFeature(
  kind: UnsupportedFeatureKind,
  description: string,
  scope?: string,
  source: UnsupportedFeature['source'] = 'docx',
): UnsupportedFeature {
  return { kind, description, scope, source };
}
