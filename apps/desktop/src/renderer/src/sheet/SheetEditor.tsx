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
import { exportXlsx, parseXlsx, sheetToCsv, type JkWorkbook } from '@jareking/sheet';
import type { FUniver } from '@univerjs/core';
import { Download, FileSpreadsheet, FolderOpen, RefreshCw } from 'lucide-react';

import { Button } from '../components/Button';
import { toast } from '../stores/toastStore';
import { jkToUniverData, univerSnapshotToJk } from './univerAdapter';

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

export function SheetEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  // univerAPI 持有在 ref（非 state）：实例方法不参与渲染
  const apiRef = useRef<FUniver | null>(null);
  const [ready, setReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || apiRef.current) return;

    const { univer, univerAPI } = createUniver({
      locale: 'zh-CN',
      locales: {
        'zh-CN': Object.assign(
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
    univerAPI.createWorkbook(jkToUniverData(demoWorkbook()) as Parameters<
      typeof univerAPI.createWorkbook
    >[0]);
    apiRef.current = univerAPI;
    setReady(true);

    return () => {
      univer.dispose();
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
      const wb = await parseXlsx(buf);
      apiRef.current?.createWorkbook(jkToUniverData(wb) as Parameters<
        NonNullable<typeof apiRef.current>['createWorkbook']
      >[0]);
      toast.success(`已打开 ${file.name}`);
    } catch {
      toast.warning('打开失败：文件可能不是有效的 .xlsx');
    }
  };

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
    apiRef.current?.createWorkbook(jkToUniverData(demoWorkbook()) as Parameters<
      NonNullable<typeof apiRef.current>['createWorkbook']
    >[0]);
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
        <span className="ml-2 text-xs text-text-secondary">
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
