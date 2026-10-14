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
import { extractJsonObject } from './jsonExtract.js';

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

/* ---- 痛点驱动：文档整理 ops（用户反馈 1：换行空格排版/千分符/格式不统一/表格不匹配） ---- */

/** 一键整理：全文段落格式统一（确定性本地执行，LLM 只选参数） */
export const TidyDocumentOpSchema = z.object({
  op: z.literal('tidyDocument'),
  /** 正文首行缩进（字符数，0=不缩进） */
  firstLineIndent: z.number().min(0).max(4).default(2),
  /** 行距：倍数（1.5）或固定磅值（"28pt"） */
  lineSpacing: z.string().default('1.5'),
  /** 正文对齐 */
  bodyAlign: z.enum(['justify', 'left']).default('justify'),
  /** 正文字号（pt） */
  bodyFontSize: z.number().min(8).max(36).optional(),
  /** 正文字体名 */
  bodyFontFamily: z.string().optional(),
  /** 是否清理连续空段 */
  collapseBlankLines: z.boolean().default(true),
});

/** 套用格式模板（公文/论文/报告…）——模板定义在 templates.ts */
export const ApplyTemplateOpSchema = z.object({
  op: z.literal('applyTemplate'),
  templateId: z.string().min(1),
});

/** 数字千分符（金额/统计数据可读性） */
export const FormatNumbersOpSchema = z.object({
  op: z.literal('formatNumbers'),
  /** 作用范围 */
  scope: z.enum(['all', 'selection']).default('all'),
});

/** 插入图表（AI 识别文中对比数据 → 可视化） */
export const InsertChartOpSchema = z.object({
  op: z.literal('insertChart'),
  chartType: z.enum(['bar', 'line', 'pie']),
  title: z.string().default(''),
  labels: z.array(z.string()).min(1),
  series: z
    .array(
      z.object({
        name: z.string().default(''),
        values: z.array(z.number()).min(1),
      }),
    )
    .min(1),
});

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
  TidyDocumentOpSchema,
  ApplyTemplateOpSchema,
  FormatNumbersOpSchema,
  InsertChartOpSchema,
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
10. {"op":"tidyDocument","firstLineIndent":2,"lineSpacing":"1.5","bodyAlign":"justify","bodyFontSize":12,"bodyFontFamily":"宋体","collapseBlankLines":true} —— 一键整理全文排版（首行缩进/行距/对齐/正文字体字号，清理连续空段）
11. {"op":"applyTemplate","templateId":"gov-doc|thesis|report|business"} —— 套用预设格式模板（政府公文/毕业论文/通用报告/商务报告）
12. {"op":"formatNumbers","scope":"all"} —— 为文中数字添加千分符（金额/统计数据）
13. {"op":"insertChart","chartType":"bar|line|pie","title":"图表标题","labels":["类别1","类别2"],"series":[{"name":"系列名","values":[数值...]}]} —— 插入数据图表

数据敏感度要求：当指令涉及对比、趋势、占比、统计（如"把这段数据做成图表""可视化""更直观"），或文中出现成组的对比数字时，优先提取数据并用 insertChart 生成图表；数据适合表格呈现时用 insertTable。

规则：operations 按执行顺序排列；只使用以上操作；文本用用户的语言。`;

export interface DocContextSummary {
  /** 文档纯文本（调用方截断，建议 ≤2000 字符） */
  text?: string;
  /** 当前选区文本 */
  selection?: string;
  /** 标题列表（outline） */
  headings?: string[];
  /** 对话历史（多轮上下文，T4.7；调用方截取最近几轮） */
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export function buildWriterPlannerPrompt(instruction: string, ctx: DocContextSummary | undefined): {
  system: string;
  user: string;
} {
  const contextLines: string[] = [];
  if (ctx?.headings?.length) contextLines.push(`文档标题：${ctx.headings.join(' / ')}`);
  if (ctx?.text) contextLines.push(`文档内容（节选）：\n${ctx.text}`);
  if (ctx?.selection) contextLines.push(`当前选区：「${ctx.selection}」`);
  if (ctx?.history?.length) {
    const histLines = ctx.history
      .slice(-6)
      .map((h) => `${h.role === 'user' ? '用户' : '助手'}：${h.content.slice(0, 200)}`)
      .join('\n');
    contextLines.push(`对话历史（用于理解"再/接着/第二段"等指代，最新在后）：\n${histLines}`);
  }
  if (!contextLines.length) contextLines.push('（空文档）');

  return {
    system: `你是 jareking 文档助手的规划器。用户给出对文档的修改指令，你输出要执行的操作序列。
${OPS_MANUAL}

多轮对话：若提供了对话历史，结合它理解当前指令中的指代与省略（如"再润色一遍""第二段也这样"）。

输出格式：只输出一个 JSON 对象 {"operations":[...],"explanation":"一句话说明你做了什么"}。
禁止输出 markdown 代码块、注释或 JSON 以外的任何文字。`,
    user: `【文档上下文】\n${contextLines.join('\n')}\n\n【用户指令】\n${instruction}`,
  };
}

/* =========================================================================
 * LLM 输出容错解析
 * ========================================================================= */

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
