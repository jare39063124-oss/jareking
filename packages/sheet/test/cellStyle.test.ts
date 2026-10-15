/**
 * 单元格样式规整 纯函数单测（WPS 对齐专项——设置单元格格式对话框）。
 *
 * 覆盖：normalizeColor 各种形态 → #RRGGBB / 非法 → undefined；
 *      normalizeCellStyle 空串 / 非法色 / NaN 字号 / 全 false 边框 → undefined；
 *      合法输入原样保留。
 */
import { describe, it, expect } from 'vitest';
import { normalizeColor, normalizeCellStyle } from '../src/cellStyle';
import type { JkCellStyle } from '../src/model/index';

describe('normalizeColor', () => {
  it('#RGB 三位缩写为 #RRGGBB', () => {
    expect(normalizeColor('#abc')).toBe('#AABBCC');
    expect(normalizeColor('#aBc')).toBe('#AABBCC');
  });

  it('#RRGGBB / #rrggbb 规整为大写 #RRGGBB', () => {
    expect(normalizeColor('#abcdef')).toBe('#ABCDEF');
    expect(normalizeColor('#ABCDEF')).toBe('#ABCDEF');
  });

  it('#RRGGBBAA 丢弃 alpha → #RRGGBB', () => {
    expect(normalizeColor('#11223344')).toBe('#112233');
  });

  it('rgb() / rgba() → #RRGGBB', () => {
    expect(normalizeColor('rgb(255, 0, 0)')).toBe('#FF0000');
    expect(normalizeColor('rgba(0,128,255,0.5)')).toBe('#0080FF');
  });

  it('{ rgb: "#..." } 对象取出内部值', () => {
    expect(normalizeColor({ rgb: '#123456' })).toBe('#123456');
    expect(normalizeColor({ rgb: '#abc' })).toBe('#AABBCC');
  });

  it('空值 / 空白 → undefined', () => {
    expect(normalizeColor('')).toBeUndefined();
    expect(normalizeColor('   ')).toBeUndefined();
    expect(normalizeColor(null)).toBeUndefined();
    expect(normalizeColor(undefined)).toBeUndefined();
  });

  it('具名色 / 非法值 → undefined（不污染）', () => {
    expect(normalizeColor('red')).toBeUndefined();
    expect(normalizeColor('not-a-color')).toBeUndefined();
    expect(normalizeColor(123 as unknown)).toBeUndefined();
  });
});

describe('normalizeCellStyle', () => {
  it('颜色空串 → 不写该字段', () => {
    expect(normalizeCellStyle({ color: '' })).toEqual({});
  });

  it('非法颜色（具名色） → 不写该字段', () => {
    expect(normalizeCellStyle({ color: 'red' })).toEqual({});
  });

  it('合法颜色各种形态 → #RRGGBB', () => {
    expect(normalizeCellStyle({ color: '#abc' })).toEqual({ color: '#AABBCC' });
    expect(normalizeCellStyle({ bgColor: 'rgb(0,0,0)' })).toEqual({ bgColor: '#000000' });
    expect(normalizeCellStyle({ color: { rgb: '#123456' } as unknown as string })).toEqual({
      color: '#123456',
    });
  });

  it('fontSize 非有限数字（NaN / 字符串）→ undefined', () => {
    expect(normalizeCellStyle({ fontSize: NaN })).toEqual({});
    expect(normalizeCellStyle({ fontSize: '12' as unknown as number })).toEqual({});
    expect(normalizeCellStyle({ fontSize: 14 })).toEqual({ fontSize: 14 });
  });

  it('borders 全 false / 空 → undefined', () => {
    expect(normalizeCellStyle({ borders: { top: false, right: false, bottom: false, left: false } })).toEqual({});
    expect(normalizeCellStyle({ borders: {} })).toEqual({});
  });

  it('borders 仅保留为 true 的边', () => {
    const r = normalizeCellStyle({ borders: { top: true, right: false, bottom: true, left: false } });
    expect(r.borders).toEqual({ top: true, bottom: true });
  });

  it('numFmt：常规 / 空 → undefined；合法格式原样保留', () => {
    expect(normalizeCellStyle({ numFmt: '' })).toEqual({});
    expect(normalizeCellStyle({ numFmt: 'General' })).toEqual({});
    expect(normalizeCellStyle({ numFmt: '0.00' })).toEqual({ numFmt: '0.00' });
    expect(normalizeCellStyle({ numFmt: '¥#,##0.00' })).toEqual({ numFmt: '¥#,##0.00' });
  });

  it('align / valign：空串 / general → undefined；合法值保留', () => {
    expect(normalizeCellStyle({ align: '' })).toEqual({});
    expect(normalizeCellStyle({ align: 'general' })).toEqual({});
    expect(normalizeCellStyle({ align: 'center' })).toEqual({ align: 'center' });
    expect(normalizeCellStyle({ valign: 'middle' })).toEqual({ valign: 'middle' });
  });

  it('布尔样式：false → 不写；true → 保留', () => {
    expect(normalizeCellStyle({ bold: false, italic: true, underline: true })).toEqual({
      italic: true,
      underline: true,
    });
    expect(normalizeCellStyle({ wrapText: true })).toEqual({ wrapText: true });
  });

  it('合法组合输入原样（含多字段）保留', () => {
    const input: Partial<JkCellStyle> = {
      bold: true,
      align: 'center',
      numFmt: '0.00%',
      fontFamily: '宋体',
      fontSize: 11,
    };
    const r = normalizeCellStyle(input);
    expect(r).toEqual({
      bold: true,
      align: 'center',
      numFmt: '0.00%',
      fontFamily: '宋体',
      fontSize: 11,
    });
  });

  it('未设置的空对象 → 返回空 JkCellStyle', () => {
    expect(normalizeCellStyle({})).toEqual({});
  });
});
