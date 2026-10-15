/**
 * Sheet 查找/替换 纯函数单测（WPS 对齐批3续）。
 *
 * 覆盖：区分/不区分大小写、全字匹配、数字匹配、公式单元格跳过、
 *      不可变（原 wb 不被修改）。
 */
import { describe, it, expect } from 'vitest';
import { findCells, replaceCells } from '../src/findReplace';
import type { JkWorkbook } from '../src/model/index';

/** 多 sheet + 字符串/数字/公式 混合工作簿 */
function makeWorkbook(): JkWorkbook {
  return {
    sheets: [
      {
        name: 'Sheet1',
        rowCount: 10,
        colCount: 10,
        cells: {
          '0,0': { value: 'Hello World' },
          '0,1': { value: 'hello' },
          '1,0': { value: 199 },
          '1,1': { value: 'HELLO' },
          '2,0': { formula: 'SUM(A1:A2)' },
          '2,1': { value: 'total' },
        },
        merges: [],
      },
      {
        name: 'Sheet2',
        rowCount: 10,
        colCount: 10,
        cells: {
          '0,0': { value: 'hello there' },
          '0,1': { value: 200 },
        },
        merges: [],
      },
    ],
    activeSheetIndex: 0,
  };
}

describe('findCells', () => {
  it('默认不区分大小写：命中所有含目标子串的单元格', () => {
    const wb = makeWorkbook();
    const r = findCells(wb, 'hello');
    // Hello World(0,0) / hello(0,1) / HELLO(1,1) / hello there(Sheet2 0,0)
    expect(r).toHaveLength(4);
    expect(r.map((x) => `${x.sheetIndex},${x.row},${x.col}`).sort()).toEqual(
      ['0,0,0', '0,0,1', '0,1,1', '1,0,0'].sort(),
    );
  });

  it('matchCase=true：仅命中大小写完全一致者', () => {
    const wb = makeWorkbook();
    const r = findCells(wb, 'hello', { matchCase: true });
    expect(r.map((x) => `${x.sheetIndex},${x.row},${x.col}`).sort()).toEqual(
      ['0,0,1', '1,0,0'].sort(),
    );
  });

  it('wholeCell=true：仅整单元格相等者命中（不区分大小写）', () => {
    const wb = makeWorkbook();
    const r = findCells(wb, 'hello', { wholeCell: true });
    // 'hello'(0,1) 与 'HELLO'(1,1) 整单元格相等（不区分大小写）；'hello there'/'Hello World' 不等
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ sheetIndex: 0, row: 0, col: 1, value: 'hello' });
    expect(r[1]).toMatchObject({ sheetIndex: 0, row: 1, col: 1, value: 'HELLO' });
  });

  it('数字单元格按 String(num) 匹配', () => {
    const wb = makeWorkbook();
    const r = findCells(wb, '199');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ sheetIndex: 0, row: 1, col: 0, value: '199' });
  });

  it('公式单元格纳入查找匹配（按公式串）', () => {
    const wb = makeWorkbook();
    const r = findCells(wb, 'SUM');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ sheetIndex: 0, row: 2, col: 0, value: 'SUM(A1:A2)' });
  });

  it('空查询返回空', () => {
    expect(findCells(makeWorkbook(), '')).toHaveLength(0);
  });
});

describe('replaceCells', () => {
  it('全部替换纯 value 单元格（不区分大小写），count 正确且原 wb 不被修改', () => {
    const wb = makeWorkbook();
    const snapshotBefore = JSON.stringify(wb);
    const { wb: next, count } = replaceCells(wb, 'hello', 'hi');
    // 命中 4 个纯 value 单元格（公式单元格跳过）
    expect(count).toBe(4);
    // 原 wb 完全不变（不可变）
    expect(JSON.stringify(wb)).toBe(snapshotBefore);
    // 新 wb 已替换
    const c00 = next.sheets[0].cells['0,0'];
    const c01 = next.sheets[0].cells['0,1'];
    const c11 = next.sheets[0].cells['1,1'];
    const s20 = next.sheets[1].cells['0,0'];
    // 不区分大小写子串替换：'hello' → 'hi'（保留原大小写语境，仅替换命中片段）
    expect(c00.value).toBe('hi World');
    expect(c01.value).toBe('hi');
    expect(c11.value).toBe('hi');
    expect(s20.value).toBe('hi there');
  });

  it('公式单元格不被替换（v1：跳过，保持原公式结构）', () => {
    const wb = makeWorkbook();
    const { wb: next, count } = replaceCells(wb, 'SUM', 'AVERAGE');
    expect(count).toBe(0);
    // 公式单元格保持原样
    expect(next.sheets[0].cells['2,0']).toEqual({ formula: 'SUM(A1:A2)' });
  });

  it('区分大小写替换只影响大小写一致的子串', () => {
    const wb = makeWorkbook();
    const { wb: next, count } = replaceCells(wb, 'hello', 'X', { matchCase: true });
    // 仅 'hello'(0,1) 与 'hello there'(Sheet2 0,0) 含大小写一致的 'hello' 子串；
    // 'Hello World'/'HELLO' 不命中
    expect(count).toBe(2);
    expect(next.sheets[0].cells['0,1'].value).toBe('X');
    expect(next.sheets[1].cells['0,0'].value).toBe('X there');
  });

  it('wholeCell 替换数字单元格', () => {
    const wb = makeWorkbook();
    const { wb: next, count } = replaceCells(wb, '199', '200', { wholeCell: true });
    expect(count).toBe(1);
    expect(next.sheets[0].cells['1,0'].value).toBe('200');
  });

  it('未命中时返回内容等价的工作簿，且原 wb 不被修改（不可变）', () => {
    const wb = makeWorkbook();
    const snapshot = JSON.stringify(wb);
    const { wb: next, count } = replaceCells(wb, 'zzz', 'q');
    expect(count).toBe(0);
    // 原 wb 完全不变
    expect(JSON.stringify(wb)).toBe(snapshot);
    // 返回的工作簿内容与原工作簿一致
    expect(JSON.stringify(next)).toBe(snapshot);
  });
});
