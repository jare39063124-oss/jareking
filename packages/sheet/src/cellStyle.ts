/**
 * 单元格样式规整（WPS 对齐专项——设置单元格格式对话框）。
 *
 * 纯函数，仅依赖 JkCellStyle 数据模型，可独立单测（不触碰 Univer 实例）。
 * 职责：把对话框表单态（含空串 / undefined / 各种色值）清洗成干净的 JkCellStyle，
 * 供渲染层 applyCellStyle 写回 Univer 前使用，避免把「未设置」误写成「设置为某值」。
 */
import type { JkCellStyle } from './model/index.js';

/**
 * 把任意色值折成 #RRGGBB（大写，无 alpha）；非法返回 undefined。
 *
 * 支持形态：
 *  - #RGB / #RRGGBB / #RRGGBBAA（alpha 丢弃）→ #RRGGBB
 *  - rgb(r,g,b) / rgba(r,g,b,a) → #RRGGBB
 *  - { rgb: '#...' }（Univer 部分 API 返回的对象结构）→ 取出内部字符串再折
 *  - 具名色（red/white…）无法可靠折成 #RRGGBB，返回 undefined（不污染）
 *
 * 与 univerAdapter.ts 的 toHex 思路一致，但独立实现、不跨文件耦合，
 * 并额外支持 { rgb } 对象情形。
 */
export function normalizeColor(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;

  // 形如 { rgb: '#...' } 的对象：取出内部 rgb 字符串后再次规整
  if (typeof input === 'object') {
    const rgb = (input as { rgb?: unknown }).rgb;
    if (typeof rgb === 'string') return normalizeColor(rgb);
    return undefined;
  }

  const s = String(input).trim();
  if (!s) return undefined;

  // 十六进制
  if (s.startsWith('#')) {
    const h = s.slice(1).toUpperCase();
    if (/^[0-9A-F]{6}$/.test(h)) return `#${h}`;
    if (/^[0-9A-F]{3}$/.test(h)) {
      // #RGB → #RRGGBB
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    }
    if (/^[0-9A-F]{8}$/.test(h)) return `#${h.slice(0, 6)}`; // 丢弃 alpha
    return undefined;
  }

  // rgb() / rgba()
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) {
    const to2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
    return `#${to2(Number(m[1]))}${to2(Number(m[2]))}${to2(Number(m[3]))}`;
  }

  // 具名色等无法可靠转换
  return undefined;
}

/**
 * 把对话框表单态规整为干净的 JkCellStyle（仅保留有实际意义的字段）。
 *
 * 规整规则：
 *  - 空字符串 / 空白 / 非法色值 → undefined（不写该字段，避免污染）
 *  - 颜色字段（color / bgColor）经 normalizeColor 折成 #RRGGBB，非法则 undefined
 *  - 数字字段（fontSize）非有限数字 → undefined
 *  - borders 全 false / 空 → undefined
 *
 * 返回的 JkCellStyle 仅包含「被勾选 / 被填写」的字段，便于 applyCellStyle
 * 按字段存在性逐属性写回（不写回的字段保持单元格原样）。
 */
export function normalizeCellStyle(input: Partial<JkCellStyle>): JkCellStyle {
  const out: JkCellStyle = {};
  if (!input) return out;

  // 字体色 / 背景填充色
  const color = normalizeColor(input.color);
  if (color) out.color = color;
  const bgColor = normalizeColor(input.bgColor);
  if (bgColor) out.bgColor = bgColor;

  // 字号（仅有限数字保留）
  if (typeof input.fontSize === 'number' && Number.isFinite(input.fontSize)) {
    out.fontSize = input.fontSize;
  }

  // 字体名
  if (typeof input.fontFamily === 'string' && input.fontFamily.trim()) {
    out.fontFamily = input.fontFamily.trim();
  }

  // 布尔样式：仅在为真时保留（false 不写回，避免误清）
  if (input.bold) out.bold = true;
  if (input.italic) out.italic = true;
  if (input.underline) out.underline = true;
  if (input.strike) out.strike = true;
  if (input.wrapText) out.wrapText = true;

  // 对齐（'general' 视为未设置）
  if (typeof input.align === 'string' && input.align.trim() && input.align !== 'general') {
    out.align = input.align as JkCellStyle['align'];
  }
  if (typeof input.valign === 'string' && input.valign.trim()) {
    out.valign = input.valign as JkCellStyle['valign'];
  }

  // 数字格式（常规 / 空 → 不写）
  if (typeof input.numFmt === 'string' && input.numFmt.trim() && input.numFmt.trim() !== 'General') {
    out.numFmt = input.numFmt.trim();
  }

  // 边框：全 false / 空 → undefined；否则仅保留为 true 的边
  const b = input.borders;
  if (b && (b.top || b.right || b.bottom || b.left)) {
    const borders: NonNullable<JkCellStyle['borders']> = {};
    if (b.top) borders.top = true;
    if (b.right) borders.right = true;
    if (b.bottom) borders.bottom = true;
    if (b.left) borders.left = true;
    out.borders = borders;
  }

  return out;
}
