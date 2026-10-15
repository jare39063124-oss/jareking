/**
 * 宏管理区块（嵌入「设置」面板）——列出 / 新建 / 编辑 / 删除 / 运行用户 JavaScript 宏。
 *
 * 执行模型：宏代码在独立 Web Worker 沙箱中运行（见 `lib/macroRunner.ts`）；
 * 本组件只负责列表、代码编辑（Modal + textarea）与运行结果展示。
 *
 * 硬约束：严禁 `window.prompt` / `alert` / `confirm`——一律使用项目 `Modal`。
 */
import { useEffect, useState } from 'react';
import { Code2, Eraser, Pencil, Play, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';
import { toast } from '../stores/toastStore';
import { useMacroStore } from '../stores/macroStore';
import { SAMPLE_MACRO, validateMacroCode, JK_API_METHODS } from '../lib/macroApi';
import { runMacro } from '../lib/macroRunner';
import { getMacroHost } from '../lib/macroHost';
import type { MacroLogEntry, MacroRunResult } from '../lib/macroProtocol';

/** 编辑态（Modal 内的表单） */
interface EditState {
  isNew: boolean;
  name: string;
  code: string;
}

/** 待确认动作（运行 / 删除） */
interface PendingAction {
  kind: 'run' | 'delete';
  name: string;
  code?: string;
}

/** 最近一次运行摘要 */
interface RunSummary {
  name: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

/** 时间戳格式化 */
function formatTime(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : '—';
}

/** 日志级别 → 文本色 */
function levelClass(level: string): string {
  if (level === 'error') return 'text-red-500';
  if (level === 'warn') return 'text-amber-500';
  if (level === 'info') return 'text-accent';
  return 'text-fg';
}

export function MacroSection() {
  const macros = useMacroStore((s) => s.macros);
  const loaded = useMacroStore((s) => s.loaded);
  const load = useMacroStore((s) => s.load);
  const read = useMacroStore((s) => s.read);
  const saveMacro = useMacroStore((s) => s.save);
  const removeMacro = useMacroStore((s) => s.remove);

  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<MacroLogEntry[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  /* ----------------------- 列表操作 ----------------------- */

  const startCreate = () => {
    setEditing({ isNew: true, name: '', code: SAMPLE_MACRO });
  };

  const startEdit = async (name: string) => {
    try {
      const code = await read(name);
      setEditing({ isNew: false, name, code });
    } catch (err) {
      toast.warning(`读取宏失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const requestRun = async (name: string) => {
    try {
      const code = await read(name);
      if (!validateMacroCode(code).ok) {
        toast.warning('该宏代码为空，无法运行');
        return;
      }
      setPending({ kind: 'run', name, code });
    } catch (err) {
      toast.warning(`读取宏失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const requestDelete = (name: string) => setPending({ kind: 'delete', name });

  /* ----------------------- 保存 ----------------------- */

  const submitEdit = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      toast.warning('请填写宏名');
      return;
    }
    const codeCheck = validateMacroCode(editing.code);
    if (!codeCheck.ok) {
      toast.warning(codeCheck.reason ?? '宏代码无效');
      return;
    }
    setSaving(true);
    try {
      await saveMacro(name, editing.code);
      toast.success(editing.isNew ? '宏已创建' : '宏已保存');
      setEditing(null);
    } catch (err) {
      toast.warning(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  /* ----------------------- 运行 / 删除确认 ----------------------- */

  const doRun = async (name: string, code: string) => {
    setPending(null);
    setRunning(true);
    setLogs([]);
    setSummary(null);
    try {
      const res: MacroRunResult = await runMacro(code, {
        host: getMacroHost(),
        onLog: (entry) => setLogs((prev) => [...prev, entry]),
      });
      setLogs(res.logs);
      setSummary({ name, ok: res.ok, error: res.error, durationMs: res.durationMs });
      if (res.ok) toast.success(`宏「${name}」执行完成（${res.durationMs}ms）`);
      else toast.warning(`宏「${name}」执行失败：${res.error ?? '未知错误'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSummary({ name, ok: false, error: message, durationMs: 0 });
      toast.warning(`运行异常：${message}`);
    } finally {
      setRunning(false);
    }
  };

  const doDelete = async (name: string) => {
    setPending(null);
    try {
      const ok = await removeMacro(name);
      toast.success(ok ? '宏已删除' : '宏不存在');
    } catch (err) {
      toast.warning(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const confirmPending = () => {
    if (!pending) return;
    if (pending.kind === 'run' && pending.code !== undefined) {
      void doRun(pending.name, pending.code);
    } else if (pending.kind === 'delete') {
      void doDelete(pending.name);
    }
  };

  /* ----------------------- 渲染 ----------------------- */

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <h3 className="text-ui font-medium text-fg">宏</h3>
          <span className="text-tiny text-muted">
            用 JavaScript 自动化文档操作 · 沙箱执行，仅在你点击「运行」时启动
          </span>
        </div>
        <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={startCreate}>
          新建
        </Button>
      </div>

      {/* 宏列表 */}
      <div className="flex flex-col gap-1">
        {macros.length === 0 && (
          <div className="rounded border border-dashed border-border p-3 text-center text-tiny text-muted">
            还没有宏。点击「新建」编写一段 JavaScript，即可批量处理当前文档。
          </div>
        )}
        {macros.map((m) => (
          <div
            key={m.name}
            className="flex items-center justify-between rounded border border-border px-2.5 py-1.5"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-body text-fg">{m.name}</span>
              <span className="truncate text-tiny text-muted">
                更新于 {formatTime(m.updatedAt)}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                title="运行"
                disabled={running}
                className="rounded p-1 text-muted hover:bg-hover hover:text-accent disabled:opacity-40"
                onClick={() => void requestRun(m.name)}
              >
                <Play size={14} />
              </button>
              <button
                type="button"
                title="编辑"
                className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
                onClick={() => void startEdit(m.name)}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                title="删除"
                className="rounded p-1 text-muted hover:bg-hover hover:text-red-500"
                onClick={() => requestDelete(m.name)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 运行结果 / 日志 */}
      {(running || summary || logs.length > 0) && (
        <div className="flex flex-col gap-1.5 rounded border border-border p-2.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-tiny font-medium text-fg">
              <Code2 size={13} className="text-accent" aria-hidden="true" />
              {running
                ? '运行中…'
                : summary
                  ? `运行结果：${summary.name}（${summary.ok ? '成功' : '失败'} · ${summary.durationMs}ms）`
                  : '输出日志'}
            </span>
            <button
              type="button"
              title="清除输出"
              className="rounded p-1 text-muted hover:bg-hover hover:text-fg"
              onClick={() => {
                setLogs([]);
                setSummary(null);
              }}
            >
              <Eraser size={13} />
            </button>
          </div>

          {summary && !summary.ok && summary.error && (
            <div className="rounded bg-muted-bg px-2 py-1 text-tiny text-red-500">
              {summary.error}
            </div>
          )}

          <div className="max-h-48 overflow-auto rounded bg-muted-bg/50 px-2 py-1 font-mono text-tiny leading-relaxed">
            {logs.length === 0 ? (
              <span className="text-muted">（无日志输出）</span>
            ) : (
              logs.map((entry, index) => (
                <div key={index} className={`whitespace-pre-wrap break-all ${levelClass(entry.level)}`}>
                  {entry.text}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* jk API 参考（可折叠） */}
      <details className="rounded border border-border px-2.5 py-1.5">
        <summary className="cursor-pointer text-tiny text-muted">jk API 一览（点击展开）</summary>
        <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-tiny text-fg">
          {JK_API_METHODS.map((api) => (
            <li key={api} className="break-all">
              {api}
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-tiny text-muted">
          所有 jk 方法均为异步，需 <span className="font-mono">await</span>；宏在沙箱中运行，
          无 DOM / 网络访问，超时 5 秒自动终止。
        </p>
      </details>

      {/* 编辑 Modal */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.isNew ? '新建宏' : '编辑宏'}
        width={640}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Save size={13} />}
              disabled={saving}
              onClick={() => void submitEdit()}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="flex flex-col gap-2">
            <Input
              placeholder="宏名（如：批量替换）"
              value={editing.name}
              disabled={!editing.isNew}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
            <textarea
              className="h-72 w-full resize-y rounded-sm border border-border bg-surface p-2 font-mono text-tiny leading-relaxed text-fg outline-none focus:border-accent"
              spellCheck={false}
              value={editing.code}
              onChange={(e) => setEditing({ ...editing, code: e.target.value })}
            />
            <p className="text-tiny text-muted">
              提示：宏在独立 Worker 沙箱中执行，通过 <span className="font-mono">jk</span> 白名单
              API 操作当前文档；示例见新建时的默认代码。
            </p>
          </div>
        )}
      </Modal>

      {/* 运行 / 删除确认 Modal（替代 window.confirm） */}
      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending?.kind === 'delete' ? '删除宏' : '运行宏'}
        width={420}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button
              variant={pending?.kind === 'delete' ? 'danger' : 'primary'}
              size="sm"
              icon={pending?.kind === 'delete' ? <Trash2 size={13} /> : <Play size={13} />}
              onClick={confirmPending}
            >
              {pending?.kind === 'delete' ? '删除' : '运行'}
            </Button>
          </>
        }
      >
        {pending && (
          <p className="text-body text-fg">
            {pending.kind === 'delete' ? (
              <>
                确定删除宏「<span className="font-medium">{pending.name}</span>」吗？此操作不可撤销。
              </>
            ) : (
              <>
                将运行宏「<span className="font-medium">{pending.name}</span>」，它会修改当前文档。
                确定继续？
              </>
            )}
          </p>
        )}
      </Modal>
    </section>
  );
}
