/**
 * officePdfScript.test.ts —— Office → PDF PowerShell 脚本生成器（纯函数）验证。
 *
 * 真实 COM 转换需要本机安装 WPS/Microsoft Office，无头/沙箱环境无法实测；
 * 因此以「脚本字符串内容」的强断言作为本轮硬验证手段：
 * 覆盖 ProgID 选择、导出调用、错误提示、路径转义、收尾标记。
 */
import { describe, expect, it } from 'vitest';
import { buildOfficePdfScript, type OfficePdfScriptOptions } from './officePdfScript';

/** 生成一份默认（Word）脚本，按需覆盖字段 */
function gen(overrides: Partial<OfficePdfScriptOptions> = {}): string {
  return buildOfficePdfScript({
    kind: 'word',
    inputPath: 'C:\\docs\\report.docx',
    outputPath: 'C:\\docs\\report.pdf',
    ...overrides,
  });
}

describe('buildOfficePdfScript（Office → PDF PowerShell 脚本生成器）', () => {
  it('出错即停 + 收尾标记：含 $ErrorActionPreference = Stop 与 JK_PDF_DONE', () => {
    const script = gen();
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain('Write-Output "JK_PDF_DONE"');
  });

  it('Word：Office 优先 + WPS 备选，导出用 ExportAsFixedFormat，结束 Quit', () => {
    const script = gen({ kind: 'word' });
    expect(script).toContain('Word.Application');
    expect(script).toContain('KWPS.Application');
    expect(script).toContain('ExportAsFixedFormat');
    expect(script).toContain('$doc.ExportAsFixedFormat($outPath, 17)');
    expect(script).toContain('wdExportFormatPDF');
    expect(script).toContain('$app.Quit()');
  });

  it('Excel：含 Excel.Application 与 WPS KET/et 备选及 xlTypePDF', () => {
    const script = gen({ kind: 'excel' });
    expect(script).toContain('Excel.Application');
    expect(script).toContain('KET.Application');
    expect(script).toContain('et.Application');
    expect(script).toContain('ExportAsFixedFormat');
    expect(script).toContain('$wb.ExportAsFixedFormat(0, $outPath)');
    expect(script).toContain('xlTypePDF');
  });

  it('PPT：含 PowerPoint.Application 与 WPS KWPP/wpp 备选及 ppFixedFormatTypePDF', () => {
    const script = gen({ kind: 'ppt' });
    expect(script).toContain('PowerPoint.Application');
    expect(script).toContain('KWPP.Application');
    expect(script).toContain('wpp.Application');
    expect(script).toContain('ExportAsFixedFormat');
    expect(script).toContain('$pres.ExportAsFixedFormat($outPath, 2)');
    expect(script).toContain('ppFixedFormatTypePDF');
  });

  it('ProgID 全不可用时抛出「未检测到 WPS/Office」错误', () => {
    const script = gen();
    expect(script).toContain('未检测到 WPS/Office');
    expect(script).toContain('throw');
  });

  it('路径转义：含空格与单引号的路径被单引号包裹且单引号翻倍', () => {
    const script = gen({
      inputPath: "C:\\My Docs\\it's.docx",
      outputPath: "C:\\My Docs\\it's.pdf",
    });
    // 单引号字符串字面量：原 ' 转义为 ''
    expect(script).toContain("$inPath = 'C:\\My Docs\\it''s.docx'");
    expect(script).toContain("$outPath = 'C:\\My Docs\\it''s.pdf'");
  });

  it('中文/特殊字符路径按字面量保留（单引号内无需额外转义）', () => {
    const script = gen({
      kind: 'excel',
      inputPath: 'D:\\工作\\2024 年度-报表(终版).xlsx',
      outputPath: 'D:\\工作\\2024 年度-报表(终版).pdf',
    });
    expect(script).toContain("$inPath = 'D:\\工作\\2024 年度-报表(终版).xlsx'");
    expect(script).toContain("$outPath = 'D:\\工作\\2024 年度-报表(终版).pdf'");
  });

  it('输入输出路径均写入脚本（供执行器定位产物）', () => {
    const script = gen({ kind: 'ppt', inputPath: 'C:\\deck.pptx', outputPath: 'C:\\deck.pdf' });
    expect(script).toContain("$inPath = 'C:\\deck.pptx'");
    expect(script).toContain("$outPath = 'C:\\deck.pdf'");
  });
});
