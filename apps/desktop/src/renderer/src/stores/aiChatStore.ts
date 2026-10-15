/**
 * AI 会话 store（T4.7 多轮对话 + 历史持久化 + T4.9 可回退挂点）。
 *
 * - 消息列表持久化到 localStorage（jk-ai-chat-v1，重启可续聊）；
 * - 可撤销执行的快照/undo 闭包是内存态（undoFns），不持久化——重启后历史消息
 *   仍可见但撤销不可用（undone 不可用标记），符合「AI 快照不跨会话」预期；
 * - 浮动工具条与 AIPanel 共用：两者产生的执行都写进来，撤销入口统一。
 */
import { create } from 'zustand';

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  ts: number;
  /** 关联的可撤销执行（存在即可渲染「撤销」按钮） */
  runId?: string;
  /** 已撤销标记（展示状态用） */
  undone?: boolean;
}

interface AiChatState {
  messages: AiChatMessage[];
  append: (m: Omit<AiChatMessage, 'id' | 'ts'> & { id?: string; ts?: number }) => string;
  update: (id: string, patch: Partial<Omit<AiChatMessage, 'id'>>) => void;
  clear: () => void;
}

const LS_KEY = 'jk-ai-chat-v1';

function loadPersisted(): AiChatMessage[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as AiChatMessage[];
    if (!Array.isArray(list)) return [];
    // 过滤崩溃/强杀残留的未完成占位（「正在规划操作…」会被 persist，重启后污染 UI 与验收脚本等待条件）
    return list.filter((m) => m && m.content !== '正在规划操作…').slice(-200);
  } catch {
    return [];
  }
}

function persist(messages: AiChatMessage[]): void {
  try {
    // 快照/undo 闭包不序列化；只保留对话文本与撤销状态标记
    const slim = messages.slice(-200).map(({ id, role, content, ts, runId, undone }) => ({
      id,
      role,
      content,
      ts,
      runId,
      undone,
    }));
    localStorage.setItem(LS_KEY, JSON.stringify(slim));
  } catch {
    /* 存储失败不影响聊天 */
  }
}

let seq = 0;
const genId = () => `msg-${Date.now()}-${++seq}`;

/** runId → undo 闭包（内存态；撤销一次后移除） */
const undoFns = new Map<string, () => void>();

export function registerAiUndo(runId: string, undo: () => void): void {
  undoFns.set(runId, undo);
}

/** 执行撤销；返回是否找到未用过的 undo */
export function performAiUndo(runId: string): boolean {
  const fn = undoFns.get(runId);
  if (!fn) return false;
  undoFns.delete(runId);
  try {
    fn();
  } catch {
    return false;
  }
  return true;
}

export const useAiChatStore = create<AiChatState>((set, get) => ({
  messages: loadPersisted(),
  append: (m) => {
    const id = m.id ?? genId();
    const msg: AiChatMessage = { id, ts: m.ts ?? Date.now(), role: m.role, content: m.content, runId: m.runId, undone: m.undone };
    set((s) => {
      const next = [...s.messages, msg];
      persist(next);
      return { messages: next };
    });
    return id;
  },
  update: (id, patch) => {
    set((s) => {
      const next = s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m));
      persist(next);
      return { messages: next };
    });
  },
  clear: () => {
    undoFns.clear();
    set({ messages: [] });
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
  },
}));

/** 取最近几轮对话（供 planner 上下文；排除撤销类状态噪音） */
export function recentAiHistory(max = 6): { role: 'user' | 'assistant'; content: string }[] {
  return useAiChatStore
    .getState()
    .messages.slice(-max)
    .map((m) => ({ role: m.role, content: m.content }));
}
