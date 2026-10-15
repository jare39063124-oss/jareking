/**
 * AI 算力计量 store：封装「算力用量」汇总与流水列表的 IPC 读取。
 *
 * 通道名取自 preload 暴露的 `window.jareking.IPC`（单一来源 `src/ipc/channels.ts`），
 * 与主进程 handler 严格一致；类型复用 core 契约（@jareking/core，只 import type，无运行时依赖）。
 */
import { create } from 'zustand';
import type { AiMeteringSummary, AiUsageRecord } from '@jareking/core';

const IPC = window.jareking.IPC;

/** 空汇总（未加载 / 无用量时的占位） */
const EMPTY_SUMMARY: AiMeteringSummary = {
  totalCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  totalPoints: 0,
};

/** 「最近记录」默认展示条数 */
export const AI_METER_RECENT_LIMIT = 20;

interface AiMeteringState {
  /** 汇总（总调用数 / 总 token / 总积分） */
  summary: AiMeteringSummary;
  /** 最近用量流水（倒序） */
  records: AiUsageRecord[];
  /** 是否加载中 */
  loading: boolean;
  /** 是否已完成首次加载 */
  loaded: boolean;
  /** 拉取汇总 */
  loadSummary: () => Promise<void>;
  /** 拉取最近用量流水（默认 20 条） */
  loadRecords: (limit?: number) => Promise<void>;
}

export const useAiMeteringStore = create<AiMeteringState>((set) => ({
  summary: EMPTY_SUMMARY,
  records: [],
  loading: false,
  loaded: false,

  loadSummary: async () => {
    const summary = await window.jareking.invoke<AiMeteringSummary>(IPC.AI_METER_SUMMARY);
    set({ summary });
  },

  loadRecords: async (limit = AI_METER_RECENT_LIMIT) => {
    set({ loading: true });
    try {
      const records = await window.jareking.invoke<AiUsageRecord[]>(IPC.AI_METER_RECORDS, {
        limit,
      });
      set({ records, loaded: true });
    } finally {
      set({ loading: false });
    }
  },
}));
