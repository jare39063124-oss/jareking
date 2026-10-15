/**
 * styleManager —— Writer 样式管理纯函数（WPS 对齐：样式管理器）。
 *
 * 目标：为「样式管理器 UI」提供**框架无关、可单测**的纯函数，复用 `model/document.ts`
 * 的既有 `StyleSheet` / `StyleDef` 模型（不重复定义类型，遵守单一来源铁律）。
 *
 * 覆盖：
 *  - `groupStyles`：按 styleType 分组并排序，供 UI 左侧列表展示；
 *  - `makeUniqueStyleId`：基于名称 slug + 数字后缀生成不与现有冲突的 styleId；
 *  - `cloneStyleDef`：从现有样式派生「新建样式」骨架（复制属性、清 styleId/名称）；
 *  - `resolveParagraphAttrs`：沿 `basedOn` 链合并出「有效段落属性」（含环引用保护）。
 *
 * 说明：`ParagraphProperties` 与 `RunProperties` **各自都含 `styleId`** 字段，
 * 若拍平为单一对象会发生键冲突，故 `resolveParagraphAttrs` 分返回 `pPr` / `rPr`
 * 两部分（等价于请求签名中 `Partial<...>` 的语义，但更安全）。
 */

import type {
  Font,
  ParagraphProperties,
  RunProperties,
  StyleDef,
  StyleSheet,
} from './model/document.js';

/* =========================================================================
 * 1. 分组展示
 * ========================================================================= */

/** 分组展示顺序：段落 → 字符 → 表格 → 编号（与 WPS 样式列表一致） */
const GROUP_ORDER: StyleDef['styleType'][] = ['paragraph', 'character', 'table', 'numbering'];

/** styleType → 中文分组名 */
const GROUP_LABEL: Record<StyleDef['styleType'], string> = {
  paragraph: '段落样式',
  character: '字符样式',
  table: '表格样式',
  numbering: '编号样式',
};

/**
 * 按 `styleType` 分组并排序（段落/字符/表格/编号），供 UI 展示。
 *
 * - 分组顺序固定为 `GROUP_ORDER`；空分组不输出。
 * - 组内按「显示名」升序（缺失显示名时回退 styleId），使用中文本地化比较。
 * - **不修改**入参 `sheet`：内部按类型新建数组后再排序。
 *
 * @param sheet 样式定义表（可为 undefined，视为空表）
 * @returns 形如 `[{ group: '段落样式', styles: [...] }, ...]` 的数组
 */
export function groupStyles(
  sheet: StyleSheet | undefined,
): { group: string; styles: StyleDef[] }[] {
  const styles = sheet?.styles ?? [];
  // 先按类型归入各自的新数组（保持原顺序，随后再做稳定排序）
  const buckets = new Map<StyleDef['styleType'], StyleDef[]>();
  for (const style of styles) {
    const list = buckets.get(style.styleType);
    if (list) list.push(style);
    else buckets.set(style.styleType, [style]);
  }

  const result: { group: string; styles: StyleDef[] }[] = [];
  for (const type of GROUP_ORDER) {
    const list = buckets.get(type);
    if (!list || list.length === 0) continue;
    const sorted = [...list].sort((a, b) =>
      (a.name ?? a.styleId).localeCompare(b.name ?? b.styleId, 'zh-Hans-CN'),
    );
    result.push({ group: GROUP_LABEL[type], styles: sorted });
  }
  return result;
}

/* =========================================================================
 * 2. 唯一 styleId 生成
 * ========================================================================= */

/**
 * 名称 → styleId 主体（slug）。
 * 去掉首尾空白与标点/空白符，仅保留字母、数字与中日韩汉字；全空则回退 `JkStyle`。
 */
function slugifyStyleId(name: string): string {
  const cleaned = (name ?? '').trim().replace(/[^\p{L}\p{N}]+/gu, '');
  return cleaned || 'JkStyle';
}

/**
 * 生成唯一 styleId：以名称 slug 为主体，冲突时追加递增数字后缀（1、2、3…）。
 *
 * 例：`makeUniqueStyleId('标题', [])` → `'标题'`；
 *     `makeUniqueStyleId('标题', ['标题'])` → `'标题1'`；
 *     `makeUniqueStyleId('标题', ['标题', '标题1'])` → `'标题2'`。
 *
 * @param base 期望名称（可为空/含空白标点）
 * @param existing 现有全部 styleId（用于去重）
 */
export function makeUniqueStyleId(base: string, existing: string[]): string {
  const taken = new Set(existing);
  const slug = slugifyStyleId(base);
  if (!taken.has(slug)) return slug;
  let n = 1;
  while (taken.has(`${slug}${n}`)) n += 1;
  return `${slug}${n}`;
}

/* =========================================================================
 * 3. 派生新建样式骨架
 * ========================================================================= */

/** 浅拷贝字体族对象（避免新建样式与来源共享同一 font 引用） */
function cloneFont(font?: Font): Font | undefined {
  return font ? { ...font } : undefined;
}

/** 浅拷贝字符属性（font 子对象单独拷贝） */
function cloneRunProperties(rPr?: RunProperties): RunProperties | undefined {
  if (!rPr) return undefined;
  return { ...rPr, font: cloneFont(rPr.font) };
}

/**
 * 从现有 `StyleDef` 派生一个「新建样式」骨架：复制基础属性（pPr/rPr/tblPr，
 * 浅拷贝，字体族对象单独拷贝），并**清空 `styleId`**（由调用方用
 * `makeUniqueStyleId` 赋值）与 `name`（由调用方传入）。
 *
 * - `src` 为空（未选中任何来源）时返回仅含类型/名称的空骨架；
 * - 派生结果不继承 `basedOn`（属性已内联复制，避免双重合并）；
 * - `isDefault` 强制置 false（新样式不可能成为文档默认样式）。
 *
 * @param src 来源样式（可选）
 * @param name 新样式显示名
 * @param type 新样式类型
 */
export function cloneStyleDef(
  src: StyleDef | undefined,
  name: string,
  type: StyleDef['styleType'],
): StyleDef {
  return {
    type: 'styleDef',
    // 清空 styleId：由调用方保证唯一（makeUniqueStyleId）
    styleId: '',
    styleType: type,
    name,
    isDefault: false,
    pPr: src?.pPr ? { ...src.pPr } : undefined,
    rPr: cloneRunProperties(src?.rPr),
    tblPr: src?.tblPr ? { ...src.tblPr } : undefined,
  };
}

/* =========================================================================
 * 4. 解析有效段落属性（basedOn 链合并）
 * ========================================================================= */

/**
 * 样式解析结果：有效段落属性（pPr + rPr）与命中的样式链。
 *
 * 分 `pPr` / `rPr` 两部分返回，避免 `ParagraphProperties.styleId` 与
 * `RunProperties.styleId` 同名冲突（见文件头说明）。
 */
export interface ResolvedParagraphAttrs {
  /** 合并后的段落属性（对齐/缩进/行距/大纲级别… 不含样式自身引用） */
  pPr: ParagraphProperties;
  /** 合并后的字符属性（字体/字号/加粗/斜体/颜色… 不含样式自身引用） */
  rPr: RunProperties;
  /** 命中的样式链（从被引用样式到其祖先，便于调试/展示） */
  chain: string[];
}

/** 合并字体族（父级在前、子级覆盖；均为 undefined 时不产生 font 字段） */
function mergeFont(base?: Font, over?: Font): Font | undefined {
  if (!base && !over) return undefined;
  return { ...(base ?? {}), ...(over ?? {}) };
}

/**
 * 解析某个 `styleId` 的「有效段落属性」（沿 `basedOn` 链合并，子样式覆盖父样式）。
 *
 * 合并规则：
 *  - `pPr` / `rPr` 逐层浅合并（`ind` / `spacing` 等子对象整体取上层覆盖值）；
 *  - `rPr.font` 做子对象合并（子样式只覆盖显式声明的字体字段）；
 *  - 合并方向：从**最根祖先**到**叶子样式**，叶子最后覆盖。
 *
 * 环引用保护：遍历 `basedOn` 时用 `visited` 集合去重，遇到环即停止，
 * 不抛错、不死循环（如 A → B → A 时只会各合并一次）。
 *
 * @param sheet 样式定义表（可为 undefined）
 * @param styleId 目标样式 id
 * @returns 有效属性（`styleId` 不存在时返回空 pPr/rPr 与空链）
 */
export function resolveParagraphAttrs(
  sheet: StyleSheet | undefined,
  styleId: string,
): ResolvedParagraphAttrs {
  const styles = sheet?.styles ?? [];
  const byId = new Map<string, StyleDef>();
  for (const s of styles) byId.set(s.styleId, s);

  // 1) 沿 basedOn 向上收集样式链（含环引用保护）
  const chain: string[] = [];
  const visited = new Set<string>();
  const stack: StyleDef[] = [];
  let cursor = byId.get(styleId);
  while (cursor && !visited.has(cursor.styleId)) {
    visited.add(cursor.styleId);
    stack.push(cursor);
    chain.push(cursor.styleId);
    cursor = cursor.basedOn ? byId.get(cursor.basedOn) : undefined;
  }

  // 2) 从根祖先到叶子合并：stack 为 [叶子, …, 根]，故逆序合并
  let pPr: ParagraphProperties = {};
  let rPr: RunProperties = {};
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const def = stack[i];
    if (def.pPr) pPr = { ...pPr, ...def.pPr };
    if (def.rPr) {
      rPr = { ...rPr, ...def.rPr, font: mergeFont(rPr.font, def.rPr.font) };
    }
  }

  // 3) 去掉可能的自身样式引用（pPr/rPr.styleId 属「引用」而非「格式」，不随有效属性下发）
  delete pPr.styleId;
  delete rPr.styleId;

  return { pPr, rPr, chain };
}
