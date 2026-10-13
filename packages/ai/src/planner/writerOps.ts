/**
 * Writer ops 协议（T4.3）——LLM-as-Planner 的结构化操作集。
 *
 * 设计（spec 7.5）：LLM 只产出「计划」（JSON ops），执行由本地 Executor 确定性完成——
 * AI 永远不直接改文档，避免幻觉破坏；每个 op 独立 zod 校验，非法 op 丢弃并记录。
 *
 * v1 ops 集（面向 Writer）：insertText / replaceSelection / setFormat /
 * insertParagraph / insertTable / setColor / clearFormatting /
 * insertHorizontalRule / undo / redo。
 */
import { z } from 'zod';

/* =========================================================================
 * 单个 op 的 schema（op 字段判别）
 * ========================================================================= */

export const InsertTextOpSchema = z.object({
  op: z.literal('insertText'),
  text: z.string().min(1),
});

export const ReplaceSelectionOpSchema = z.object({
  op: z.literal('replaceSelection'),
  text: z.string().min(1),
});

export const SetFormatOpSchema = z.object({
  op: z.literal('setFormat'),
  mark: z.enum(['bold', 'italic', 'underline', 'strike']),
  value: z.boolean(),
});

export const InsertParagraphOpSchema = z.object({
  op: z.literal('insertParagraph'),
  text: z.string(),
  heading: z.number().int().min(1).max(6).optional(),
});

export const InsertTableOpSchema = z.object({
  op: z.literal('insertTable'),
  rows: z.number().int().min(1).max(50),
  cols: z.number().int().min(1).max(10),
  headerRow: z.boolean().optional(),
});

export const SetColorOpSchema = z.object({
  op: z.literal('setColor'),
  color: z.string().regex(/^#?[0-9A-Fa-f]{3,8}$/),
});

export const ClearFormattingOpSchema = z.object({
  op: z.literal('clearFormatting'),
});

export const InsertRuleOpSchema = z.object({
  op: z.literal('insertHorizontalRule'),
});

export const UndoOpSchema = z.object({ op: z.literal('undo') });
export const RedoOpSchema = z.object({ op: z.literal('redo') });

/** Writer op 全集（判别联合） */
export const WriterOpSchema = z.discriminatedUnion('op', [
  InsertTextOpSchema,
  ReplaceSelectionOpSchema,
  SetFormatOpSchema,
  InsertParagraphOpSchema,
  InsertTableOpSchema,
  SetColorOpSchema,
  ClearFormattingOpSchema,
  InsertRuleOpSchema,
  UndoOpSchema,
  RedoOpSchema,
]);

export type WriterOp = z.infer<typeof WriterOpSchema>;

/** 计划整体结构（LLM 输出） */
export const WriterPlanSchema = z.object({
  operations: z.array(z.record(z.string(), z.unknown())),
  explanation: z.string().default(''),
});

/* =========================================================================
 * Prompt 构建
 * ========================================================================= */

/** 给 LLM 的 ops 说明书（与 schema 严格同步） */
const OPS_MANUAL = `可用操作（op 字段必须精确匹配，参数见说明）：
1. {"op":"insertText","text":"要插入的文本"} —— 在光标处插入
2. {"op":"replaceSelection","text":"新文本"} —— 用新文本替换当前选区
3. {"op":"setFormat","mark":"bold|italic|underline|strike","value":true|false} —— 对当前选区设置/取消格式
4. {"op":"insertParagraph","text":"段落文字","heading":1到6可选} —— 插入段落（heading 缺省为普通段落）
5. {"op":"insertTable","rows":行数,"cols":列数,"headerRow":true可选} —— 插入表格
6. {"op":"setColor","color":"#RRGGBB"} —— 对当前选区设置文字颜色
7. {"op":"clearFormatting"} —— 清除选区格式
8. {"op":"insertHorizontalRule"} —— 插入分隔线
9. {"op":"undo"} / {"op":"redo"} —— 撤销/重做

规则：operations 按执行顺序排列；只使用以上操作；文本用用户的语言。`;

export interface DocContextSummary {
  /** 文档纯文本（调用方截断，建议 ≤2000 字符） */
  text?: string;
  /** 当前选区文本 */
  selection?: string;
  /** 标题列表（outline） */
  headings?: string[];
}

export function buildWriterPlannerPrompt(instruction: string, ctx: DocContextSummary | undefined): {
  system: string;
  user: string;
} {
  const contextLines: string[] = [];
  if (ctx?.headings?.length) contextLines.push(`文档标题：${ctx.headings.join(' / ')}`);
  if (ctx?.text) contextLines.push(`文档内容（节选）：\n${ctx.text}`);
  if (ctx?.selection) contextLines.push(`当前选区：「${ctx.selection}」`);
  if (!contextLines.length) contextLines.push('（空文档）');

  return {
    system: `你是 jareking 文档助手的规划器。用户给出对文档的修改指令，你输出要执行的操作序列。
${OPS_MANUAL}

输出格式：只输出一个 JSON 对象 {"operations":[...],"explanation":"一句话说明你做了什么"}。
禁止输出 markdown 代码块、注释或 JSON 以外的任何文字。`,
    user: `【文档上下文】\n${contextLines.join('\n')}\n\n【用户指令】\n${instruction}`,
  };
}

/* =========================================================================
 * LLM 输出容错解析
 * ========================================================================= */

/** 剥掉 ```json 围栏与首尾杂质后取第一个平衡的 JSON 对象 */
function extractJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error('输出中未找到 JSON 对象');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('JSON 对象不完整');
}

export interface ParsedWriterPlan {
  operations: WriterOp[];
  explanation: string;
  /** 被丢弃的非法 op（op 字段 + 原因） */
  rejected: { index: number; reason: string }[];
}

/** 解析并校验 LLM 计划：合法 op 保留，非法 op 丢弃记录 */
export function parseWriterPlan(raw: string): ParsedWriterPlan {
  const obj = extractJsonObject(raw) as { operations?: unknown[]; explanation?: unknown };
  const list = Array.isArray(obj.operations) ? obj.operations : [];
  const operations: WriterOp[] = [];
  const rejected: ParsedWriterPlan['rejected'] = [];
  list.forEach((item, index) => {
    const result = WriterOpSchema.safeParse(item);
    if (result.success) operations.push(result.data);
    else {
      const opName = typeof (item as { op?: unknown })?.op === 'string' ? String((item as { op: string }).op) : '未知';
      rejected.push({ index, reason: `op "${opName}" 校验失败: ${result.error.issues[0]?.message ?? '格式错误'}` });
    }
  });
  return {
    operations,
    explanation: typeof obj.explanation === 'string' ? obj.explanation : '',
    rejected,
  };
}
