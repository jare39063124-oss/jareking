/**
 * AI 配置服务（T4.2）。
 *
 * 存储：core 数据库 settings KV——
 *   `ai.configs` → AiConfig[] JSON（不含明文 Key）
 *   `ai.key.<configId>` → safeStorage 加密后的 Key（base64；Windows 即 DPAPI）
 * 明文 Key 只在 resolve 时短暂进入内存，随调用注入适配器，不落盘、不进渲染层持久状态。
 */
import { safeStorage } from 'electron';
import type { AiConfig, AiProviderKind, Database } from '@jareking/core';
import { getDb } from './db.js';

const CONFIGS_KEY = 'ai.configs';
const keyStorageKey = (id: string) => `ai.key.${id}`;

/** 配置保存输入（apiKey 可选：编辑时留空表示不修改） */
export interface AiConfigSaveInput {
  id?: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  enabled?: boolean;
}

function readConfigs(db: Database): AiConfig[] {
  const raw = db.getSetting(CONFIGS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as AiConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeConfigs(db: Database, configs: AiConfig[]): void {
  db.setSetting(CONFIGS_KEY, JSON.stringify(configs));
}

export class AiConfigService {
  /** 列出全部配置（不含任何 Key 材料） */
  async list(): Promise<AiConfig[]> {
    const db = await getDb();
    return readConfigs(db);
  }

  /** 新建/更新配置；提供 apiKey 时加密存储 */
  async save(input: AiConfigSaveInput): Promise<AiConfig> {
    const db = await getDb();
    const configs = readConfigs(db);
    const id = input.id ?? `ai-${Date.now().toString(36)}`;
    const existing = configs.find((c) => c.id === id);
    const config: AiConfig = {
      id,
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      apiKeyRef: existing?.apiKeyRef ?? keyStorageKey(id),
      model: input.model,
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    const next = existing
      ? configs.map((c) => (c.id === id ? config : c))
      : [...configs, config];
    writeConfigs(db, next);

    if (input.apiKey !== undefined && input.apiKey !== '') {
      await this.storeKey(id, input.apiKey);
    }
    return config;
  }

  /** 删除配置及其密钥 */
  async remove(id: string): Promise<boolean> {
    const db = await getDb();
    const configs = readConfigs(db);
    const next = configs.filter((c) => c.id !== id);
    const removed = next.length !== configs.length;
    if (removed) writeConfigs(db, next);
    db.setSetting(keyStorageKey(id), '');
    return removed;
  }

  /** 加密存储 Key（safeStorage → base64；Windows 上即 DPAPI） */
  async storeKey(id: string, plaintext: string): Promise<void> {
    const db = await getDb();
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(plaintext);
      db.setSetting(keyStorageKey(id), `enc:${encrypted.toString('base64')}`);
    } else {
      // 兜底：极端环境（如 Linux 无 keyring）；Windows 上 DPAPI 始终可用
      db.setSetting(keyStorageKey(id), `plain:${Buffer.from(plaintext, 'utf8').toString('base64')}`);
    }
  }

  /** 解析明文 Key（仅供单次调用注入适配器，不缓存） */
  async resolveKey(id: string): Promise<string> {
    const db = await getDb();
    const raw = db.getSetting(keyStorageKey(id));
    if (!raw) return '';
    if (raw.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'));
    }
    if (raw.startsWith('plain:')) {
      return Buffer.from(raw.slice(6), 'base64').toString('utf8');
    }
    return '';
  }
}
