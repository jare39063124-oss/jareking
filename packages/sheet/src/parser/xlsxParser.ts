/**
 * T2.1 xlsx 解析器：exceljs → JkWorkbook。
 *
 * 覆盖：多 sheet（含隐藏）/ 值与公式 / 合并单元格 / 列宽行高 /
 * 冻结窗格 / 基础单元格样式（字面样式，忽略主题样式）。
 * 样式细节（渐变填充、主题色、富文本片段、图表、数据验证等）
 * v1 降级忽略，不阻断打开。
 */
import ExcelJS from 'exceljs';
import type { JkCell, JkCellStyle, JkSheet, JkWorkbook } from '../model/index.js';
import { parseA1Range } from '../model/index.js';

/** ARGB（exceljs，含 FF 前缀）→ #RRGGBB */
function argbToHex(argb: unknown): string | undefined {
  if (typeof argb !== 'string') return undefined;
  const hex = argb.replace(/^FF/i, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : undefined;
}

/** exceljs 边框样式对象 → 是否有可见线 */
function hasBorderLine(b: unknown): boolean {
  if (!b || typeof b !== 'object') return false;
  const style = (b as { style?: string }).style;
  return !!style && style !== 'none';
}

/** exceljs 字体/填充/对齐/边框/数字格式 → JkCellStyle */
function parseStyle(cell: ExcelJS.Cell): JkCellStyle | undefined {
  const s: JkCellStyle = {};
  const font = cell.font;
  if (font) {
    if (font.bold) s.bold = true;
    if (font.italic) s.italic = true;
    if (font.underline) s.underline = true;
    if (font.strike) s.strike = true;
    if (font.size) s.fontSize = font.size;
    if (font.name) s.fontFamily = font.name;
    const color = argbToHex((font.color as { argb?: string } | undefined)?.argb);
    if (color) s.color = color;
  }
  const fill = cell.fill as { pattern?: string; fgColor?: { argb?: string } } | undefined;
  if (fill && fill.pattern === 'solid') {
    const bg = argbToHex(fill.fgColor?.argb);
    if (bg) s.bgColor = bg;
  }
  const align = cell.alignment;
  if (align) {
    if (align.horizontal) s.align = align.horizontal as JkCellStyle['align'];
    if (align.vertical) s.valign = align.vertical as JkCellStyle['valign'];
    if (align.wrapText) s.wrapText = true;
  }
  const border = cell.border;
  if (border) {
    const b = {
      top: hasBorderLine(border.top),
      right: hasBorderLine(border.right),
      bottom: hasBorderLine(border.bottom),
      left: hasBorderLine(border.left),
    };
    if (Object.values(b).some(Boolean)) s.borders = b;
  }
  if (cell.numFmt && cell.numFmt !== 'General') s.numFmt = cell.numFmt;

  return Object.keys(s).length ? s : undefined;
}

/** exceljs cell.value → JkCell（值 + 公式 + 样式） */
function parseCell(cell: ExcelJS.Cell | undefined): JkCell | undefined {
  const out: JkCell = {};
  let hasContent = false;

  const v = cell?.value;
  if (v !== null && v !== undefined) {
    if (typeof v === 'object' && !Array.isArray(v)) {
      const vo = v as { formula?: string; result?: unknown; richText?: unknown };
      if (typeof vo.formula === 'string') {
        out.formula = vo.formula.replace(/^=/, '');
        hasContent = true;
      }
      if (vo.result !== undefined && vo.result !== null) {
        out.value = vo.result as JkCell['value'];
        hasContent = true;
      }
      if (!hasContent && vo.richText) {
        // 富文本降级：拼接纯文本
        const rt = vo.richText as { text?: string }[];
        out.value = rt.map((r) => r.text ?? '').join('');
        hasContent = true;
      }
      // 其它对象型值（日期对象/超链接/共享公式等）降级为文本
      if (!hasContent) {
        if (v instanceof Date) {
          out.value = v.toISOString().slice(0, 10);
          hasContent = true;
        } else if ('text' in vo && typeof (vo as { text?: unknown }).text === 'string') {
          out.value = (vo as { text: string }).text;
          hasContent = true;
        } else if ('richText' in vo) {
          // 已处理
        } else {
          out.value = String(v);
          hasContent = true;
        }
      }
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out.value = v;
      hasContent = true;
    }
  }

  const style = cell ? parseStyle(cell) : undefined;
  if (style) {
    out.style = style;
    hasContent = true;
  }

  return hasContent ? out : undefined;
}

/** exceljs worksheet → JkSheet */
function parseWorksheet(ws: ExcelJS.Worksheet): JkSheet {
  const cells: JkSheet['cells'] = {};
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const parsed = parseCell(cell);
      if (parsed) cells[`${rowNumber - 1},${colNumber - 1}`] = parsed;
    });
  });

  // 合并区域（exceljs 内部 model.merges 为 "A1:B2" 数组；model 未初始化时为 null）
  const merges = ((ws.model as { merges?: string[] } | null | undefined)?.merges ?? [])
    .map((ref) => parseA1Range(ref))
    .filter((m): m is NonNullable<typeof m> => !!m);

  // 列宽：exceljs width 为字符数 → px ≈ round(7 * chars + 5)
  const colWidths: Record<number, number> = {};
  ws.columns.forEach((col, idx) => {
    if (col?.width) colWidths[idx] = Math.round(col.width * 7 + 5);
  });

  // 行高：exceljs height 为点数 → px = round(pt * 4 / 3)
  const rowHeights: Record<number, number> = {};
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (row?.height) rowHeights[rowNumber - 1] = Math.round((row.height * 4) / 3);
  });

  // 冻结窗格（views 未设置时 exceljs 返回 null）
  let freeze: JkSheet['freeze'];
  const frozenView = (ws.views ?? []).find((v) => v.state === 'frozen') as
    | { xSplit?: number; ySplit?: number }
    | undefined;
  if (frozenView) {
    freeze = {};
    if (frozenView.ySplit) freeze.row = frozenView.ySplit;
    if (frozenView.xSplit) freeze.col = frozenView.xSplit;
    if (!Object.keys(freeze).length) freeze = undefined;
  }

  return {
    name: ws.name,
    rowCount: Math.max(ws.rowCount, 1),
    colCount: Math.max(ws.columnCount, 1),
    cells,
    merges,
    colWidths: Object.keys(colWidths).length ? colWidths : undefined,
    rowHeights: Object.keys(rowHeights).length ? rowHeights : undefined,
    freeze,
    hidden: ws.state === 'hidden' ? true : undefined,
  };
}

/** 解析 xlsx 字节流 → JkWorkbook */
export async function parseXlsx(buffer: Uint8Array | ArrayBuffer): Promise<JkWorkbook> {
  const wb = new ExcelJS.Workbook();
  // 拷贝为独立 ArrayBuffer（exceljs load 接受 ArrayBuffer；避免 SharedArrayBuffer 视图）
  const u8 = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const data = u8.slice().buffer as ArrayBuffer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(data as any);

  const sheets = wb.worksheets.map(parseWorksheet);
  if (!sheets.length) {
    sheets.push({
      name: 'Sheet1',
      rowCount: 20,
      colCount: 10,
      cells: {},
      merges: [],
    });
  }

  const view = wb.views?.[0] as { activeTab?: number } | undefined;
  return {
    sheets,
    activeSheetIndex: view?.activeTab ?? 0,
    creator: wb.creator ?? undefined,
    createdAt: wb.created ? new Date(wb.created).toISOString() : undefined,
    fidelity: { level: 'L2', notes: ['富文本/图表/数据验证/主题样式未完整还原（v1 L2）'] },
  };
}

/** 从文件路径读取并解析 xlsx（Node / Electron 主进程） */
export async function parseXlsxFile(path: string): Promise<JkWorkbook> {
  const fs = (await import('node:fs/promises')) as { readFile: (p: string) => Promise<Buffer> };
  const buf = await fs.readFile(path);
  return parseXlsx(new Uint8Array(buf));
}
