import { describe, expect, it } from 'vitest';
import { classify, makePseudoPath, parsePseudoPath } from './filePath';

describe('伪路径（Android 文件的稳定身份）', () => {
  it('生成后可原样解析回来', () => {
    const path = makePseudoPath('f-abc', '季度报告.docx');
    expect(parsePseudoPath(path)).toEqual({ id: 'f-abc', name: '季度报告.docx' });
  });

  it('文件名含空格 / # / ? / 斜杠时仍可还原（必须 encodeURIComponent）', () => {
    for (const name of ['my report 2026.docx', 'a#b?c&d.docx', 'weird/name.docx', '100%.xlsx']) {
      const parsed = parsePseudoPath(makePseudoPath('id1', name));
      expect(parsed?.name).toBe(name);
    }
  });

  it('非法百分号编码不抛异常（回落原串）', () => {
    expect(parsePseudoPath('jkfile://id1/100%')?.name).toBe('100%');
  });

  it('非本协议路径（桌面遗留 C:\\ 路径）返回 null', () => {
    expect(parsePseudoPath('C:\\Users\\a\\b.docx')).toBeNull();
    expect(parsePseudoPath('')).toBeNull();
  });

  it('缺少 id 或文件名的伪路径返回 null', () => {
    expect(parsePseudoPath('jkfile://')).toBeNull();
    expect(parsePseudoPath('jkfile://id-only')).toBeNull();
    expect(parsePseudoPath('jkfile:///name.docx')).toBeNull();
  });
});

describe('文件分类（模块/格式）', () => {
  it('四种格式映射正确，且演示模块为 slide（铁律：永不用 presentation）', () => {
    expect(classify('a.docx')).toEqual({ module: 'writer', format: 'docx' });
    expect(classify('a.xlsx')).toEqual({ module: 'sheet', format: 'xlsx' });
    expect(classify('a.pptx')).toEqual({ module: 'slide', format: 'pptx' });
    expect(classify('a.pdf')).toEqual({ module: 'pdf', format: 'pdf' });
  });

  it('大小写不敏感（Android 文件系统区分大小写）', () => {
    expect(classify('报表.XLSX').module).toBe('sheet');
    expect(classify('演示.PPTX').module).toBe('slide');
  });

  it('未知扩展名回落 Writer，由解析器给出真实诊断', () => {
    expect(classify('memo.txt')).toEqual({ module: 'writer', format: 'docx' });
    expect(classify('noext')).toEqual({ module: 'writer', format: 'docx' });
  });
});
