/**
 * Sheet ops Executor（T4.5）——把 Sheet Planner 的 ops 确定性应用到 Univer。
 *
 * 坐标：A1 记法（经 @jareking/sheet 的 parseA1Range 转换）；
 * 公式：op 不带 = 前缀，Univer setFormula 需要 = 前缀，在此补齐。
 * 单 op try/catch，失败跳过不中断。
 */
import type { FUniver } from '@univerjs/core';
import type { SheetOp } from '@jareking/ai';
import { parseA1Range } from '@jareking/sheet';

export interface SheetApplyResult {
  applied: string[];
  skipped: { op: string; reason: string }[];
}

export function applySheetOps(api: FUniver, ops: SheetOp[]): SheetApplyResult {
  const applied: string[] = [];
  const skipped: SheetApplyResult['skipped'] = [];

  const workbook = api.getActiveWorkbook();
  if (!workbook) {
    return { applied, skipped: ops.map((o) => ({ op: o.op, reason: '无活动工作簿' })) };
  }
  const sheet = workbook.getActiveSheet();

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'setFormula': {
          sheet.getRange(op.target).setFormula(`=${op.formula}`);
          applied.push(op.op);
          break;
        }
        case 'setValue': {
          sheet.getRange(op.target).setValue(op.value);
          applied.push(op.op);
          break;
        }
        case 'setValues': {
          const anchor = parseA1Range(op.startCell);
          if (!anchor) throw new Error(`startCell 无法解析: ${op.startCell}`);
          const rows = op.values.length;
          const cols = Math.max(...op.values.map((r) => r.length));
          const range = sheet.getRange(anchor.startRow, anchor.startCol, rows, cols);
          // 补齐行内短列（null 填充），满足 Univer 矩形要求
          const matrix = op.values.map((row) =>
            Array.from({ length: cols }, (_, i) => row[i] ?? null),
          );
          range.setValues(matrix);
          applied.push(op.op);
          break;
        }
        default: {
          skipped.push({ op: JSON.stringify(op).slice(0, 60), reason: '未知操作' });
        }
      }
    } catch (err) {
      skipped.push({ op: op.op, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { applied, skipped };
}
