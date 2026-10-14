/**
 * univerAdapter 单元测试（T2.2 回归）：验证样式双向映射，不依赖 Univer 运行时。
 *
 * 覆盖：
 *  1. jkToUniverData 把 JkCell.style 登记进 styles 表、单元格以 s 引用（内容去重）；
 *  2. univerSnapshotToJk 回读 snapshot.styles[s] → JkCell.style（含各类样式字段）；
 *  3. jkToUniverData → 组装 snapshot → univerSnapshotToJk 闭环往返，样式不丢。
 */
import { describe, expect, it } from 'vitest';
import { jkToUniverData, univerSnapshotToJk } from './univerAdapter';
import type { JkCellStyle, JkWorkbook } from '@jareking/sheet';

const fullStyle: JkCellStyle = {
  bold: true,
  italic: true,
  underline: true,
  strike: true,
  color: '#FF0000',
  bgColor: '#00FF00',
  fontSize: 14,
  fontFamily: 'Arial',
  align: 'center',
  valign: 'middle',
  wrapText: true,
  numFmt: '0.00',
  borders: { top: true, left: true },
};

describe('jkToUniverData 写入样式', () => {
  it('有样式的单元格登记 styles 并以 s 引用', () => {
    const wb: JkWorkbook = {
      sheets: [
        {
          name: 'S1',
          rowCount: 10,
          colCount: 10,
          cells: {
            '0,0': { value: 'x', style: fullStyle },
            '1,1': { value: 42 },
          },
          merges: [],
        },
      ],
    };
    const univer = jkToUniverData(wb);
    const sheet = univer.sheets['sheet-01'];
    const c00 = sheet.cellData[0][0];
    expect(typeof c00.s).toBe('string');
    expect(univer.styles[c00.s]).toBeTruthy();
    // 无样式单元格不写入 s
    const c11 = sheet.cellData[1][1];
    expect(c11.s).toBeUndefined();
    // 样式表内容正确（Univer IStyleData 键）
    const s = univer.styles[c00.s];
    expect(s.bl).toBe(1);
    expect(s.it).toBe(1);
    expect(s.ul).toEqual({ s: 1 });
    expect(s.st).toEqual({ s: 1 });
    expect(s.cl).toEqual({ rgb: '#FF0000' });
    expect(s.bg).toEqual({ rgb: '#00FF00' });
    expect(s.fs).toBe(14);
    expect(s.ff).toBe('Arial');
    expect(s.ht).toBe('center');
    expect(s.vt).toBe('middle');
    expect(s.tb).toBe('wrap');
    expect(s.n).toEqual({ pattern: '0.00' });
    expect(s.bd).toEqual({ t: { s: 1, cl: { rgb: '#000000' } }, l: { s: 1, cl: { rgb: '#000000' } } });
  });

  it('相同内容样式去重复用同一 id', () => {
    const wb: JkWorkbook = {
      sheets: [
        {
          name: 'S1',
          rowCount: 10,
          colCount: 10,
          cells: {
            '0,0': { value: 'a', style: { bold: true } },
            '0,1': { value: 'b', style: { bold: true } },
          },
          merges: [],
        },
      ],
    };
    const univer = jkToUniverData(wb);
    const s1 = univer.sheets['sheet-01'].cellData[0][0].s;
    const s2 = univer.sheets['sheet-01'].cellData[0][1].s;
    expect(s1).toBe(s2);
    expect(Object.keys(univer.styles)).toHaveLength(1);
  });

  it('align=general 不写入 ht（Univer 无此枚举）', () => {
    const wb: JkWorkbook = {
      sheets: [
        { name: 'S1', rowCount: 5, colCount: 5, cells: { '0,0': { value: 'x', style: { align: 'general' } } }, merges: [] },
      ],
    };
    const univer = jkToUniverData(wb);
    expect(univer.styles[univer.sheets['sheet-01'].cellData[0][0].s].ht).toBeUndefined();
  });
});

describe('univerSnapshotToJk 回读样式', () => {
  it('从 styles 表回读各类样式字段', () => {
    const snapshot = {
      sheets: {
        'sheet-01': {
          name: 'S1',
          rowCount: 10,
          columnCount: 10,
          cellData: { 0: { 0: { v: 'x', s: 'jk-0' }, 1: { v: 1 } } },
        },
      },
      styles: {
        'jk-0': {
          bl: 1,
          it: 1,
          ul: { s: 1 },
          st: { s: 1 },
          cl: { rgb: '#FF0000' },
          bg: { rgb: '#00FF00' },
          fs: 14,
          ff: 'Arial',
          ht: 'center',
          vt: 'middle',
          tb: 'wrap',
          n: { pattern: '0.00' },
          bd: { t: { s: 1, cl: { rgb: '#000000' } }, l: { s: 1, cl: { rgb: '#000000' } } },
        },
      },
    };
    const jk = univerSnapshotToJk(snapshot as unknown as Record<string, never>);
    const cell = jk.sheets[0].cells['0,0'];
    expect(cell.style).toEqual(fullStyle);
    // 无样式单元格不派生空 style（行0列1）
    expect(jk.sheets[0].cells['0,1'].style).toBeUndefined();
  });

  it('内联样式对象（s 非 id）也可回读', () => {
    const snapshot = {
      sheets: {
        'sheet-01': { name: 'S1', rowCount: 5, columnCount: 5, cellData: { 0: { 0: { v: 'x', s: { bl: 1, fs: 20 } } } } },
      },
      styles: {},
    };
    const jk = univerSnapshotToJk(snapshot as unknown as Record<string, never>);
    expect(jk.sheets[0].cells['0,0'].style).toEqual({ bold: true, fontSize: 20 });
  });

  it('rgb() 颜色被规范为 #RRGGBB', () => {
    const snapshot = {
      sheets: { 'sheet-01': { name: 'S1', rowCount: 5, columnCount: 5, cellData: { 0: { 0: { v: 'x', s: 'jk-0' } } } } },
      styles: { 'jk-0': { cl: { rgb: 'rgb(255, 0, 0)' } } },
    };
    const jk = univerSnapshotToJk(snapshot as unknown as Record<string, never>);
    expect(jk.sheets[0].cells['0,0'].style?.color).toBe('#FF0000');
  });
});

describe('jkToUniverData → univerSnapshotToJk 闭环', () => {
  it('样式往返不丢字段', () => {
    const wb: JkWorkbook = {
      sheets: [
        {
          name: 'S1',
          rowCount: 10,
          colCount: 10,
          cells: {
            '0,0': { formula: 'SUM(A2:A3)', style: { bold: true, bgColor: '#ABCDEF', align: 'right' } },
            '1,0': { value: '普通' },
          },
          merges: [],
        },
      ],
    };
    const univer = jkToUniverData(wb);
    const snapshot = { sheets: univer.sheets, styles: univer.styles };
    const jk = univerSnapshotToJk(snapshot as unknown as Record<string, never>);
    const back = jk.sheets[0].cells['0,0'];
    expect(back.formula).toBe('SUM(A2:A3)');
    expect(back.style).toEqual({ bold: true, bgColor: '#ABCDEF', align: 'right' });
    // 普通单元格无 style
    expect(jk.sheets[0].cells['1,0'].style).toBeUndefined();
  });
});
