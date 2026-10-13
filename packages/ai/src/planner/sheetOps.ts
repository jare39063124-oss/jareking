/**
 * Sheet ops 协议（T4.5）——自然语言 → 公式/数据写入。
 *
 * v1 ops（坐标用 A1 记法，公式不带 = 前缀，与 @jareking/sheet 契约一致）：
 *   setFormula / setValue / setValues
 * 汇总/洞察类指令由 LLM 在 explanation 中回答（无 op），经 UI 展示。
 */
import { z } from 'zod';
import { extractJsonObject } from './jsonExtract.js';

const A1 = /^\$?[A-Z]{1,3}\$?\d{1,7}$/;

export const SetFormulaOpSchema = z.object({
  op: z.literal('setFormula'),
  /** 目标单元格 A1 记法（如 "B2"） */
  target: z.string().regex(A1, 'target 须为 A1 记法'),
  /** 公式，不带 = 前缀（如 "SUM(B2:B10)"） */
  formula: z.string().min(1),
});

export const SetValueOpSchema = z.object({
  op: z.literal('setValue'),
  target: z.string().regex(A1, 'target 须为 A1 记法'),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const SetValuesOpSchema = z.object({
  op: z.literal('setValues'),
  /** 起始单元格（写入区域左上角） */
  startCell: z.string().regex(A1, 'startCell 须为 A1 记法'),
  /** 二维数组（行列即区域尺寸） */
  values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1)).min(1),
});

export const SheetOpSchema = z.discriminatedUnion('op', [
  SetFormulaOpSchema,
  SetValueOpSchema,
  SetValuesOpSchema,
]);

export type SheetOp = z.infer<typeof SheetOpSchema>;

export const SheetPlanSchema = z.object({
  operations: z.array(z.record(z.string(), z.unknown())),
  explanation: z.string().default(''),
});

/* =========================================================================
 * Prompt
 * ========================================================================= */

const OPS_MANUAL = `可用操作（op 字段必须精确匹配；单元格用 A1 记法如 B2；公式不带等号开头）：
1. {"op":"setFormula","target":"B2","formula":"SUM(B3:B10)"} —— 在目标单元格写公式
2. {"op":"setValue","target":"A1","value":"文本或数字或true/false"} —— 写入单个值
3. {"op":"setValues","startCell":"A1","values":[["行1列1","行1列2"],["行2列1","行2列2"]]} —— 从起始单元格写入二维数据（尺寸须匹配）

规则：坐标必须真实存在于当前表格范围内；只使用以上操作；文字用用户的语言。`;

export function buildSheetPlannerPrompt(
  instruction: string,
  ctx: { name: string; csvSample: string },
): { system: string; user: string } {
  return {
    system: `你是 jareking 表格助手的规划器。用户给出对表格的修改指令或数据问题，你输出要执行的操作序列；如果用户问的是数据问题（不需要修改表格），operations 输出空数组并在 explanation 中给出分析结论。
${OPS_MANUAL}

输出格式：只输出一个 JSON 对象 {"operations":[...],"explanation":"一句话说明"}。
禁止输出 markdown 代码块、注释或 JSON 以外的任何文字。`,
    user: `【当前表格】名称：${ctx.name}\n内容（CSV 节选，行为行、逗号分列）：\n${ctx.csvSample}\n\n【用户指令】\n${instruction}`,
  };
}

/* =========================================================================
 * 解析
 * ========================================================================= */

export interface ParsedSheetPlan {
  operations: SheetOp[];
  explanation: string;
  rejected: { index: number; reason: string }[];
}

export function parseSheetPlan(raw: string): ParsedSheetPlan {
  const obj = extractJsonObject(raw) as { operations?: unknown[]; explanation?: unknown };
  const list = Array.isArray(obj.operations) ? obj.operations : [];
  const operations: SheetOp[] = [];
  const rejected: ParsedSheetPlan['rejected'] = [];
  list.forEach((item, index) => {
    const result = SheetOpSchema.safeParse(item);
    if (result.success) operations.push(result.data);
    else {
      const opName = typeof (item as { op?: unknown })?.op === 'string' ? String((item as { op: unknown }).op) : '未知';
      rejected.push({ index, reason: `op "${opName}" 校验失败: ${result.error.issues[0]?.message ?? '格式错误'}` });
    }
  });
  return {
    operations,
    explanation: typeof obj.explanation === 'string' ? obj.explanation : '',
    rejected,
  };
}
