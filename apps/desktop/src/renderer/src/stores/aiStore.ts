/**
 * AI 配置 store（T4.2）：经 IPC 读写主进程加密存储的 AiConfig 列表。
 * 明文 Key 不进 store（resolveKey 按调用注入）。
 */
import { create } from 'zustand';
import type { AiConfig, AiProviderKind } from '@jareking/core';

const IPC = window.jareking.IPC;

export interface AiConfigSaveInput {
  id?: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  enabled?: boolean;
}

interface AiState {
  configs: AiConfig[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (input: AiConfigSaveInput) => Promise<AiConfig>;
  remove: (id: string) => Promise<void>;
  /** 取明文 Key（仅供单次 AI 调用，不缓存） */
  resolveKey: (id: string) => Promise<string>;
}

export const useAiStore = create<AiState>((set, get) => ({
  configs: [],
  loaded: false,

  load: async () => {
    const configs = await window.jareking.invoke<AiConfig[]>(IPC.AI_CONFIG_LIST);
    set({ configs, loaded: true });
  },

  save: async (input) => {
    const saved = await window.jareking.invoke<AiConfig>(IPC.AI_CONFIG_SAVE, input);
    await get().load();
    return saved;
  },

  remove: async (id) => {
    await window.jareking.invoke<boolean>(IPC.AI_CONFIG_DELETE, { id });
    await get().load();
  },

  resolveKey: async (id) =>
    window.jareking.invoke<string>(IPC.AI_KEY_RESOLVE, { id }),
}));
