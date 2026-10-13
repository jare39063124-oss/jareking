/**
 * AI Planner（T4.3）：把「用户指令 + 文档上下文」经 LLM 编译为结构化 ops 计划。
 *
 * 内部完成 prompt 构建 → LLM 调用 → 容错解析 + zod 校验。
 */
import type { AiPlan } from '@jareking/core';
import type { AiAdapter, ChatMessage } from '../adapter.js';
import {
  buildWriterPlannerPrompt,
  parseWriterPlan,
  type DocContextSummary,
  type ParsedWriterPlan,
  type WriterOp,
} from './writerOps.js';
import {
  buildSheetPlannerPrompt,
  parseSheetPlan,
  type SheetOp,
} from './sheetOps.js';

export type { WriterOp, DocContextSummary, ParsedWriterPlan } from './writerOps.js';
export { parseWriterPlan, buildWriterPlannerPrompt } from './writerOps.js';
export type { SheetOp } from './sheetOps.js';
export { parseSheetPlan, buildSheetPlannerPrompt } from './sheetOps.js';

export type PlannerModule = 'writer' | 'sheet';

export interface AiPlannerDeps {
  adapter: AiAdapter;
}

/** 类型化 Writer 计划 */
export interface WriterPlanned extends AiPlan {
  ops: WriterOp[];
  rejected: ParsedWriterPlan['rejected'];
}

export interface WriterAiPlanner {
  planWriter(instruction: string, ctx?: DocContextSummary): Promise<WriterPlanned>;
}

/** Sheet 上下文：表名 + CSV 节选 */
export interface SheetContext {
  name: string;
  csvSample: string;
}

export interface SheetPlanned extends AiPlan {
  ops: SheetOp[];
  rejected: { index: number; reason: string }[];
}

export interface SheetAiPlanner {
  planSheet(instruction: string, ctx: SheetContext): Promise<SheetPlanned>;
}

/** 创建 Writer Planner（推荐） */
export function createWriterPlanner(deps: AiPlannerDeps): WriterAiPlanner {
  return {
    async planWriter(instruction: string, ctx?: DocContextSummary): Promise<WriterPlanned> {
      const { system, user } = buildWriterPlannerPrompt(instruction, ctx);
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];
      const res = await deps.adapter.chat(messages);
      const parsed = parseWriterPlan(res.content);
      return {
        operations: parsed.operations as AiPlan['operations'],
        explanation: parsed.explanation,
        estimatedPoints: parsed.operations.length,
        ops: parsed.operations,
        rejected: parsed.rejected,
      };
    },
  };
}

/** 创建 Sheet Planner（T4.5） */
export function createSheetPlanner(deps: AiPlannerDeps): SheetAiPlanner {
  return {
    async planSheet(instruction: string, ctx: SheetContext): Promise<SheetPlanned> {
      const { system, user } = buildSheetPlannerPrompt(instruction, ctx);
      const res = await deps.adapter.chat([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]);
      const parsed = parseSheetPlan(res.content);
      return {
        operations: parsed.operations as AiPlan['operations'],
        explanation: parsed.explanation,
        estimatedPoints: parsed.operations.length,
        ops: parsed.operations,
        rejected: parsed.rejected,
      };
    },
  };
}

