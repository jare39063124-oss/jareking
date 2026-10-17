/**
 * xlsx 解析器「包结构校验」回归单测（P1 缺陷守卫，2026-10-17）。
 *
 * 缺陷背景：exceljs 在 zip 内找不到 xl/workbook.xml 时**不报错**、直接回落为空簿；
 * 旧版 parseXlsx 又用「伪造一张 20×10 空表」兜底，导致用户打开误扩展名（docx/pptx）
 * 或已损坏的文件时只看到空白表、无任何报错 → 误判「文件是空的」并覆盖保存（数据丢失）。
 *
 * 本文件锁定三点：
 *   ① 传入 docx / pptx 字节（合法 zip，但无 xl/workbook.xml）→ 明确抛错，信息可读；
 *   ② 传入损坏/非 zip 字节（截断 zip / 纯文本 / 0 字节）→ 明确抛错；
 *   ③ 真正的 xlsx（多 sheet / 空表 / 隐藏表 / 公式 / 合并 / 样式）→ 照旧正确解析。
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseXlsx } from '../src/parser/xlsxParser';
import { exportXlsx } from '../src/exporter/index';
import type { JkWorkbook } from '../src/model/index';

/**
 * 构造一个最小但有代表性的 OOXML 包（docx 或 pptx）。
 *
 * 关键点：它是**合法的 zip**，只是包内没有 xl/workbook.xml——
 * 这正是旧版解析器会静默返回空簿的真实场景（误扩展名文件）。
 */
async function buildOoxml(kind: 'docx' | 'pptx'): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  );
  if (kind === 'docx') {
    // docx 的关键部件（parseDocx 也以此校验）
    zip.file(
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>',
    );
  } else {
    // pptx 的关键部件（parsePptx 也以此校验）
    zip.file(
      'ppt/presentation.xml',
      '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
    );
  }
  return zip.generateAsync({ type: 'uint8array' });
}

/** 构造一个含 xl/workbook.xml（通过结构校验）但 <sheets> 为空的工作簿包 */
async function buildEmptySheetsPackage(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
  );
  return zip.generateAsync({ type: 'uint8array' });
}

describe('parseXlsx：非 xlsx 文件必须明确抛错（不得静默返回空簿）', () => {
  it('docx 字节 → 抛错，信息指出缺少 xl/workbook.xml', async () => {
    const docx = await buildOoxml('docx');
    await expect(parseXlsx(docx)).rejects.toThrow(/xlsx/);
    await expect(parseXlsx(docx)).rejects.toThrow(/xl\/workbook\.xml/);
  });

  it('pptx 字节 → 抛错，信息指出不是有效 xlsx', async () => {
    const pptx = await buildOoxml('pptx');
    await expect(parseXlsx(pptx)).rejects.toThrow(/xlsx/);
    await expect(parseXlsx(pptx)).rejects.toThrow(/workbook\.xml/);
  });

  it('合法 zip 但缺少 xl/workbook.xml → 抛错', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'not a workbook');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    await expect(parseXlsx(bytes)).rejects.toThrow(/缺少 xl\/workbook\.xml/);
  });
});

describe('parseXlsx：损坏 / 非 zip 字节必须明确抛错', () => {
  it('截断的 xlsx（取前 60%）→ 抛错', async () => {
    const full = await exportXlsx({
      sheets: [
        {
          name: 'S',
          rowCount: 2,
          colCount: 2,
          cells: { '0,0': { value: 'A' }, '1,1': { value: 'B' } },
          merges: [],
        },
      ],
    });
    const cut = full.slice(0, Math.floor(full.length * 0.6));
    await expect(parseXlsx(cut)).rejects.toThrow(/xlsx/);
  });

  it('纯文本字节（非 zip）→ 抛错', async () => {
    const text = new TextEncoder().encode('这不是一个 xlsx 文件，只是一段普通文本。');
    await expect(parseXlsx(text)).rejects.toThrow(/不是有效的 xlsx 文件/);
  });

  it('0 字节 → 抛错（不挂起、不返回垃圾）', async () => {
    await expect(parseXlsx(new Uint8Array(0))).rejects.toThrow(/不是有效的 xlsx 文件/);
  });

  it('结构通过但工作簿内 0 张工作表 → 抛错（不伪造空表）', async () => {
    const bytes = await buildEmptySheetsPackage();
    await expect(parseXlsx(bytes)).rejects.toThrow(/未找到任何工作表/);
  });
});

describe('parseXlsx：真正的 xlsx 仍照旧正确解析（回归守卫）', () => {
  it('多 sheet + 隐藏表 + 空表 + 公式 + 合并 + 样式 → 字符级保真', async () => {
    const wb: JkWorkbook = {
      sheets: [
        {
          name: '数据',
          rowCount: 3,
          colCount: 3,
          cells: {
            '0,0': { value: '名称', style: { bold: true, bgColor: '#FFFF00', align: 'center' } },
            '0,1': { value: '数量' },
            '1,0': { value: '苹果' },
            '1,1': { value: 12 },
            // 公式：SUM(B2:B2)（0 基坐标 → B2）
            '2,2': { formula: 'SUM(B2:B2)' },
          },
          merges: [{ startRow: 0, startCol: 1, endRow: 0, endCol: 2 }],
        },
        // 真正的空表（无任何单元格）：必须原样解析出来，不能被当成「损坏」
        { name: '空表', rowCount: 20, colCount: 10, cells: {}, merges: [] },
        // 隐藏工作表：必须保留 hidden 标记
        { name: '隐藏', rowCount: 1, colCount: 1, cells: { '0,0': { value: 'secret' } }, merges: [], hidden: true },
      ],
      activeSheetIndex: 0,
    };
    const bytes = await exportXlsx(wb);
    const parsed = await parseXlsx(bytes);

    // sheet 数量与顺序
    expect(parsed.sheets.map((s) => s.name)).toEqual(['数据', '空表', '隐藏']);

    // 值
    expect(parsed.sheets[0].cells['0,0'].value).toBe('名称');
    expect(parsed.sheets[0].cells['1,1'].value).toBe(12);

    // 公式（不带 "="）
    expect(parsed.sheets[0].cells['2,2'].formula).toBe('SUM(B2:B2)');

    // 样式
    const style = parsed.sheets[0].cells['0,0'].style;
    expect(style?.bold).toBe(true);
    expect(style?.bgColor).toBe('#FFFF00');
    expect(style?.align).toBe('center');

    // 合并区域
    expect(parsed.sheets[0].merges).toHaveLength(1);
    expect(parsed.sheets[0].merges[0]).toMatchObject({
      startRow: 0,
      startCol: 1,
      endRow: 0,
      endCol: 2,
    });

    // 空表：无任何单元格，且**未被当成损坏文件**（照旧解析成功）。
    // 注：exceljs 对「无单元格的 <dimension>」不保留声明的网格尺寸（既有行为，非本次改动引入），
    // 故此处只断言可解析且 cells 为空，不硬编码 rowCount/colCount。
    expect(parsed.sheets[1].cells).toEqual({});
    expect(parsed.sheets[1].rowCount).toBeGreaterThanOrEqual(1);
    expect(parsed.sheets[1].colCount).toBeGreaterThanOrEqual(1);

    // 隐藏表标记
    expect(parsed.sheets[2].hidden).toBe(true);
    expect(parsed.sheets[2].cells['0,0'].value).toBe('secret');
  });

  it('真正的空工作簿（0 sheet 入参）导出后被补 1 张表，仍能解析', async () => {
    const bytes = await exportXlsx({ sheets: [] });
    const parsed = await parseXlsx(bytes);
    expect(parsed.sheets).toHaveLength(1);
    expect(parsed.sheets[0].cells).toEqual({});
  });

  it('ArrayBuffer 入参与 Uint8Array 入参结果一致', async () => {
    const bytes = await exportXlsx({
      sheets: [{ name: 'S', rowCount: 1, colCount: 1, cells: { '0,0': { value: 'x' } }, merges: [] }],
    });
    const fromU8 = await parseXlsx(bytes);
    // 精确切出独立 ArrayBuffer（Node Buffer 视图可能带 byteOffset）
    const ab = bytes.slice().buffer as ArrayBuffer;
    const fromAb = await parseXlsx(ab);
    expect(fromAb.sheets[0].cells['0,0'].value).toBe('x');
    expect(fromAb.sheets[0].cells).toEqual(fromU8.sheets[0].cells);
  });
});
