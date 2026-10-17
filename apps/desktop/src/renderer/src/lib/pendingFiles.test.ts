/**
 * 外部文件打开的单测（macOS 版新增）。
 *
 * 只测纯函数部分（扩展名 → 模块、文件名提取）：
 *  - **演示必须映射为 'slide'**（AGENTS 铁律 1.1 的真实踩坑点——历史 bug 就是
 *    `'presentation'` 与 `'slide'` 双源导致「最近使用」里 PPT 打不开）；
 *  - 大小写混写（`.DOCX`）必须识别（macOS/Windows 用户输入不可控）；
 *  - 不支持的类型返回 null（由调用方过滤，不静默当成 writer）。
 */
import { describe, expect, it } from 'vitest';
import { baseNameOf, moduleFromPath } from './pendingFiles';

describe('moduleFromPath（扩展名 → 模块）', () => {
  it('Writer 系：doc / docx', () => {
    expect(moduleFromPath('/Users/a/报告.docx')).toBe('writer');
    expect(moduleFromPath('/Users/a/旧稿.doc')).toBe('writer');
  });

  it('Sheet 系：xls / xlsx', () => {
    expect(moduleFromPath('/Users/a/台账.xlsx')).toBe('sheet');
    expect(moduleFromPath('/Users/a/旧表.xls')).toBe('sheet');
  });

  it('演示系：ppt / pptx 必须映射为 slide（不是 presentation）', () => {
    expect(moduleFromPath('/Users/a/方案.pptx')).toBe('slide');
    expect(moduleFromPath('/Users/a/旧演示.ppt')).toBe('slide');
  });

  it('PDF', () => {
    expect(moduleFromPath('/Users/a/合同.pdf')).toBe('pdf');
  });

  it('大小写混写可识别', () => {
    expect(moduleFromPath('/Users/a/A.DOCX')).toBe('writer');
    expect(moduleFromPath('/Users/a/B.XLSX')).toBe('sheet');
    expect(moduleFromPath('/Users/a/C.PPTX')).toBe('slide');
    expect(moduleFromPath('/Users/a/D.PDF')).toBe('pdf');
  });

  it('不支持的类型返回 null（不静默回落成 writer）', () => {
    expect(moduleFromPath('/Users/a/note.txt')).toBeNull();
    expect(moduleFromPath('/Users/a/archive.zip')).toBeNull();
    expect(moduleFromPath('/Users/a/README')).toBeNull();
  });

  it('路径中含点号也能正确取最后一段扩展名', () => {
    expect(moduleFromPath('/Users/a/报告.v2.docx')).toBe('writer');
    expect(moduleFromPath('/Users/a/my.folder/file.pptx')).toBe('slide');
  });
});

describe('baseNameOf（文件名提取）', () => {
  it('POSIX 路径', () => {
    expect(baseNameOf('/Users/a/报告.docx')).toBe('报告.docx');
  });

  it('Windows 路径（反斜杠）', () => {
    expect(baseNameOf('C:\\Users\\a\\报告.docx')).toBe('报告.docx');
  });

  it('无分隔符时原样返回', () => {
    expect(baseNameOf('报告.docx')).toBe('报告.docx');
  });

  it('混合分隔符取最后一个', () => {
    expect(baseNameOf('/Volumes/USB\\报表.xlsx')).toBe('报表.xlsx');
  });
});
