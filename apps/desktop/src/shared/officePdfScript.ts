/**
 * Office → PDF 转换的 PowerShell 脚本生成器（纯函数，无副作用）。
 *
 * 设计要点（对齐 jareking「WPS 平替 · PDF 卖点 · 纯本地零服务端」约束）：
 *  - 通过本机已装的 WPS / Microsoft Office 的 **COM 自动化组件**把 Word/Excel/PPT
 *    另存为 PDF，纯本地执行、零成本、零服务端；
 *  - 「脚本生成」与「脚本执行」解耦：本文件只负责拼字符串，绝不 import electron /
 *    child_process 等仅主进程可用的模块，因此可在 Node / vitest 下纯测（真实 COM
 *    调用需要本机装 Office/WPS，无头/沙箱环境无法实测，故以本文件单测作为硬验证）；
 *  - Excel 的 ProgID 有 `KET.Application`（新版）与 `et.Application`（旧版）两种；
 *    PowerPoint 同理有 `KWPP.Application`（新版）与 `wpp.Application`（旧版），
 *    故备选链按「新版优先、旧版兜底」顺序全部尝试。
 */

/** Office 文档大类（决定选用哪套 COM ProgID 与导出参数） */
export type OfficeKind = 'word' | 'excel' | 'ppt';

/** 生成脚本所需的参数 */
export interface OfficePdfScriptOptions {
  /** 文档大类 */
  kind: OfficeKind;
  /** 输入文档的绝对路径（Word/Excel/PPT 原件） */
  inputPath: string;
  /** 目标 PDF 的绝对路径 */
  outputPath: string;
}

/** 单类文档的 COM 组件与导出参数规格 */
interface OfficeScriptSpec {
  /** 依次尝试的 COM ProgID：Microsoft Office 优先，WPS 备选（含旧版别名） */
  progIds: string[];
  /** ProgID 选择说明（写入脚本注释，便于用户排查） */
  progComment: string;
  /** 打开文档并绑定到代表文档的变量（PowerShell 语句） */
  openLine: string;
  /** 代表文档的变量名（Word: $doc / Excel: $wb / PPT: $pres） */
  docVar: string;
  /** 导出 PDF 方法说明（写入脚本注释，含枚举全名） */
  exportComment: string;
  /** 导出 PDF 的调用（PowerShell 语句，指向预声明的 $outPath） */
  exportLine: string;
  /** 关闭文档（不保存，避免改动原件） */
  closeLine: string;
}

/**
 * 各类文档的 COM 规格表。
 * 导出参数用「数字常量 + 枚举全名注释」：PowerShell 默认不引用 Office 的 PIA
 * （Microsoft.Office.Interop.{Word,Excel,PowerPoint}），枚举名在裸 PS 会话不可解析，
 * 故统一用等价数字常量，并在注释里标明对应枚举，兼顾可读性与健壮性。
 */
const OFFICE_SPECS: Record<OfficeKind, OfficeScriptSpec> = {
  word: {
    // WPS 文字：新版 KWPS.Application；旧版亦作 wps.Application
    progIds: ['Word.Application', 'KWPS.Application', 'wps.Application'],
    progComment: 'Word：Office=Word.Application，WPS=KWPS.Application（旧版 wps.Application）',
    // Documents.Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
    openLine: '$doc = $app.Documents.Open($inPath, $false, $true, $false)',
    docVar: '$doc',
    // 17 = wdExportFormatPDF（[Microsoft.Office.Interop.Word.WdExportFormat]::wdExportFormatPDF）
    exportComment: '17 = wdExportFormatPDF（枚举 Microsoft.Office.Interop.Word.WdExportFormat）',
    exportLine: '$doc.ExportAsFixedFormat($outPath, 17)',
    closeLine: '$doc.Close($false)',
  },
  excel: {
    // WPS 表格：新版 KET.Application；旧版亦作 et.Application
    progIds: ['Excel.Application', 'KET.Application', 'et.Application'],
    progComment: 'Excel：Office=Excel.Application，WPS=KET.Application（旧版 et.Application）',
    // Workbooks.Open(Filename, UpdateLinks, ReadOnly)
    openLine: '$wb = $app.Workbooks.Open($inPath, 0, $true)',
    docVar: '$wb',
    // 0 = xlTypePDF（[Microsoft.Office.Interop.Excel.XlFixedFormatType]::xlTypePDF）
    exportComment: '0 = xlTypePDF（枚举 Microsoft.Office.Interop.Excel.XlFixedFormatType）',
    exportLine: '$wb.ExportAsFixedFormat(0, $outPath)',
    closeLine: '$wb.Close($false)',
  },
  ppt: {
    // WPS 演示：新版 KWPP.Application；旧版亦作 wpp.Application
    progIds: ['PowerPoint.Application', 'KWPP.Application', 'wpp.Application'],
    progComment: 'PPT：Office=PowerPoint.Application，WPS=KWPP.Application（旧版 wpp.Application）',
    // Presentations.Open(FileName, ReadOnly, Untitled, WithWindow) —— WithWindow=false 静默
    openLine: '$pres = $app.Presentations.Open($inPath, $true, $false, $false)',
    docVar: '$pres',
    // 2 = ppFixedFormatTypePDF（[Microsoft.Office.Interop.PowerPoint.PpFixedFormatType]::ppFixedFormatTypePDF）
    exportComment: '2 = ppFixedFormatTypePDF（枚举 Microsoft.Office.Interop.PowerPoint.PpFixedFormatType）',
    exportLine: '$pres.ExportAsFixedFormat($outPath, 2)',
    closeLine: '$pres.Close()',
  },
};

/**
 * 把任意路径转成 PowerShell 单引号字符串字面量（最安全的转义方式）。
 * 单引号字符串内除 `'` 外无任何需转义字符（`$`、`\\`、空格、中文均按字面量处理），
 * 故只需把 `'` 翻倍为 `''`，即可保证含空格/中文/特殊字符的路径不崩。
 */
function psQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 生成「依次尝试多个 COM ProgID」的 PowerShell 片段。
 * 语义等价于「先试 Office，失败再试 WPS，都失败则抛错」，但用数组 + 循环
 * 表达更清晰、更易扩展，且顺序即优先级。
 */
function buildProgIdAcquire(progIds: string[]): string {
  const list = progIds.map((id) => psQuote(id)).join(', ');
  return [
    `$progIds = @(${list})`,
    '',
    '$app = $null',
    'foreach ($progId in $progIds) {',
    '  try {',
    '    $app = New-Object -ComObject $progId',
    '    if ($app) { break }',
    '  } catch {',
    '    $app = $null',
    '  }',
    '}',
    'if (-not $app) {',
    "  throw '未检测到 WPS/Office（COM 组件不可用），请确认已安装 Microsoft Office 或 WPS Office 后重试'",
    '}',
  ].join('\n');
}

/**
 * 生成一段完整的 PowerShell 脚本：用本机 WPS/Office 把输入文档导出为 PDF。
 *
 * @param opts 转换参数（文档大类 + 输入路径 + 输出路径）
 * @returns 可直接落盘为 .ps1 并由 `powershell.exe -File` 执行的脚本字符串
 */
export function buildOfficePdfScript(opts: OfficePdfScriptOptions): string {
  const spec = OFFICE_SPECS[opts.kind];
  const inPath = psQuote(opts.inputPath);
  const outPath = psQuote(opts.outputPath);

  const lines = [
    '# jareking Office → PDF 转换脚本（由 buildOfficePdfScript 生成，请勿手改）',
    '# 原理：调用本机 WPS / Microsoft Office 的 COM 自动化组件导出 PDF，纯本地、零服务端。',
    "$ErrorActionPreference = 'Stop'",
    '',
    `$inPath = ${inPath}`,
    `$outPath = ${outPath}`,
    '',
    `# ProgID 选择：${spec.progComment}`,
    buildProgIdAcquire(spec.progIds),
    '',
    'try {',
    '  # 后台静默运行、抑制交互弹窗（个别组件不支持该属性则忽略）',
    '  try { $app.Visible = $false } catch { }',
    '  try { $app.DisplayAlerts = 0 } catch { }',
    '',
    '  # 只读方式打开原件，避免改动源文件',
    `  ${spec.openLine}`,
    '',
    `  # 导出为 PDF：${spec.exportComment}`,
    `  ${spec.exportLine}`,
    '',
    '  # 关闭文档（不保存）',
    `  ${spec.closeLine}`,
    '} finally {',
    '  # 无论成败都退出进程并释放 COM，避免残留 WINWORD/EXCEL 进程',
    '  try { $app.Quit() } catch { }',
    '  try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null } catch { }',
    '}',
    '',
    'Write-Output "JK_PDF_DONE"',
    '',
  ];

  return lines.join('\n');
}
