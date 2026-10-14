/**
 * AI 助手侧边面板（T4.3 接线）。
 *
 * 流程：用户指令 → 取启用的 AI 配置（aiStore + IPC resolveKey）→
 * createWriterPlanner（LLM-as-Planner）→ plan → applyWriterOps 确定性执行。
 * 面板仅展示计划说明与执行结果；文档修改全部经本地 Executor。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Bot, FileUp, Hash, LayoutTemplate, PanelRightClose, Send, Sparkles, Wand2 } from 'lucide-react';
import { createAiAdapter, createWriterPlanner, FORMAT_TEMPLATES } from '@jareking/ai';
import { extractFormatProfile } from '@jareking/writer';
import { IconButton } from './IconButton';
import { Input } from './Input';
import { toast } from '../stores/toastStore';
import { useUiStore } from '../stores/uiStore';
import { useAiStore } from '../stores/aiStore';
import { getActiveEditor } from '../writer/editorRef';
import { applyWriterOps } from '../writer/opsExecutor';

interface ChatItem {
  role: 'user' | 'assistant';
  content: string;
}

/** T4.4 快捷技能（预设指令，走同一条 Planner→Executor 管道） */
const QUICK_SKILLS: { label: string; instruction: string }[] = [
  { label: '润色选区', instruction: '润色当前选区的文字，使其更通顺专业，用 replaceSelection 替换选区' },
  { label: '续写', instruction: '根据文档现有内容，在光标处续写一段自然的后续内容' },
  { label: '翻译为英文', instruction: '把当前选区翻译成英文，用 replaceSelection 替换选区' },
  { label: '总结全文', instruction: '总结整篇文档，在光标处插入一段简短总结' },
  { label: '插入表格', instruction: '在光标处插入一个 3 行 3 列的表格' },
];

/** 排版工具箱（用户反馈 1）——本地确定性执行，不调用 AI、离线可用、即时生效 */
const TIDY_TOOLS: { label: string; title: string; icon: typeof Wand2; op: () => Parameters<typeof applyWriterOps>[1][number] }[] = [
  {
    label: '一键整理',
    title: '统一首行缩进 2 字符、1.5 倍行距、两端对齐、清理连续空段',
    icon: Wand2,
    op: () => ({ op: 'tidyDocument', firstLineIndent: 2, lineSpacing: '1.5', bodyAlign: 'justify', collapseBlankLines: true }),
  },
  {
    label: '千分符',
    title: '为全文数字添加千分符（金额/统计数据可读性）',
    icon: Hash,
    op: () => ({ op: 'formatNumbers', scope: 'all' }),
  },
];

export function AIPanel() {
  const toggleAiPanel = useUiStore((state) => state.toggleAiPanel);
  const aiPanelWidth = useUiStore((state) => state.aiPanelWidth);
  const setAiPanelWidth = useUiStore((state) => state.setAiPanelWidth);
  const configs = useAiStore((s) => s.configs);
  const loaded = useAiStore((s) => s.loaded);
  const loadConfigs = useAiStore((s) => s.load);
  const resolveKey = useAiStore((s) => s.resolveKey);

  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const referenceInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) void loadConfigs();
  }, [loaded, loadConfigs]);

  /** 排版工具（本地执行，无需 AI） */
  const runTidy = (op: Parameters<typeof applyWriterOps>[1][number]) => {
    const editor = getActiveEditor();
    if (!editor) {
      toast.warning('请先打开一个文字文档');
      return;
    }
    const result = applyWriterOps(editor, [op]);
    if (result.applied.length) toast.success('排版已应用（可 Ctrl+Z 撤销）');
    else toast.warning(result.skipped[0]?.reason ?? '无需整理');
  };

  /** 参考文档格式：选一份 .docx → 提取格式档案 → 套用到当前文档 */
  const runReferenceFormat = async (file: File) => {
    const editor = getActiveEditor();
    if (!editor) {
      toast.warning('请先打开一个文字文档');
      return;
    }
    const profile = await extractFormatProfile(new Uint8Array(await file.arrayBuffer()));
    if (!profile) {
      toast.warning('无法读取参考文档的格式（请确认是 .docx 文件）');
      return;
    }
    const result = applyWriterOps(editor, [
      {
        op: 'tidyDocument',
        firstLineIndent: profile.firstLineIndent ?? 2,
        lineSpacing: profile.lineSpacing ?? '1.5',
        bodyAlign: profile.bodyAlign ?? 'justify',
        bodyFontSize: profile.bodyFontSize,
        bodyFontFamily: profile.bodyFontFamily,
        collapseBlankLines: true,
      },
    ]);
    if (result.applied.length) toast.success(`已套用「${file.name}」的格式：${profile.summary}`);
    else toast.warning(result.skipped[0]?.reason ?? '套用失败');
  };

  const send = async (raw?: string) => {
    const instruction = (raw ?? input).trim();
    if (!instruction || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: instruction }]);

    const editor = getActiveEditor();
    if (!editor) {
      setMessages((m) => [...m, { role: 'assistant', content: '请先打开一个文字文档，AI 助手才能操作它。' }]);
      return;
    }
    const config = configs.find((c) => c.enabled);
    if (!config) {
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: '还没有可用的 AI 服务商配置。请打开「设置 → AI 服务商」添加并启用一个。' },
      ]);
      return;
    }

    setBusy(true);
    setMessages((m) => [...m, { role: 'assistant', content: '正在规划操作…' }]);
    try {
      const key = await resolveKey(config.id);
      const adapter = createAiAdapter(config, key);
      const planner = createWriterPlanner({ adapter });

      const { from, to, empty } = editor.state.selection;
      const plan = await planner.planWriter(instruction, {
        text: editor.getText().slice(0, 1500),
        selection: empty ? undefined : editor.state.doc.textBetween(from, to, '\n'),
      });

      const result = applyWriterOps(editor, plan.ops);
      const summary = [
        plan.explanation || '已执行计划',
        `✅ ${result.applied.length} 个操作成功`,
        result.skipped.length ? `⚠️ ${result.skipped.length} 个跳过（${result.skipped.map((s) => s.op).join('、')}）` : '',
      ]
        .filter(Boolean)
        .join('\n');
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = { role: 'assistant', content: summary };
        return next;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((m) => {
        const next = [...m];
        next[next.length - 1] = { role: 'assistant', content: `执行失败：${msg}` };
        return next;
      });
      toast.warning('AI 执行失败');
    } finally {
      setBusy(false);
    }
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  /** 拖拽左边缘调整面板宽度（给文档更多/更少空间） */
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = aiPanelWidth;
    const onMove = (ev: MouseEvent) => setAiPanelWidth(startW + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-border bg-surface"
      style={{ width: aiPanelWidth }}
    >
      {/* 左侧拖拽手柄（调整宽度，给文档更多显示空间） */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="拖拽调整 AI 面板宽度"
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent/40"
        onMouseDown={startResize}
      />

      {/* 面板标题栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <Sparkles size={14} className="text-accent" aria-hidden="true" />
        <span className="text-ui font-medium text-fg">AI 助手</span>
        <IconButton
          label="收起 AI 助手面板"
          size="sm"
          className="ml-auto"
          icon={<PanelRightClose size={15} />}
          onClick={toggleAiPanel}
        />
      </div>

      {/* 排版工具箱（用户反馈 1）：本地确定性执行，不调用 AI、离线可用 */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="mb-1.5 flex items-center gap-1.5 text-tiny font-medium text-muted">
          <LayoutTemplate size={12} aria-hidden="true" />
          排版工具箱
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TIDY_TOOLS.map((tool) => (
            <button
              key={tool.label}
              type="button"
              title={tool.title}
              className="flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-tiny text-fg transition-colors hover:border-accent hover:text-accent"
              onClick={() => runTidy(tool.op())}
            >
              <tool.icon size={12} aria-hidden="true" />
              {tool.label}
            </button>
          ))}
          <select
            className="rounded-sm border border-border bg-surface px-1.5 py-1 text-tiny text-fg"
            defaultValue=""
            onChange={(e) => {
              const id = e.target.value;
              e.target.value = '';
              if (id) runTidy({ op: 'applyTemplate', templateId: id });
            }}
          >
            <option value="" disabled>
              套用模板…
            </option>
            {FORMAT_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            title="选择一份 Word 文档，提取它的正文格式（字体/字号/行距/缩进/对齐）并套用到当前文档"
            className="flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-tiny text-fg transition-colors hover:border-accent hover:text-accent"
            onClick={() => referenceInputRef.current?.click()}
          >
            <FileUp size={12} aria-hidden="true" />
            参考文档格式
          </button>
          <input
            ref={referenceInputRef}
            type="file"
            accept=".docx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void runReferenceFormat(f);
            }}
          />
        </div>
      </div>

      {/* 对话区 */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <Bot size={28} className="text-muted" aria-hidden="true" />
            <p className="text-body text-fg">用自然语言指挥 AI 修改文档</p>
            <p className="text-tiny leading-relaxed text-muted">
              例如：「把选区加粗」「在文末插入 3×3 表格」
              <br />
              「加一段总结」「标题改成红色」
            </p>
            {configs.length === 0 && (
              <p className="text-tiny text-warning">尚未配置 AI 服务商，请到「设置 → AI 服务商」添加。</p>
            )}
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[92%] whitespace-pre-wrap rounded px-2.5 py-1.5 text-body ${
              m.role === 'user'
                ? 'self-end bg-accent/10 text-fg'
                : 'self-start border border-border bg-surface text-fg'
            }`}
          >
            {m.content}
          </div>
        ))}
        {busy && <div className="self-start text-tiny text-muted">AI 思考中…</div>}
      </div>

      {/* 输入区 */}
      <div className="flex flex-col gap-1 border-t border-border px-3 py-2">
        {/* T4.4 快捷技能条 */}
        <div className="flex flex-wrap gap-1">
          {QUICK_SKILLS.map((skill) => (
            <button
              key={skill.label}
              type="button"
              disabled={busy}
              onClick={() => void send(skill.instruction)}
              className="rounded-full border border-border px-2 py-0.5 text-tiny text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
            >
              {skill.label}
            </button>
          ))}
        </div>
        <div className="flex h-9 items-center gap-1.5">
          <Input
            placeholder={busy ? 'AI 执行中…' : '输入指令，回车发送'}
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <IconButton
            label="发送"
            icon={<Send size={15} />}
            disabled={busy || !input.trim()}
            onClick={() => void send()}
          />
        </div>
      </div>
    </aside>
  );
}
