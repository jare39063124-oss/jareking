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
import type { FUniver } from '@univerjs/core';
import { createAiAdapter, createSheetPlanner, type SheetPlanned } from '@jareking/ai';
import { Download, FileSpreadsheet, FolderOpen, Paintbrush, RefreshCw, Search, Sparkles } from 'lucide-react';

import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { toast } from '../stores/toastStore';
import { useAiStore } from '../stores/aiStore';
import { jkToUniverData, univerSnapshotToJk } from './univerAdapter';
import { applySheetOps } from './sheetOpsExecutor';
import { parseInWorker } from '../lib/parseClient';
import { takePendingOpen } from '../stores/pendingOpenStore';
import {
  exportXlsx,
  sheetToCsv,
  findCells,
  replaceCells,
  toA1,
  cellValueStr,
  normalizeColor,
  normalizeCellStyle,
  type JkWorkbook,
  type JkCellStyle,
  type FindResult,
  type FindOpts,
} from '@jareking/sheet';

/**
 * 防御式调用 FRange 的样式 setter：方法不存在或抛错时仅 warn，不阻断其余属性写入。
 * Univer 各版本 setter 签名略有差异，统一走此封装保证「部分失败不全盘崩溃」。
 */
function safeSet(range: unknown, method: string, ...args: unknown[]): void {
  try {
    const r = range as Record<string, unknown>;
    if (typeof r?.[method] === 'function') {
      (r[method] as (...a: unknown[]) => void)(...args);
    } else {
      console.warn(`[设置单元格格式] FRange.${method} 不存在，已跳过`);
    }
  } catch (e) {
    console.warn(`[设置单元格格式] FRange.${method} 调用失败:`, e);
  }
}

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

  // 查找替换（WPS 对齐批3续）UI 状态
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const [findResults, setFindResults] = useState<FindResult[]>([]);

  // 设置单元格格式（WPS 对齐批2续）UI 状态
  const [formatOpen, setFormatOpen] = useState(false);
  /** 对话框内表单状态（受控）；空串 / 未勾选 → undefined，便于 normalizeCellStyle 跳过 */
  const [cellStyle, setCellStyle] = useState<Partial<JkCellStyle>>({});
  /** 边框色（原生 color input，默认黑） */
  const [borderColor, setBorderColor] = useState('#000000');
  /** 当前页签：数字 / 对齐 / 字体 / 填充 / 边框 */
  const [fmtTab, setFmtTab] = useState<'number' | 'align' | 'font' | 'fill' | 'border'>('number');
  /** 边框下拉选择（无/全部框线/外边框/单边），映射到 cellStyle.borders */
  const [borderChoice, setBorderChoice] = useState<string>('none');

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

  /** 最近文档直达（WPS 对齐 N5）：消费首页「最近使用」点击 */
  useEffect(() => {
    if (!ready) return;
    const p = takePendingOpen();
    if (!p || p.module !== 'sheet' || !/\.xlsx$/i.test(p.path)) return;
    void (async () => {
      try {
        const bytes = await window.jareking.invoke<Uint8Array | null>('doc:read-file', { path: p.path });
        if (!bytes) {
          toast.warning('文件已不存在或无法读取');
          return;
        }
        const wb = await parseInWorker('xlsx', new Uint8Array(bytes));
        const api = apiRef.current;
        if (!api) return;
        await createWb(api, wb);
        toast.success(`已打开 ${p.name}`);
      } catch (err) {
        toast.warning(`打开失败：${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }, [ready]);

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

  /** 全局快捷键 Ctrl/Cmd+1：打开「设置单元格格式」对话框（WPS/Excel 经典聚合对话框）。
   * 仅在焦点不在输入框 / 文本域（含 Univer 单元格编辑态）时响应，避免与 Univer 自带
   * 快捷键及 AI 输入框冲突。 */
  useEffect(() => {
    if (!ready) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      // 输入框 / 文本域（含 Univer 单元格编辑输入框）中不触发
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '1' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setFormatOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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

  /** 查找全部：实时快照 → JkWorkbook → findCells（结果含 A1 定位信息） */
  const onFindAll = () => {
    const api = apiRef.current;
    if (!api) return;
    const workbook = api.getActiveWorkbook();
    if (!workbook) return;
    // 取实时快照（FWorkbook.save()），转回 JkWorkbook 后在其上查找
    const snapshot = (workbook as unknown as { save: () => Record<string, unknown> }).save();
    const jk = univerSnapshotToJk(snapshot as Record<string, never>);
    const opts: FindOpts = { matchCase, wholeCell };
    setFindResults(findCells(jk, findQuery, opts));
  };

  /** 点击结果项：选中该单元格（FRange.activate 实测可用；可选链兜底） */
  const onResultClick = (r: FindResult) => {
    const api = apiRef.current;
    if (!api) return;
    const fwb = api.getActiveWorkbook();
    if (!fwb) return;
    // 按下标取工作表（univerSnapshotToJk 与 getSheets 顺序一致）；回退按名称匹配
    const sheet = fwb.getSheets()[r.sheetIndex] ?? fwb.getSheetByName(r.sheetName) ?? null;
    sheet?.getRange(r.row, r.col, 1, 1).activate?.();
  };

  /** 全部替换：replaceCells（不可变）→ 逐格回写 Univer 实时实例 → toast */
  const onReplaceAll = () => {
    const api = apiRef.current;
    if (!api) return;
    const fwb = api.getActiveWorkbook();
    if (!fwb) return;
    const snapshot = (fwb as unknown as { save: () => Record<string, unknown> }).save();
    const jk = univerSnapshotToJk(snapshot as Record<string, never>);
    const opts: FindOpts = { matchCase, wholeCell };
    const { wb, count } = replaceCells(jk, findQuery, replaceQuery, opts);
    // 对照原快照，仅回写发生变化的纯 value 单元格（公式单元格 replaceCells 已跳过）
    for (let si = 0; si < wb.sheets.length; si++) {
      const newSheet = wb.sheets[si];
      const oldSheet = jk.sheets[si];
      const univerSheet =
        fwb.getSheets()[si] ?? fwb.getSheetByName(newSheet.name) ?? null;
      if (!univerSheet) continue;
      for (const [key, cell] of Object.entries(newSheet.cells)) {
        if (cell.formula) continue; // 公式单元格跳过，避免破坏公式结构
        const oldCell = oldSheet.cells[key];
        const oldVal = oldCell && !oldCell.formula ? cellValueStr(oldCell.value) : undefined;
        const newVal = cellValueStr(cell.value);
        if (newVal !== oldVal) {
          const [r, c] = key.split(',').map(Number);
          // 实测可用 API：FWorksheet.getRange(row, col, 1, 1).setValue(...)
          univerSheet.getRange(r, c, 1, 1).setValue(newVal);
        }
      }
    }
    toast.success(`已替换 ${count} 处`);
    // 刷新查找结果，反映替换后状态
    if (findQuery) onFindAll();
  };

  /** 读取当前选区（活动单元格）样式用于对话框预填。
   * 防御：活动表 / 选区缺失则回退活动单元格 (0,0)；个体 getter 不存在则跳过该项。 */
  const readSelectionStyle = (): Partial<JkCellStyle> => {
    const api = apiRef.current;
    if (!api) return {};
    const fwb = api.getActiveWorkbook();
    const sheet = fwb?.getActiveSheet() as unknown as Record<string, any> | undefined;
    if (!sheet) return {};

    // 选区解析：优先 getActiveRange / getActiveCell（实测 getSelectionRange 在本版本不存在），
    // 均拿不到则回退活动单元格 (0,0)
    let range: any = null;
    if (typeof sheet.getActiveRange === 'function') range = sheet.getActiveRange();
    if (!range && typeof sheet.getActiveCell === 'function') range = sheet.getActiveCell();
    if (!range) range = sheet.getRange(0, 0);
    if (!range) return {};

    const out: Partial<JkCellStyle> = {};

    // —— 字体名 / 字号 / 换行 / 对齐 / 背景：本版本 FRange 实测存在对应 getter ——
    if (typeof range.getFontFamily === 'function') {
      const ff = range.getFontFamily();
      if (ff) out.fontFamily = ff;
    }
    if (typeof range.getFontSize === 'function') {
      const fs = range.getFontSize();
      if (typeof fs === 'number') out.fontSize = fs;
    }
    if (typeof range.getWrap === 'function') {
      if (range.getWrap()) out.wrapText = true;
    }
    if (typeof range.getHorizontalAlignment === 'function') {
      // 返回 'left' | 'center' | 'normal'(右对齐) | 'general'
      const h = range.getHorizontalAlignment();
      if (h === 'left') out.align = 'left';
      else if (h === 'center') out.align = 'center';
      else if (h === 'normal') out.align = 'right';
    }
    if (typeof range.getVerticalAlignment === 'function') {
      // 返回 'top' | 'middle' | 'bottom' | 'general'
      const v = range.getVerticalAlignment();
      if (v === 'top' || v === 'middle' || v === 'bottom') out.valign = v;
    }
    if (typeof range.getBackground === 'function') {
      const bg = normalizeColor(range.getBackground());
      if (bg) out.bgColor = bg;
    }

    // —— 粗体 / 斜体 / 下划线 / 删除线 / 字体色 / 数字格式：本版本 FRange 无独立 getter ——
    // 改用 getCellStyleData()（返回 IStyleData，含 bl/it/ul/st/cl/bg/n 等）反向映射。
    // 实测不存在的 getter：getBold / getItalic / getUnderline / getStrikeThrough /
    //   getFontColor / getFill / getPattern / getWrapText / getSelectionRange。
    const styleData: any =
      typeof range.getCellStyleData === 'function' ? range.getCellStyleData('cell') : null;
    if (styleData && typeof styleData === 'object') {
      if (styleData.bl === 1) out.bold = true;
      if (styleData.it === 1) out.italic = true;
      if (styleData.ul && styleData.ul.s === 1) out.underline = true;
      if (styleData.st && styleData.st.s === 1) out.strike = true;
      const fg = normalizeColor(styleData.cl?.rgb);
      if (fg) out.color = fg;
      if (styleData.n && typeof styleData.n.pattern === 'string' && styleData.n.pattern !== 'General') {
        out.numFmt = styleData.n.pattern;
      }
    }

    return out;
  };

  /** 应用单元格样式到当前选区（活动单元格 / 选区）。
   * 先 normalizeCellStyle 清洗表单态，再逐属性调用 Univer FRange setter 写回；
   * 每个 setter 经 safeSet 防御（typeof + try/catch），失败仅 warn 不阻断。 */
  const applyCellStyle = (style: Partial<JkCellStyle>, borderColorArg = '#000000'): void => {
    const api = apiRef.current;
    if (!api) return;
    const cleaned = normalizeCellStyle(style);
    const fwb = api.getActiveWorkbook();
    const sheet = fwb?.getActiveSheet() as unknown as Record<string, any> | undefined;
    if (!sheet) return;

    // 选区解析（同 readSelectionStyle）
    let range: any = null;
    if (typeof sheet.getActiveRange === 'function') range = sheet.getActiveRange();
    if (!range && typeof sheet.getActiveCell === 'function') range = sheet.getActiveCell();
    if (!range) range = sheet.getRange(0, 0);
    if (!range) return;

    // 数字格式：本应用未加载 sheets-numfmt 预设，setNumberFormat 通常不可用；
    // 优先尝试，失败时回退 setValue({ s: { n: { pattern } } })（核心路径，始终可用）。
    if (cleaned.numFmt) {
      try {
        if (typeof range.setNumberFormat === 'function') {
          range.setNumberFormat(cleaned.numFmt);
        } else {
          range.setValue({ s: { n: { pattern: cleaned.numFmt } } });
        }
      } catch (e) {
        console.warn('[设置单元格格式] 数字格式写入失败:', e);
      }
    }

    // 对齐
    if (cleaned.align) {
      // FRange.setHorizontalAlignment 接受 'left' | 'center' | 'normal'（'normal' = 右对齐）
      const map: Record<string, string> = { left: 'left', center: 'center', right: 'normal' };
      const v = map[cleaned.align];
      if (v) safeSet(range, 'setHorizontalAlignment', v);
    }
    if (cleaned.valign) safeSet(range, 'setVerticalAlignment', cleaned.valign);

    // 换行
    if (cleaned.wrapText) safeSet(range, 'setWrap', true);

    // 字体
    if (cleaned.fontFamily) safeSet(range, 'setFontFamily', cleaned.fontFamily);
    if (typeof cleaned.fontSize === 'number') safeSet(range, 'setFontSize', cleaned.fontSize);
    if (cleaned.bold) safeSet(range, 'setFontWeight', 'bold');
    if (cleaned.italic) safeSet(range, 'setFontStyle', 'italic');
    // 下划线 / 删除线：FRange 用 setFontLine 单一属性承载（'underline' | 'line-through'），
    // 若两者同时勾选，按 facade 语义后者覆盖前者（v1 已知限制，后续可改走底层 style 命令）。
    if (cleaned.underline) safeSet(range, 'setFontLine', 'underline');
    if (cleaned.strike) safeSet(range, 'setFontLine', 'line-through');

    // 字体色 / 背景色
    if (cleaned.color) safeSet(range, 'setFontColor', cleaned.color);
    if (cleaned.bgColor) safeSet(range, 'setBackground', cleaned.bgColor);

    // 边框：从 univerAPI.Enum 取得 BorderType / BorderStyleTypes（避免直接 import 深路径）。
    const b = cleaned.borders;
    if (b) {
      const enums = (api as unknown as { Enum?: any }).Enum;
      const BorderType = enums?.BorderType;
      const BorderStyleTypes = enums?.BorderStyleTypes;
      if (BorderType && BorderStyleTypes) {
        const color = normalizeColor(borderColorArg) ?? '#000000';
        const line = BorderStyleTypes.THIN;
        const all = !!(b.top && b.right && b.bottom && b.left);
        if (all) {
          // 四边全选 → 整网格框线
          safeSet(range, 'setBorder', BorderType.ALL, line, color);
        } else {
          if (b.top) safeSet(range, 'setBorder', BorderType.TOP, line, color);
          if (b.right) safeSet(range, 'setBorder', BorderType.RIGHT, line, color);
          if (b.bottom) safeSet(range, 'setBorder', BorderType.BOTTOM, line, color);
          if (b.left) safeSet(range, 'setBorder', BorderType.LEFT, line, color);
        }
      }
    }

    toast.success('已应用单元格格式');
  };

  /** 打开对话框时的统一入口：预填选区样式、重置边框选项与颜色、再打开 */
  const openFormatDialog = () => {
    setCellStyle(readSelectionStyle());
    setBorderChoice('none');
    setBorderColor('#000000');
    setFmtTab('number');
    setFormatOpen(true);
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
        <Button variant="ghost" size="sm" icon={<Search size={13} />} onClick={() => setFindOpen(true)}>
          查找替换
        </Button>
        <Button variant="ghost" size="sm" icon={<Paintbrush size={13} />} onClick={openFormatDialog}>
          设置单元格格式
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

      {/* 查找替换（WPS 对齐批3续）：严禁 window.prompt/alert，使用 Modal */}
      <Modal
        open={findOpen}
        onClose={() => setFindOpen(false)}
        title="查找替换"
        footer={<Button variant="ghost" size="sm" onClick={() => setFindOpen(false)}>关闭</Button>}
      >
        <div className="flex flex-col gap-3 p-1">
          <div className="flex flex-col gap-1.5">
            <span className="text-tiny text-muted">查找内容</span>
            <Input
              aria-label="查找内容"
              className="w-full"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              placeholder="输入要查找的文本"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-tiny text-muted">替换为</span>
            <Input
              aria-label="替换为"
              className="w-full"
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.target.value)}
              placeholder="替换为（留空表示删除匹配内容）"
            />
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-tiny text-fg">
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(e) => setMatchCase(e.target.checked)}
              />
              区分大小写
            </label>
            <label className="flex items-center gap-1.5 text-tiny text-fg">
              <input
                type="checkbox"
                checked={wholeCell}
                onChange={(e) => setWholeCell(e.target.checked)}
              />
              全字匹配
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onFindAll}>
              查找全部
            </Button>
            <Button variant="primary" size="sm" onClick={onReplaceAll}>
              全部替换
            </Button>
          </div>
          {findResults.length > 0 && (
            <div className="max-h-48 overflow-auto rounded border border-border">
              <div className="px-2 py-1 text-tiny text-muted">共 {findResults.length} 处</div>
              {findResults.map((r, idx) => (
                <button
                  key={`${r.sheetIndex}-${r.row}-${r.col}-${idx}`}
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1 text-left text-tiny hover:bg-hover"
                  onClick={() => onResultClick(r)}
                  title="点击定位到该单元格"
                >
                  <span className="shrink-0 font-medium text-accent">
                    {r.sheetName}!{toA1(r.row, r.col)}
                  </span>
                  <span className="truncate text-muted">{r.value}</span>
                </button>
              ))}
            </div>
          )}
          {findQuery && findResults.length === 0 && (
            <p className="text-tiny text-muted">未找到匹配项。</p>
          )}
        </div>
      </Modal>

      {/* 设置单元格格式（WPS 对齐批2续）：Ctrl+1 经典聚合对话框，严禁 window.prompt/alert */}
      <Modal
        open={formatOpen}
        onClose={() => setFormatOpen(false)}
        title="设置单元格格式"
        width={460}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setFormatOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                applyCellStyle(cellStyle, borderColor);
                setFormatOpen(false);
              }}
            >
              确定
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 p-1">
          {/* 顶部页签 */}
          <div className="flex gap-1 border-b border-border pb-2">
            {(
              [
                { key: 'number', label: '数字' },
                { key: 'align', label: '对齐' },
                { key: 'font', label: '字体' },
                { key: 'fill', label: '填充' },
                { key: 'border', label: '边框' },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setFmtTab(t.key)}
                className={`rounded px-2 py-1 text-tiny transition-colors ${
                  fmtTab === t.key ? 'bg-hover text-accent' : 'text-muted hover:text-fg'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 数字 */}
          {fmtTab === 'number' && (
            <div className="flex flex-col gap-1.5">
              <span className="text-tiny text-muted">分类</span>
              <select
                className="w-full rounded border border-border bg-surface px-2 py-1 text-tiny text-fg"
                value={cellStyle.numFmt ?? ''}
                onChange={(e) => setCellStyle((s) => ({ ...s, numFmt: e.target.value || undefined }))}
              >
                <option value="">常规</option>
                <option value="0.00">数值 (0.00)</option>
                <option value="¥#,##0.00">货币 (¥#,##0.00)</option>
                <option value="¥#,##0.00">会计专用 (¥#,##0.00)</option>
                <option value="yyyy-mm-dd">日期 (yyyy-mm-dd)</option>
                <option value="hh:mm:ss">时间 (hh:mm:ss)</option>
                <option value="0.00%">百分比 (0.00%)</option>
                <option value="0.00E+00">科学计数 (0.00E+00)</option>
                <option value="@">文本 (@)</option>
              </select>
              <p className="text-tiny text-muted">当前格式：{cellStyle.numFmt || '常规'}</p>
            </div>
          )}

          {/* 对齐 */}
          {fmtTab === 'align' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="w-16 text-tiny text-muted">水平</span>
                <select
                  className="flex-1 rounded border border-border bg-surface px-2 py-1 text-tiny text-fg"
                  value={cellStyle.align ?? ''}
                  onChange={(e) =>
                    setCellStyle((s) => ({
                      ...s,
                      align: (e.target.value || undefined) as JkCellStyle['align'],
                    }))
                  }
                >
                  <option value="">默认</option>
                  <option value="left">左对齐</option>
                  <option value="center">居中</option>
                  <option value="right">右对齐</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 text-tiny text-muted">垂直</span>
                <select
                  className="flex-1 rounded border border-border bg-surface px-2 py-1 text-tiny text-fg"
                  value={cellStyle.valign ?? ''}
                  onChange={(e) =>
                    setCellStyle((s) => ({
                      ...s,
                      valign: (e.target.value || undefined) as JkCellStyle['valign'],
                    }))
                  }
                >
                  <option value="">默认</option>
                  <option value="top">顶端对齐</option>
                  <option value="middle">居中</option>
                  <option value="bottom">底端对齐</option>
                </select>
              </div>
              <label className="flex items-center gap-1.5 text-tiny text-fg">
                <input
                  type="checkbox"
                  checked={!!cellStyle.wrapText}
                  onChange={(e) => setCellStyle((s) => ({ ...s, wrapText: e.target.checked || undefined }))}
                />
                自动换行
              </label>
            </div>
          )}

          {/* 字体 */}
          {fmtTab === 'font' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="w-16 text-tiny text-muted">字体</span>
                <select
                  className="flex-1 rounded border border-border bg-surface px-2 py-1 text-tiny text-fg"
                  value={cellStyle.fontFamily ?? ''}
                  onChange={(e) => setCellStyle((s) => ({ ...s, fontFamily: e.target.value || undefined }))}
                >
                  <option value="">默认</option>
                  <option value="宋体">宋体</option>
                  <option value="黑体">黑体</option>
                  <option value="微软雅黑">微软雅黑</option>
                  <option value="楷体">楷体</option>
                  <option value="仿宋">仿宋</option>
                  <option value="等线">等线</option>
                  <option value="Arial">Arial</option>
                  <option value="Times New Roman">Times New Roman</option>
                  <option value="Calibri">Calibri</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 text-tiny text-muted">字号</span>
                <input
                  type="number"
                  min={8}
                  max={72}
                  className="w-24 rounded border border-border bg-surface px-2 py-1 text-tiny text-fg"
                  value={cellStyle.fontSize ?? ''}
                  onChange={(e) =>
                    setCellStyle((s) => ({
                      ...s,
                      fontSize: e.target.value ? Number(e.target.value) : undefined,
                    }))
                  }
                />
              </div>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-1.5 text-tiny text-fg">
                  <input
                    type="checkbox"
                    checked={!!cellStyle.bold}
                    onChange={(e) => setCellStyle((s) => ({ ...s, bold: e.target.checked || undefined }))}
                  />
                  加粗
                </label>
                <label className="flex items-center gap-1.5 text-tiny text-fg">
                  <input
                    type="checkbox"
                    checked={!!cellStyle.italic}
                    onChange={(e) => setCellStyle((s) => ({ ...s, italic: e.target.checked || undefined }))}
                  />
                  斜体
                </label>
                <label className="flex items-center gap-1.5 text-tiny text-fg">
                  <input
                    type="checkbox"
                    checked={!!cellStyle.underline}
                    onChange={(e) => setCellStyle((s) => ({ ...s, underline: e.target.checked || undefined }))}
                  />
                  下划线
                </label>
                <label className="flex items-center gap-1.5 text-tiny text-fg">
                  <input
                    type="checkbox"
                    checked={!!cellStyle.strike}
                    onChange={(e) => setCellStyle((s) => ({ ...s, strike: e.target.checked || undefined }))}
                  />
                  删除线
                </label>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 text-tiny text-muted">字体色</span>
                <input
                  type="color"
                  className="h-7 w-12 rounded border border-border bg-surface"
                  value={cellStyle.color ?? '#000000'}
                  onChange={(e) => setCellStyle((s) => ({ ...s, color: e.target.value || undefined }))}
                />
              </div>
            </div>
          )}

          {/* 填充 */}
          {fmtTab === 'fill' && (
            <div className="flex items-center gap-2">
              <span className="w-16 text-tiny text-muted">填充色</span>
              <input
                type="color"
                className="h-7 w-12 rounded border border-border bg-surface"
                value={cellStyle.bgColor ?? '#FFFFFF'}
                onChange={(e) => setCellStyle((s) => ({ ...s, bgColor: e.target.value || undefined }))}
              />
            </div>
          )}

          {/* 边框 */}
          {fmtTab === 'border' && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="w-16 text-tiny text-muted">样式</span>
                <select
                  className="flex-1 rounded border border-border bg-surface px-2 py-1 text-tiny text-fg"
                  value={borderChoice}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBorderChoice(v);
                    // 把下拉选项映射为 borders 布尔对象（"无" → undefined 表示不改边框）
                    const map: Record<string, JkCellStyle['borders'] | undefined> = {
                      none: undefined,
                      all: { top: true, right: true, bottom: true, left: true },
                      outside: { top: true, right: true, bottom: true, left: true },
                      top: { top: true },
                      bottom: { bottom: true },
                      left: { left: true },
                      right: { right: true },
                    };
                    setCellStyle((s) => ({ ...s, borders: map[v] }));
                  }}
                >
                  <option value="none">无</option>
                  <option value="all">全部框线</option>
                  <option value="outside">外边框</option>
                  <option value="top">上框线</option>
                  <option value="bottom">下框线</option>
                  <option value="left">左框线</option>
                  <option value="right">右框线</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 text-tiny text-muted">边框色</span>
                <input
                  type="color"
                  className="h-7 w-12 rounded border border-border bg-surface"
                  value={borderColor}
                  onChange={(e) => setBorderColor(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
