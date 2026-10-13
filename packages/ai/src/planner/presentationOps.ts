/**
 * Presentation ops 协议（T4.6）——大纲 → 成稿。
 *
 * 高层 op：addSlide（标题 + 要点列表）——Executor 负责排版成文本形状。
 * v1 聚焦「一键生成 PPT」主链路；细粒度形状级 ops 随编辑器能力扩展。
 */
import { z } from 'zod';
import { extractJsonObject } from './jsonExtract.js';

export const AddSlideOpSchema = z.object({
  op: z.literal('addSlide'),
  /** 幻灯片标题 */
  title: z.string().min(1),
  /** 要点列表（每条一段，自动加项目符号与层级） */
  bullets: z.array(z.string()).max(12).default([]),
});

export const PresentationOpSchema = z.discriminatedUnion('op', [AddSlideOpSchema]);

export type PresentationOp = z.infer<typeof PresentationOpSchema>;

export const PresentationPlanSchema = z.object({
  operations: z.array(z.record(z.string(), z.unknown())),
  explanation: z.string().default(''),
});

export function buildPresentationPlannerPrompt(instruction: string, ctx: {
  slideCount: number;
  outline: string;
}): { system: string; user: string } {
  return {
    system: `你是 jareking 演示文稿助手的规划器。根据用户的主题或大纲生成幻灯片序列。
可用操作：
1. {"op":"addSlide","title":"幻灯片标题","bullets":["要点1","要点2"]} —— 追加一页（要点每条一句，最多 12 条）

规则：结构为「封面页 → 3~6 页内容（每页 3~5 条要点）→ 结尾页」；标题精炼（≤16 字）；
要点具体、不重复；只输出一个 JSON 对象 {"operations":[...],"explanation":"一句话说明"}，
禁止 markdown 代码块或任何其他文字。`,
    user: `【当前演示文稿】共 ${ctx.slideCount} 页\n已有大纲/主题：\n${ctx.outline}\n\n【用户指令】\n${instruction}`,
  };
}

export interface ParsedPresentationPlan {
  operations: PresentationOp[];
  explanation: string;
  rejected: { index: number; reason: string }[];
}

export function parsePresentationPlan(raw: string): ParsedPresentationPlan {
  const obj = extractJsonObject(raw) as { operations?: unknown[]; explanation?: unknown };
  const list = Array.isArray(obj.operations) ? obj.operations : [];
  const operations: PresentationOp[] = [];
  const rejected: ParsedPresentationPlan['rejected'] = [];
  list.forEach((item, index) => {
    const result = PresentationOpSchema.safeParse(item);
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
