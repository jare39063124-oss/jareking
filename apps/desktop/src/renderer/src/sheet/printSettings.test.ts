/**
 * printSettings.test.ts —— Sheet「打印设置」模型/解析纯函数验证（默认值/容错/记法解析）。
 *
 * 覆盖：默认值、normalizeSheetPrintSettings 的 null/空对象/脏字段/非法 marginMm 兜底与钳制、
 * parsePrintArea 的多种记法与归一/非法、parseRepeatRows 的行号与 A1 记法/非法。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHEET_PRINT_SETTINGS,
  formatRangeA1,
  normalizeMarginForConfirm,
  normalizeSheetPrintSettings,
  parsePrintArea,
  parseRepeatRows,
} from './printSettings';

describe('DEFAULT_SHEET_PRINT_SETTINGS', () => {
  it('默认：A4 / 纵向 / 15mm / 无区域 / 无重复行 / 非仅活动表', () => {
    expect(DEFAULT_SHEET_PRINT_SETTINGS).toEqual({
      pageSize: 'A4',
      landscape: false,
      marginMm: 15,
      printArea: null,
      repeatRows: null,
      activeOnly: false,
    });
  });
});

describe('normalizeSheetPrintSettings', () => {
  it('null / undefined → 全部回落默认', () => {
    expect(normalizeSheetPrintSettings(null)).toEqual(DEFAULT_SHEET_PRINT_SETTINGS);
    expect(normalizeSheetPrintSettings(undefined)).toEqual(DEFAULT_SHEET_PRINT_SETTINGS);
  });

  it('空对象 → 全部回落默认', () => {
    expect(normalizeSheetPrintSettings({})).toEqual(DEFAULT_SHEET_PRINT_SETTINGS);
  });

  it('脏字段（非法纸张名 / 非布尔 / 非字符串区域）逐个回落默认', () => {
    const out = normalizeSheetPrintSettings({
      pageSize: 'A99',
      landscape: 'yes',
      printArea: 123,
      repeatRows: {},
      activeOnly: 1,
    });
    expect(out.pageSize).toBe('A4');
    expect(out.landscape).toBe(false);
    expect(out.printArea).toBeNull();
    expect(out.repeatRows).toBeNull();
    expect(out.activeOnly).toBe(false);
  });

  it('合法字段原样保留（含 trim 文本与布尔）', () => {
    const out = normalizeSheetPrintSettings({
      pageSize: 'B5',
      landscape: true,
      marginMm: 10,
      printArea: '  A1:C20  ',
      repeatRows: '1:2',
      activeOnly: true,
    });
    expect(out).toEqual({
      pageSize: 'B5',
      landscape: true,
      marginMm: 10,
      printArea: 'A1:C20',
      repeatRows: '1:2',
      activeOnly: true,
    });
  });

  it('空白字符串区域 → null', () => {
    const out = normalizeSheetPrintSettings({ printArea: '   ', repeatRows: '' });
    expect(out.printArea).toBeNull();
    expect(out.repeatRows).toBeNull();
  });

  it('marginMm 非法值兜底：负数 → 15；NaN → 15；字符串 → 15', () => {
    expect(normalizeSheetPrintSettings({ marginMm: -5 }).marginMm).toBe(15);
    expect(normalizeSheetPrintSettings({ marginMm: Number.NaN }).marginMm).toBe(15);
    expect(normalizeSheetPrintSettings({ marginMm: 'abc' }).marginMm).toBe(15);
  });

  it('marginMm 超上限钳制：999 → 50；区间内保留', () => {
    expect(normalizeSheetPrintSettings({ marginMm: 999 }).marginMm).toBe(50);
    expect(normalizeSheetPrintSettings({ marginMm: 0 }).marginMm).toBe(0);
    expect(normalizeSheetPrintSettings({ marginMm: 22.5 }).marginMm).toBe(22.5);
  });
});

describe('parsePrintArea', () => {
  it("'A1:C20' → 行列闭区间（0 基）", () => {
    expect(parsePrintArea('A1:C20')).toEqual({
      startRow: 0,
      startCol: 0,
      endRow: 19,
      endCol: 2,
    });
  });

  it("'C5' → 单格区域", () => {
    expect(parsePrintArea('C5')).toEqual({ startRow: 4, startCol: 2, endRow: 4, endCol: 2 });
  });

  it("'A1' → 单格区域", () => {
    expect(parsePrintArea('A1')).toEqual({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 });
  });

  it("小写 'b2:d4' → 正常解析", () => {
    expect(parsePrintArea('b2:d4')).toEqual({ startRow: 1, startCol: 1, endRow: 3, endCol: 3 });
  });

  it("反序 'C3:A1' → 自动归一（start<=end）", () => {
    expect(parsePrintArea('C3:A1')).toEqual({ startRow: 0, startCol: 0, endRow: 2, endCol: 2 });
  });

  it("非法 'abc' / '' → null", () => {
    expect(parsePrintArea('abc')).toBeNull();
    expect(parsePrintArea('')).toBeNull();
  });

  it('行号/列号 < 1（如 A0）→ null（不得产出负索引）', () => {
    expect(parsePrintArea('A0')).toBeNull();
    expect(parsePrintArea('A0:C1')).toBeNull();
    expect(parsePrintArea('A1:A0')).toBeNull();
  });
});

describe('parseRepeatRows', () => {
  it("'1:2' → 行 0..1", () => {
    expect(parseRepeatRows('1:2')).toEqual({ startRow: 0, endRow: 1 });
  });

  it("'2:2' → 行 1..1", () => {
    expect(parseRepeatRows('2:2')).toEqual({ startRow: 1, endRow: 1 });
  });

  it("'1' → 行 0..0", () => {
    expect(parseRepeatRows('1')).toEqual({ startRow: 0, endRow: 0 });
  });

  it("'$1:$2' → 绝对引用行 0..1", () => {
    expect(parseRepeatRows('$1:$2')).toEqual({ startRow: 0, endRow: 1 });
  });

  it("兼容 A1 区域记法 'A1:D2' → 取其行范围 0..1", () => {
    expect(parseRepeatRows('A1:D2')).toEqual({ startRow: 0, endRow: 1 });
  });

  it('反序行号归一：\'3:1\' → 行 0..2', () => {
    expect(parseRepeatRows('3:1')).toEqual({ startRow: 0, endRow: 2 });
  });

  it("非法（'' / 'abc' / '0' / 越界字母） → null", () => {
    expect(parseRepeatRows('')).toBeNull();
    expect(parseRepeatRows('abc')).toBeNull();
    expect(parseRepeatRows('0')).toBeNull();
    expect(parseRepeatRows('a')).toBeNull();
  });

  it('行号 < 1（A1 记法分支 A0 / 数字记法 1:0）→ null（不得产出负索引）', () => {
    expect(parseRepeatRows('A0')).toBeNull();
    expect(parseRepeatRows('A0:B2')).toBeNull();
    expect(parseRepeatRows('1:0')).toBeNull();
  });
});

describe('normalizeMarginForConfirm', () => {
  it('合法数字原样保留（区间内）', () => {
    expect(normalizeMarginForConfirm(10)).toBe(10);
    expect(normalizeMarginForConfirm(0)).toBe(0);
    expect(normalizeMarginForConfirm(22.5)).toBe(22.5);
  });

  it('负数 / NaN / 非法字符串 → 默认 15', () => {
    expect(normalizeMarginForConfirm(-5)).toBe(15);
    expect(normalizeMarginForConfirm(Number.NaN)).toBe(15);
    expect(normalizeMarginForConfirm('abc')).toBe(15);
    expect(normalizeMarginForConfirm(undefined)).toBe(15);
    expect(normalizeMarginForConfirm('')).toBe(15);
  });

  it('超上限钳制 999 → 50；数字字符串按数值处理', () => {
    expect(normalizeMarginForConfirm(999)).toBe(50);
    expect(normalizeMarginForConfirm('999')).toBe(50);
    expect(normalizeMarginForConfirm('12')).toBe(12);
  });
});

describe('formatRangeA1', () => {
  it('单格 → A1；多格 → A1:C20', () => {
    expect(formatRangeA1({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toBe('A1');
    expect(formatRangeA1({ startRow: 0, startCol: 0, endRow: 19, endCol: 2 })).toBe('A1:C20');
  });
});
