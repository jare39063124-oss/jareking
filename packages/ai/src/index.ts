/**
 * @jareking/ai — AI 适配层（T4.1 实现）。
 *
 * 设计见 docs/spec.md 7.5：适配器模式 + LLM-as-Planner 输出结构化 ops。
 * 四类服务商：OpenAI 兼容（含 DeepSeek/通义/Kimi/智谱等一切兼容网关）/ Claude / Gemini / Ollama。
 * 统一能力：流式输出、超时控制、指数退避重试、token 计量。
 */
export * from './types.js';
export * from './adapter.js';
