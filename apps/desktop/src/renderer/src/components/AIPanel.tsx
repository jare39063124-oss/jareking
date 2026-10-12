import { useState, type KeyboardEvent } from 'react';
import { Bot, PanelRightClose, Send, Sparkles } from 'lucide-react';
import { IconButton } from './IconButton';
import { Input } from './Input';
import { toast } from '../stores/toastStore';
import { useUiStore } from '../stores/uiStore';

/** AI 助手侧边面板（占位）：对话区 + 输入框，可折叠 */
export function AIPanel() {
  const toggleAiPanel = useUiStore((state) => state.toggleAiPanel);
  const [input, setInput] = useState('');

  const send = () => {
    const text = input.trim();
    if (!text) return;
    toast.info('AI 助手即将上线，敬请期待');
    setInput('');
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
      {/* 面板标题栏 */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <Sparkles size={14} className="text-accent" aria-hidden="true" />
        <span className="text-ui font-medium text-fg">AI 助手</span>
        <span className="rounded-full border border-border px-1.5 py-px text-tiny text-muted">占位</span>
        <IconButton
          label="收起 AI 助手面板"
          size="sm"
          className="ml-auto"
          icon={<PanelRightClose size={15} />}
          onClick={toggleAiPanel}
        />
      </div>

      {/* 对话区（占位） */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted-bg">
          <Bot size={24} className="text-muted" aria-hidden="true" />
        </div>
        <p className="text-body text-fg">向 AI 描述你的需求</p>
        <p className="text-tiny leading-relaxed text-muted">
          支持自然语言改文档、处理表格、
          <br />
          一键生成 PPT（Phase 4 接入）
        </p>
        {/* 占位指令示例 */}
        <div className="mt-2 flex w-full flex-col gap-1.5">
          {['把第三章字号改小', '按月份汇总销售额', '根据大纲生成 PPT'].map((example) => (
            <div
              key={example}
              className="rounded-sm border border-border px-2.5 py-1.5 text-left text-tiny text-muted"
            >
              {example}
            </div>
          ))}
        </div>
      </div>

      {/* 输入区（占位） */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border p-2">
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="问点什么…（占位）"
          aria-label="AI 对话输入"
        />
        <IconButton label="发送" icon={<Send size={15} />} onClick={send} />
      </div>
    </aside>
  );
}
