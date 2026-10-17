// @vitest-environment node
/**
 * 平台适配层公共工具单测（macOS 版新增）。
 *
 * `withPdfExtension` / `resolveOutputPath` 是 Windows（COM）与 macOS（LibreOffice）
 * 两条转换链路**共用**的输出路径推导逻辑——一旦两端各写一份，就会出现
 * 「Windows 输出到 a/b.pdf、mac 输出到 a/b (1).pdf」这类难查的差异，故锁死行为。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveOutputPath, withPdfExtension } from './common';

describe('withPdfExtension（同目录换 .pdf 后缀）', () => {
  it('常规扩展名替换', () => {
    expect(withPdfExtension(join('/tmp', '报告.docx'))).toBe(join('/tmp', '报告.pdf'));
    expect(withPdfExtension(join('/tmp', '台账.xlsx'))).toBe(join('/tmp', '台账.pdf'));
    expect(withPdfExtension(join('/tmp', '方案.pptx'))).toBe(join('/tmp', '方案.pdf'));
  });

  it('文件名内含点号：只替换最后一段扩展名', () => {
    expect(withPdfExtension(join('/tmp', '报告.v2.docx'))).toBe(join('/tmp', '报告.v2.pdf'));
  });

  it('无扩展名：追加 .pdf', () => {
    expect(withPdfExtension(join('/tmp', 'README'))).toBe(join('/tmp', 'README.pdf'));
  });

  it('隐藏文件（首个字符即点）：不把点当扩展名分隔符以外的情况误判', () => {
    // '.hidden' 的 lastIndexOf('.') === 0 → 视为无扩展名，追加 .pdf
    expect(withPdfExtension(join('/tmp', '.hidden'))).toBe(join('/tmp', '.hidden.pdf'));
  });

  it('保留原目录（不做相对化/绝对化）', () => {
    expect(withPdfExtension('rel/dir/a.docx')).toBe(join('rel/dir', 'a.pdf'));
  });
});

describe('resolveOutputPath（显式优先，否则推导）', () => {
  it('传入非空 outputPath 时原样使用', () => {
    expect(resolveOutputPath('/tmp/a.docx', '/out/custom.pdf')).toBe('/out/custom.pdf');
  });

  it('未传 / 传空串 / 传 undefined 时按输入推导', () => {
    expect(resolveOutputPath('/tmp/a.docx')).toBe(join('/tmp', 'a.pdf'));
    expect(resolveOutputPath('/tmp/a.docx', '')).toBe(join('/tmp', 'a.pdf'));
    expect(resolveOutputPath('/tmp/a.docx', undefined)).toBe(join('/tmp', 'a.pdf'));
  });
});
