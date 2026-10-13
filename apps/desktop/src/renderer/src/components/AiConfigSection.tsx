/**
 * AI 服务商配置区块（T4.2）——嵌入设置面板。
 *
 * 功能：多配置列表（新增/编辑/删除/启用）/ 表单（服务商类型、名称、BaseURL、
 * Key、模型）/ 测试连接（chat 单轮真实请求）/ 拉取模型列表（listModels 回填下拉）。
 * 明文 Key 仅编辑时输入、保存即加密入主进程；测试时经 IPC resolve 注入适配器。
 */
import { useEffect, useState } from 'react';
import { Pencil, PlugZap, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { AiConfig, AiProviderKind } from '@jareking/core';
import { createAiAdapter } from '@jareking/ai';
import { Button } from './Button';
import { Input } from './Input';
import { Select } from './Select';
import { toast } from '../stores/toastStore';
import { useAiStore } from '../stores/aiStore';

const KIND_OPTIONS: { value: AiProviderKind; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI 兼容（DeepSeek/通义/Kimi/智谱…）' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'ollama', label: 'Ollama（本地）' },
];

/** 各类型默认 BaseURL（可改） */
const DEFAULT_BASE_URL: Record<AiProviderKind, string> = {
  'openai-compatible': 'https://api.deepseek.com/v1',
  claude: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://127.0.0.1:11434',
};

interface FormState {
  id?: string;
  name: string;
  kind: AiProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  models: string[];
}

const emptyForm = (kind: AiProviderKind = 'openai-compatible'): FormState => ({
  name: '',
  kind,
  baseUrl: DEFAULT_BASE_URL[kind],
  model: '',
  apiKey: '',
  models: [],
});

export function AiConfigSection() {
  const configs = useAiStore((s) => s.configs);
  const loaded = useAiStore((s) => s.loaded);
  const load = useAiStore((s) => s.load);
  const save = useAiStore((s) => s.save);
  const remove = useAiStore((s) => s.remove);
  const resolveKey = useAiStore((s) => s.resolveKey);

  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const startCreate = () => {
    setTestResult(null);
    setForm(emptyForm());
  };

  const startEdit = async (c: AiConfig) => {
    setTestResult(null);
    setForm({
      id: c.id,
      name: c.name,
      kind: c.kind,
      baseUrl: c.baseUrl,
      model: c.model,
      apiKey: '',
      models: [],
    });
  };

  const buildAdapter = async () => {
    if (!form) return null;
    const key = form.id
      ? (form.apiKey || (await resolveKey(form.id)))
      : form.apiKey;
    return createAiAdapter(
      {
        id: form.id ?? 'draft',
        name: form.name,
        kind: form.kind,
        baseUrl: form.baseUrl,
        apiKeyRef: '',
        model: form.model,
        enabled: true,
        createdAt: 0,
      },
      key,
    );
  };

  const testConnection = async () => {
    if (!form) return;
    setBusy(true);
    setTestResult(null);
    try {
      const adapter = await buildAdapter();
      if (!adapter) return;
      const res = await adapter.chat([{ role: 'user', content: '回复"连接成功"四个字' }], {
        timeoutMs: 20_000,
        maxRetries: 0,
      });
      setTestResult(`✅ 连接成功：${res.content.slice(0, 40)}（tokens: ${res.usage.totalTokens}）`);
    } catch (err) {
      setTestResult(`❌ 连接失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const fetchModels = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const adapter = await buildAdapter();
      if (!adapter?.listModels) return;
      const models = await adapter.listModels({ timeoutMs: 15_000 });
      setForm({ ...form, models, model: form.model || models[0] || '' });
      toast.success(`拉取到 ${models.length} 个模型`);
    } catch (err) {
      toast.warning(`拉取模型失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) {
      toast.warning('名称 / BaseURL / 模型 为必填项');
      return;
    }
    if (!form.id && !form.apiKey && form.kind !== 'ollama') {
      toast.warning('请填写 API Key');
      return;
    }
    setBusy(true);
    try {
      await save({
        id: form.id,
        name: form.name.trim(),
        kind: form.kind,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        apiKey: form.apiKey || undefined,
        enabled: true,
      });
      toast.success(form.id ? '配置已更新' : '配置已添加');
      setForm(null);
    } catch (err) {
      toast.warning(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <h3 className="text-ui font-medium text-fg">AI 服务商</h3>
          <span className="text-tiny text-muted">
            自带 Key 不扣积分 · Key 经系统加密存储（DPAPI），明文不落盘
          </span>
        </div>
        {!form && (
          <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={startCreate}>
            新增
          </Button>
        )}
      </div>

      {/* 列表 */}
      {!form && (
        <div className="flex flex-col gap-1">
          {configs.length === 0 && (
            <div className="rounded border border-dashed border-border p-3 text-center text-tiny text-muted">
              还没有配置。添加一个服务商即可在编辑器里使用 AI 能力。
            </div>
          )}
          {configs.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between rounded border border-border px-2.5 py-1.5"
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-body text-fg">
                  {c.name}
                  <span className="ml-2 text-tiny text-muted">{c.model}</span>
                </span>
                <span className="truncate text-tiny text-muted">{c.baseUrl}</span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  title="编辑"
                  className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
                  onClick={() => void startEdit(c)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  title="删除"
                  className="rounded p-1 text-muted hover:bg-hover hover:text-red-500"
                  onClick={() => void remove(c.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 表单 */}
      {form && (
        <div className="flex flex-col gap-2 rounded border border-border p-3">
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={form.kind}
              options={KIND_OPTIONS}
              onChange={(v) =>
                setForm({ ...form, kind: v as AiProviderKind, baseUrl: DEFAULT_BASE_URL[v as AiProviderKind] })
              }
            />
          </div>
          <Input
            placeholder="名称（如 DeepSeek 官方）"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            placeholder="BaseURL"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          />
          <Input
            type="password"
            placeholder={form.id ? 'API Key（留空表示不修改）' : 'API Key'}
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
          <div className="flex gap-2">
            {form.models.length > 0 ? (
              <Select
                className="flex-1"
                value={form.model}
                options={[
                  { value: form.model, label: form.model || '选择模型' },
                  ...form.models
                    .filter((m) => m !== form.model)
                    .map((m) => ({ value: m, label: m })),
                ]}
                onChange={(v) => setForm({ ...form, model: v })}
              />
            ) : (
              <Input
                placeholder="模型（如 deepseek-chat / gpt-4o-mini）"
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={13} />}
              disabled={busy}
              onClick={() => void fetchModels()}
            >
              拉取模型
            </Button>
          </div>

          {testResult && (
            <div className="rounded bg-muted-bg px-2 py-1 text-tiny text-fg">{testResult}</div>
          )}

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              icon={<PlugZap size={13} />}
              disabled={busy}
              onClick={() => void testConnection()}
            >
              测试连接
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
                取消
              </Button>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void submit()}>
                保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
