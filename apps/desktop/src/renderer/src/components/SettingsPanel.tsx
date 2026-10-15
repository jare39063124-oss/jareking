import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Code2, FolderOpen, Gauge, HardDrive, Moon, Sun, Type } from 'lucide-react';
import { Modal } from './Modal';
import { Select } from './Select';
import { AiConfigSection } from './AiConfigSection';
import { MacroSection } from './MacroSection';
import { Button } from './Button';
import { toast } from '../stores/toastStore';
import { useUiStore, type ThemeMode } from '../stores/uiStore';
import { useAiMeteringStore, AI_METER_RECENT_LIMIT } from '../stores/aiMeteringStore';
import { FONT_GROUPS } from '../lib/fonts';

/** 可折叠设置分区（手风琴）：标题可点击展开/收起 */
function CollapsibleSection({
  title,
  icon: Icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon?: typeof Sun;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="flex flex-col gap-2 border-b border-border pb-4 last:border-b-0 last:pb-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-ui font-medium text-fg"
      >
        {Icon && <Icon size={14} className="text-accent" aria-hidden="true" />}
        <span className="flex-1 text-left">{title}</span>
        <ChevronDown
          size={14}
          className={`text-muted transition-transform ${open ? '' : '-rotate-90'}`}
          aria-hidden="true"
        />
      </button>
      {open && <div className="flex flex-col gap-2">{children}</div>}
    </section>
  );
}

/** 字体分区（版权合规）：推荐免费商用字体清单 + 官方下载直达（docs/fonts.md） */
function FontSectionBody() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-tiny leading-relaxed text-muted">
        jareking 字体分三层：① 系统字体（调用本机已有，不分发）② OFL 开源字体（将随安装包内置，可商用）③
        厂商免费商用字体（下方一键前往官方下载安装）。严禁内置方正/汉仪等需授权字体。
      </p>
      {FONT_GROUPS.filter((g) => g.downloads).map((group) => (
        <div key={group.label} className="flex flex-col gap-1.5">
          <span className="text-tiny font-medium text-fg">{group.label}</span>
          <div className="flex flex-wrap gap-1.5">
            {group.fonts
              .filter((f) => group.downloads?.[f])
              .map((f) => (
                <button
                  key={f}
                  type="button"
                  title={`前往 ${f} 官方下载页`}
                  className="flex items-center gap-1 rounded-sm border border-border px-2 py-1 text-tiny text-fg transition-colors hover:border-accent hover:text-accent"
                  onClick={() => {
                    const url = group.downloads?.[f];
                    if (!url) return;
                    void window.jareking.invoke('system:openExternal', { url });
                  }}
                >
                  <FolderOpen size={11} aria-hidden="true" />
                  {f}
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 存储管理（对标 WPS「缓存占 C 盘且不透明」痛点）：数据位置与占用透明可见 */
function StorageSectionBody() {
  const [info, setInfo] = useState<{ dataDir: string; bytes: number } | null>(null);
  useEffect(() => {
    void window.jareking
      .invoke('system:storageInfo')
      .then((r) => setInfo(r as { dataDir: string; bytes: number }))
      .catch(() => undefined);
  }, []);
  const mb = info ? (info.bytes / 1024 / 1024).toFixed(1) : '-';
  return (
    <>
      <p className="text-tiny leading-relaxed text-muted">
        jareking 所有数据（账户、文档记录、AI 配置）都集中保存在这一个文件夹，无云备份副本、无隐藏缓存——
        占用一目了然，卸载时删除该文件夹即彻底清理。
      </p>
      <div className="rounded-sm border border-border bg-muted-bg/50 px-3 py-2 text-tiny text-fg">
        <div className="flex justify-between">
          <span className="text-muted">数据位置</span>
          <span className="max-w-64 truncate font-mono" title={info?.dataDir}>
            {info?.dataDir ?? '读取中…'}
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted">当前占用</span>
          <span>{mb} MB</span>
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        icon={<FolderOpen size={13} />}
        onClick={() => void window.jareking.invoke('system:openDataDir').catch(() => toast.warning('打开失败'))}
      >
        打开数据文件夹
      </Button>
    </>
  );
}

/** 计量流水时间戳格式化（本地时间） */
function formatMeterTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 数字千分位（token / 积分展示） */
function formatCount(n: number): string {
  return n.toLocaleString('zh-CN');
}

/**
 * 算力用量分区（为后续 AI 功能与商业化铺路）：
 * 展示 AI 调用的总调用数 / 总 token / 总积分，以及最近用量流水（模型 / 时间 / token / 积分）。
 * 数据经 IPC 从主进程本地库读取（`ai:meter:summary` / `ai:meter:records`）。
 */
function MeteringSectionBody() {
  const summary = useAiMeteringStore((s) => s.summary);
  const records = useAiMeteringStore((s) => s.records);
  const loading = useAiMeteringStore((s) => s.loading);
  const loaded = useAiMeteringStore((s) => s.loaded);
  const loadSummary = useAiMeteringStore((s) => s.loadSummary);
  const loadRecords = useAiMeteringStore((s) => s.loadRecords);

  useEffect(() => {
    void loadSummary().catch(() => undefined);
    void loadRecords().catch(() => undefined);
  }, [loadSummary, loadRecords]);

  return (
    <>
      <p className="text-tiny leading-relaxed text-muted">
        AI 调用消耗的算力会按「模型 + token 用量」折算为积分并记账。当前仅展示统计口径——
        后续 AI 功能与商业化（token → 积分计量）将复用该计量链路。
      </p>

      {/* 汇总卡片：总调用数 / 总 token / 总积分 */}
      <div className="grid grid-cols-3 gap-1.5">
        <div className="flex flex-col rounded-sm border border-border bg-muted-bg/50 px-2.5 py-2">
          <span className="text-tiny text-muted">总调用数</span>
          <span className="text-body font-medium text-fg">{formatCount(summary.totalCalls)}</span>
        </div>
        <div className="flex flex-col rounded-sm border border-border bg-muted-bg/50 px-2.5 py-2">
          <span className="text-tiny text-muted">总 token</span>
          <span className="text-body font-medium text-fg">{formatCount(summary.totalTokens)}</span>
        </div>
        <div className="flex flex-col rounded-sm border border-border bg-muted-bg/50 px-2.5 py-2">
          <span className="text-tiny text-muted">总积分</span>
          <span className="text-body font-medium text-accent">
            {formatCount(summary.totalPoints)}
          </span>
        </div>
      </div>

      {/* 最近用量流水 */}
      <div className="flex items-center justify-between">
        <span className="text-tiny font-medium text-fg">最近用量</span>
        <button
          type="button"
          className="rounded p-1 text-muted hover:bg-hover hover:text-accent disabled:opacity-40"
          disabled={loading}
          onClick={() => void loadRecords().catch(() => undefined)}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className="flex flex-col gap-1">
        {loaded && records.length === 0 && (
          <div className="rounded border border-dashed border-border p-3 text-center text-tiny text-muted">
            暂无 AI 用量记录。配置 AI 服务商并开始对话后，调用用量将在此汇总。
          </div>
        )}
        {records.slice(0, AI_METER_RECENT_LIMIT).map((record) => (
          <div
            key={record.id}
            className="flex items-center justify-between rounded border border-border px-2.5 py-1.5"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-body text-fg">{record.model}</span>
              <span className="truncate text-tiny text-muted">
                {formatMeterTime(record.at)}
                {record.feature ? ` · ${record.feature}` : ''}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="text-tiny text-muted">
                {formatCount(record.usage.totalTokens)} token
              </span>
              <span className="text-tiny text-accent">-{formatCount(record.points)} 积分</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** 主题分段按钮（浅色 / 深色） */
function ThemeSegmented({
  theme,
  onChange,
}: {
  theme: ThemeMode;
  onChange: (theme: ThemeMode) => void;
}) {
  const options: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
  ];

  return (
    <div className="flex gap-1 rounded-sm border border-border p-0.5">
      {options.map((option) => {
        const active = option.value === theme;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`flex items-center gap-1 rounded-sm px-2.5 py-1 text-tiny transition-colors ${
              active ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover hover:text-fg'
            }`}
          >
            <option.icon size={13} aria-hidden="true" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 设置模态面板：主题切换 + 占位设置项（语言 / 启动行为） */
export function SettingsPanel() {
  const open = useUiStore((state) => state.settingsOpen);
  const setOpen = useUiStore((state) => state.setSettingsOpen);
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="设置" width={560}>
      <div className="flex flex-col gap-4">
        {/* AI 服务商配置（T4.2）—— 可折叠；默认展开，避免藏起核心配置 */}
        <CollapsibleSection title="AI 服务商" defaultOpen={true}>
          <AiConfigSection />
        </CollapsibleSection>

        {/* 算力用量（token → 积分计量）：汇总 + 最近用量流水，为后续 AI 商业化铺路 */}
        <CollapsibleSection title="算力用量" icon={Gauge} defaultOpen={false}>
          <MeteringSectionBody />
        </CollapsibleSection>

        {/* 字体（版权合规版）：推荐免费商用字体 + 官方下载直达（docs/fonts.md） */}
        <CollapsibleSection title="字体" icon={Type}>
          <FontSectionBody />
        </CollapsibleSection>

        {/* 存储管理（数据透明，对标 WPS C 盘痛点） */}
        <CollapsibleSection title="存储管理" icon={HardDrive}>
          <StorageSectionBody />
        </CollapsibleSection>

        {/* 宏（JS 宏 Worker 沙箱）：列出/新建/编辑/删除/运行，见 docs/macros.md */}
        <CollapsibleSection title="宏" icon={Code2} defaultOpen={false}>
          <MacroSection />
        </CollapsibleSection>

        {/* 外观：主题 */}
        <CollapsibleSection title="外观">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-body text-fg">主题</span>
              <span className="text-tiny text-muted">切换界面浅色 / 深色配色</span>
            </div>
            <ThemeSegmented theme={theme} onChange={setTheme} />
          </div>
        </CollapsibleSection>

        {/* 语言（占位） */}
        <CollapsibleSection title="语言">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-body text-fg">界面语言</span>
              <span className="text-tiny text-muted">多语言能力将在后续版本提供</span>
            </div>
            <Select
              className="w-40"
              defaultValue="zh-CN"
              options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en-US', label: 'English' },
              ]}
              onChange={() => toast.info('多语言功能建设中')}
            />
          </div>
        </CollapsibleSection>

        {/* 启动行为（占位） */}
        <CollapsibleSection title="启动行为">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-body text-fg">启动时</span>
              <span className="text-tiny text-muted">本地持久层就绪后生效</span>
            </div>
            <Select
              className="w-40"
              defaultValue="start-page"
              options={[
                { value: 'start-page', label: '显示启动页' },
                { value: 'new-doc', label: '新建空白文档' },
                { value: 'recent', label: '打开最近文件' },
              ]}
              onChange={() => toast.info('启动行为设置将在 T0.4 持久层就绪后生效')}
            />
          </div>
        </CollapsibleSection>
      </div>
    </Modal>
  );
}
