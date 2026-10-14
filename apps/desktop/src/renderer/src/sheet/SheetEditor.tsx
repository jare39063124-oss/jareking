/**
 * SheetEditor —— 基于 Univer v1.0 preset 的表格编辑器（T2.2）。
 *
 * 职责：
 *  - 挂载容器 → createUniver + UniverSheetsCorePreset（自带工具栏/公式栏/右键菜单/多 sheet 标签）
 *  - 打开 .xlsx：文件 → parseXlsx → jkToUniverData → createWorkbook
 *  - 保存 .xlsx：FWorkbook.save() 快照 → univerSnapshotToJk → exportXlsx → Blob 下载
 *  - 首次加载内置示例数据（无内置 xlsx 资源，用代码构造演示表）
 *
 * 说明：中文 locale 由 preset 的 locales/zh-CN 提供（内部已合并全部子包语言）。
 * 组件卸载时 dispose Univer 实例，避免多标签页切换泄漏。
 */
import { useEffect, useRef, useState } from 'react';
import { createUniver, defaultTheme, LocaleType } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import UniverZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import SortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN';
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import FilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN';
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting';
import CfZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN';
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation';
import DvZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN';
import '@univerjs/preset-sheets-core/lib/index.css';
import { exportXlsx, sheetToCsv, type JkWorkbook } from '@jareking/sheet';
import type { FUniver } from '@univerjs/core';
import { createAiAdapter, createSheetPlanner, type SheetPlanned } from '@jareking/ai';
import { Download, FileSpreadsheet, FolderOpen, RefreshCw, Sparkles } from 'lucide-react';

import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { toast } from '../stores/toastStore';
import { useAiStore } from '../stores/aiStore';
import { jkToUniverData, univerSnapshotToJk } from './univerAdapter';
import { applySheetOps } from './sheetOpsExecutor';
import { parseInWorker } from '../lib/parseClient';

/** 首载演示工作簿（体现 值/公式/合并/列宽 四类能力） */
function demoWorkbook(): JkWorkbook {
  return {
    sheets: [
      {
        name: '示例',
        rowCount: 60,
        colCount: 12,
        cells: {
          '0,0': { value: '产品', style: undefined },
          '0,1': { value: '单价' },
          '0,2': { value: '数量' },
          '0,3': { value: '金额' },
          '1,0': { value: '键盘' },
          '1,1': { value: 199 },
          '1,2': { value: 3 },
          '1,3': { formula: 'B2*C2' },
          '2,0': { value: '显示器' },
          '2,1': { value: 1299 },
          '2,2': { value: 2 },
          '2,3': { formula: 'B3*C3' },
          '3,0': { value: '合计' },
          '3,3': { formula: 'SUM(D2:D3)' },
        },
        merges: [{ startRow: 5, startCol: 0, endRow: 5, endCol: 2 }],
        colWidths: { 0: 140, 1: 110, 2: 110, 3: 130 },
      },
      { name: '空白页', rowCount: 60, colCount: 12, cells: {}, merges: [] },
    ],
    activeSheetIndex: 0,
  };
}

/** 创建工作簿并解除 Univer v1.0 默认的整表保护（否则所有写入被权限系统静默拦截） */
async function createWb(api: FUniver, wb: JkWorkbook): Promise<void> {
  // 先卸载旧工作簿：jkToUniverData 固定 unit id 'jareking-sheet'，重复创建
  // （demo 首建后再打开文件 / 连续打开两个文件）会撞 UniverInstanceService 同 id 校验
  // 而抛 "cannot create a unit with the same unit id"。
  try {
    const currentId = api.getActiveWorkbook?.()?.getId?.();
    if (currentId) api.disposeUnit(currentId);
  } catch {
    // 卸载失败不阻断新工作簿创建
  }
  const fwb = api.createWorkbook(jkToUniverData(wb) as Parameters<typeof api.createWorkbook>[0]);
  try {
    // 1.0.4 实际 API：工作表权限模型上的 unprotect()——删除整表保护规则并重置全部权限点为可编辑
    // （文档中的 FPermission.removeWorksheetPermission 在 1.0.4 尚未实现，勿用）
    for (const sheet of fwb.getSheets?.() ?? []) {
      await sheet.getWorksheetPermission?.().unprotect?.();
    }
  } catch {
    // 权限 API 异常不阻断工作簿创建
  }
}

export function SheetEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  // univerAPI 持有在 ref（非 state）：实例方法不参与渲染
  const apiRef = useRef<FUniver | null>(null);
  const [ready, setReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const aiInputRef = useRef<HTMLInputElement>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  /** 可回退：AI 执行前的整簿快照（JkWorkbook），撤销时经 createWb 重建 */
  const aiUndoRef = useRef<JkWorkbook | null>(null);
  const [aiCanUndo, setAiCanUndo] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  // Enter 处理器读 ref 而非 state：避免 React 批处理导致读到旧值
  const aiInstructionRef = useRef('');
  const configs = useAiStore((s) => s.configs);
  const aiLoaded = useAiStore((s) => s.loaded);
  const loadAiConfigs = useAiStore((s) => s.load);
  const resolveKey = useAiStore((s) => s.resolveKey);

  useEffect(() => {
    if (!aiLoaded) void loadAiConfigs();
  }, [aiLoaded, loadAiConfigs]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || apiRef.current) return;

    let disposed = false;
    let univerRef: ReturnType<typeof createUniver>['univer'] | null = null;

    const init = async () => {
      const { univer, univerAPI } = createUniver({
        // 注意：locale key 必须用 Univer LocaleType 枚举值（'zhCN'），
        // 字符串 'zh-CN' 会导致内部 LOCALE_META 查表 undefined 而抛错
        locale: LocaleType.ZH_CN,
        locales: {
          [LocaleType.ZH_CN]: Object.assign(
            {},
            UniverZhCN as Record<string, string>,
            SortZhCN as Record<string, string>,
            FilterZhCN as Record<string, string>,
            CfZhCN as Record<string, string>,
            DvZhCN as Record<string, string>,
          ),
        },
        theme: defaultTheme,
        presets: [
          UniverSheetsCorePreset({ container: el }),
          // T2.4 数据功能：排序 / 筛选 / 条件格式 / 数据验证
          UniverSheetsSortPreset(),
          UniverSheetsFilterPreset(),
          UniverSheetsConditionalFormattingPreset(),
          UniverSheetsDataValidationPreset(),
        ],
      });
      void univer;
      await createWb(univerAPI, demoWorkbook());
      if (disposed) {
        univer.dispose();
        return;
      }
      univerRef = univer;
      apiRef.current = univerAPI;
      setReady(true);
    };
    void init();

    return () => {
      disposed = true;
      univerRef?.dispose();
      apiRef.current = null;
      setReady(false);
    };
  }, []);

  const onOpenFile = () => fileInputRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const wb = await parseInWorker('xlsx', buf);
      await createWb(apiRef.current!, wb);
      toast.success(`已打开 ${file.name}`);
    } catch (err) {
      console.error('打开 xlsx 失败:', err);
      toast.warning('打开失败：文件可能不是有效的 .xlsx');
    }
  };

  /** T4.5：自然语言 → Sheet ops（公式/数据写入）→ 确定性执行 */
  const runSheetAi = async (instruction: string) => {
    const api = apiRef.current;
    if (!api || aiBusy) return;
    const config = configs.find((c) => c.enabled);
    if (!config) {
      toast.warning('请先在「设置 → AI 服务商」配置并启用一个服务商');
      return;
    }
    setAiBusy(true);
    setAiNote('AI 规划中…');
    try {
      const key = await resolveKey(config.id);
      const adapter = createAiAdapter(config, key);
      const planner = createSheetPlanner({ adapter });

      // 上下文：活动表转 CSV 节选
      const workbook = api.getActiveWorkbook();
      if (!workbook) throw new Error('无活动工作簿');
      const snapshot = (workbook as unknown as { save: () => Record<string, unknown> }).save();
      const jk = univerSnapshotToJk(snapshot as Record<string, never>);
      const activeId = workbook.getActiveSheet()?.getSheetId();
      const activeIdx = Math.max(0, Object.keys(snapshot.sheets ?? {}).indexOf(activeId ?? ''));
      const sheet = jk.sheets[activeIdx] ?? jk.sheets[0];

      const plan: SheetPlanned = await planner.planSheet(instruction, {
        name: sheet.name,
        csvSample: sheetToCsv(sheet).slice(0, 1200),
      });

      if (!plan.ops.length) {
        // 数据问题类指令：LLM 直接在 explanation 回答
        setAiNote(plan.explanation || '（无操作）');
        toast.info(plan.explanation || '无需修改表格');
        return;
      }
      // 可回退：jk 为执行前快照（plan 前算出），撤销即整簿重建
      aiUndoRef.current = jk;
      const result = applySheetOps(api, plan.ops);
      setAiCanUndo(true);
      setAiNote(
        `${plan.explanation || '已执行'} · ✅${result.applied.length}${result.skipped.length ? ` · ⚠️跳过${result.skipped.length}` : ''}`,
      );
      toast.success(`AI 已执行 ${result.applied.length} 个操作（可撤销）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAiNote(`失败：${msg}`);
      toast.warning(`AI 执行失败：${msg}`);
    } finally {
      setAiBusy(false);
    }
  };

  /** 调试钩子（自动化冒烟 / 开发检查）：主进程以 --jk-debug 或开发模式启用
   *  runSheetAi 经 ref 间接持有，保证钩子始终调用最新闭包 */
  const aiRunRef = useRef(runSheetAi);
  aiRunRef.current = runSheetAi;
  useEffect(() => {
    if (ready && new URLSearchParams(window.location.search).has('jk-debug')) {
      (window as unknown as Record<string, unknown>).__jkDebug = {
        snapshot: () => apiRef.current?.getActiveWorkbook()?.save() ?? null,
        runSheetAi: (instruction: string) => aiRunRef.current(instruction),
        // #46-C 压测钩子：解析级直调（transfer 会 neuter buf.buffer）
        parseInWorker: (kind: 'xlsx' | 'pptx', buf: Uint8Array) => parseInWorker(kind, buf),
        activeSheet: () => {
          const s = apiRef.current?.getActiveWorkbook()?.getActiveSheet();
          return s ? { id: s.getSheetId(), name: s.getSheetName() } : null;
        },
        directSet: () => {
          const s = apiRef.current?.getActiveWorkbook()?.getActiveSheet();
          if (!s) return 'no-sheet';
          s.getRange('H1').setValue('DIRECT');
          return 'ok';
        },
        readCell: (a1: string) => {
          const v = apiRef.current?.getActiveWorkbook()?.getActiveSheet()?.getRange(a1)?.getValue();
          return v === undefined || v === null ? null : v;
        },
        // 数字重载对照测试（T4.5 排查 getRange 字符串重载是否失效）
        setValueAt: (row: number, col: number, v: unknown) => {
          const s = apiRef.current?.getActiveWorkbook()?.getActiveSheet();
          if (!s) return 'no-sheet';
          s.getRange(row, col).setValue(v);
          return 'ok';
        },
        getValueAt: (row: number, col: number) => {
          const v = apiRef.current?.getActiveWorkbook()?.getActiveSheet()?.getRange(row, col)?.getValue();
          return v === undefined || v === null ? null : v;
        },
        probeProtect: async () => {
          const s = apiRef.current?.getActiveWorkbook()?.getActiveSheet();
          if (!s) return 'no-sheet';
          const proto = Object.getPrototypeOf(s);
          const methods = Object.getOwnPropertyNames(proto).filter((n) => n.toLowerCase().includes('protect'));
          const before = typeof s.hasProtection === 'function' ? s.hasProtection() : 'n/a';
          await s.unprotect?.();
          const after = typeof s.hasProtection === 'function' ? s.hasProtection() : 'n/a';
          await s.getRange('I1').setValue('AFTER-UNPROTECT');
          const readBack = s.getRange('I1').getValue();
          return JSON.stringify({ methods, before, after, readBack });
        },
        // 暴露原始对象供探针深度内省（仅 jk-debug 模式）
        fws: () => apiRef.current?.getActiveWorkbook()?.getActiveSheet(),
        funiver: () => apiRef.current,
      };
    }
  }, [ready]);

  /** 当前 Univer 工作簿快照 → JkWorkbook（保存侧共用） */
  const currentJkWorkbook = (): JkWorkbook | null => {
    const api = apiRef.current;
    if (!api) return null;
    const workbook = api.getActiveWorkbook();
    if (!workbook) return null;
    // FWorkbook.save() 返回 IWorkbookSnapshotData（v1.0 facade）
    const snapshot = (workbook as unknown as { save: () => Record<string, unknown> }).save();
    return univerSnapshotToJk(snapshot as Record<string, never>);
  };

  /** 触发浏览器下载 */
  const downloadBlob = (buf: BlobPart, mime: string, filename: string): void => {
    const blob = new Blob([buf], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const onSave = async () => {
    try {
      const jk = currentJkWorkbook();
      if (!jk) throw new Error('no active workbook');
      const buf = await exportXlsx(jk);
      downloadBlob(
        buf,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '导出.xlsx',
      );
      toast.success('已导出「导出.xlsx」');
    } catch {
      toast.warning('导出失败：当前工作簿无法序列化');
    }
  };

  /** T2.6：当前活动 sheet 导出 CSV（仅值，无样式/公式重算） */
  const onSaveCsv = () => {
    try {
      const jk = currentJkWorkbook();
      if (!jk || !jk.sheets.length) throw new Error('no sheet');
      const sheet = jk.sheets[jk.activeSheetIndex ?? 0];
      const csv = sheetToCsv(sheet);
      // 加 BOM，保证 Excel/WPS 识别 UTF-8
      downloadBlob(`\uFEFF${csv}`, 'text/csv;charset=utf-8', `${sheet.name || '导出'}.csv`);
      toast.success(`已导出「${sheet.name || '导出'}.csv」`);
    } catch {
      toast.warning('CSV 导出失败');
    }
  };

  const onReset = () => {
    void createWb(apiRef.current!, demoWorkbook());
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      {/* 顶栏：文件操作（编辑能力由 Univer 自带工具栏提供） */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-2">
        <Button variant="secondary" size="sm" icon={<FolderOpen size={13} />} onClick={onOpenFile}>
          打开
        </Button>
        <Button variant="primary" size="sm" icon={<Download size={13} />} onClick={onSave} disabled={!ready}>
          保存
        </Button>
        <Button variant="secondary" size="sm" icon={<FileSpreadsheet size={13} />} onClick={onSaveCsv} disabled={!ready}>
          导出 CSV
        </Button>
        <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={onReset}>
          重置示例
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Sparkles size={14} className="shrink-0 text-accent" aria-hidden="true" />
        <Input
          className="w-64"
          placeholder="AI：如「在D2算B列合计」"
          disabled={aiBusy || !ready}
          value={aiInstruction}
          onChange={(e) => {
            aiInstructionRef.current = e.target.value;
            setAiInstruction(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && aiInstructionRef.current.trim()) {
              e.preventDefault();
              void runSheetAi(aiInstructionRef.current.trim());
              aiInstructionRef.current = '';
              setAiInstruction('');
            }
          }}
        />
        {aiNote && (
          <span className="max-w-72 truncate text-tiny text-muted" title={aiNote}>
            {aiNote}
          </span>
        )}
        {aiCanUndo && (
          <button
            type="button"
            title="恢复到本次 AI 执行前的表格状态"
            className="rounded border border-border px-1.5 py-0.5 text-tiny text-muted transition-colors hover:border-accent hover:text-accent"
            onClick={() => {
              const api = apiRef.current;
              const snap = aiUndoRef.current;
              if (!api || !snap) return;
              void createWb(api, snap);
              aiUndoRef.current = null;
              setAiCanUndo(false);
              setAiNote('已撤销本次 AI 操作');
              toast.success('已撤销本次 AI 操作');
            }}
          >
            ↩ 撤销
          </button>
        )}
        <span className="ml-auto text-xs text-text-secondary">
          Univer 表格引擎 · 公式/合并/多 Sheet 开箱即用
        </span>
      </div>

      {/* Univer 挂载点：必须固定尺寸，内部自行布局 */}
      <div ref={containerRef} className="min-h-0 flex-1" />

      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xlsm,.csv"
        className="hidden"
        onChange={onFileChange}
      />
    </div>
  );
}
