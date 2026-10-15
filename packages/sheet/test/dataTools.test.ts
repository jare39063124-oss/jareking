/**
 * Sheet 数据处理工具（分列 / 删除重复项）纯函数单测。
 *
 * 覆盖：逗号 / 空格 / 多字符分隔符 / 超列数补空 / maxSplit / 表头保留 / 越界安全 /
 *      单关键列 / 多关键列 / 表头跳过去重 / 空值等价 / removed 计数 / 原数据不可变 /
 *      类型区分（数字 1 与文本 "1"）/ 布尔与不规则行归一等。
 */
import { describe, it, expect } from 'vitest';
import { splitColumn, removeDuplicates, type DataCellValue } from '../src/dataTools';

type Matrix = DataCellValue[][];

describe('splitColumn', () => {
  it('逗号分隔：把目标列拆成多列（无表头）', () => {
    const m: Matrix = [
      ['a,b'],
      ['c,d'],
    ];
    expect(splitColumn(m, 0, ',')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('空格 / 多字符分隔符：均按字面拆分', () => {
    expect(splitColumn([['x y z']], 0, ' ')).toEqual([['x', 'y', 'z']]);
    // 多字符分隔符 " -- " 整体作为一个分隔符处理
    expect(splitColumn([['p--q--r']], 0, '--')).toEqual([['p', 'q', 'r']]);
  });

  it('超列数补空：各行长度不等时统一补齐为等宽', () => {
    const m: Matrix = [
      ['a,b', 'k'],
      ['c', 'm'],
    ];
    // 行0 目标列拆为 ['a','b'] → ['a','b','k']（3 列）
    // 行1 目标列无分隔符 → ['c','m']（2 列）→ 补空到 3 列
    expect(splitColumn(m, 0, ',')).toEqual([
      ['a', 'b', 'k'],
      ['c', 'm', ''],
    ]);
  });

  it('maxSplit：限制最大段数，超出部分拼回最后一列', () => {
    expect(splitColumn([['a,b,c,d']], 0, ',', { maxSplit: 2 })).toEqual([['a', 'b,c,d']]);
    // maxSplit=1 → 不拆分（整串保留）
    expect(splitColumn([['a,b,c']], 0, ',', { maxSplit: 1 })).toEqual([['a,b,c']]);
  });

  it('表头保留：首行不参与拆分', () => {
    const m: Matrix = [
      ['名称', '内容'],
      ['a,b', 1],
    ];
    // 首行原样保留；因数据行拆为 3 列，表头补齐为等宽（末列补空）
    expect(splitColumn(m, 0, ',', { hasHeader: true })).toEqual([
      ['名称', '内容', ''],
      ['a', 'b', 1],
    ]);
  });

  it('安全兜底：目标列越界 / 分隔符为空 / 空矩阵 → 不崩，仅归一化原样返回', () => {
    const m: Matrix = [
      ['a,b', 1],
      ['c,d', true],
    ];
    // 越界列（2 ≥ 列数 2）→ 原样（数字保留、布尔归一为 'true'）
    expect(splitColumn(m, 2, ',')).toEqual([
      ['a,b', 1],
      ['c,d', 'true'],
    ]);
    // 空分隔符 → 不拆分
    expect(splitColumn([['a,b']], 0, '')).toEqual([['a,b']]);
    // 空矩阵
    expect(splitColumn([], 0, ',')).toEqual([]);
  });
});

describe('removeDuplicates', () => {
  it('单关键列：保留首次出现，removed 计数正确', () => {
    const m: Matrix = [
      ['A', 1],
      ['B', 2],
      ['A', 3],
      ['B', 4],
    ];
    const r = removeDuplicates(m, [0]);
    expect(r.rows).toEqual([
      ['A', 1],
      ['B', 2],
    ]);
    expect(r.removed).toBe(2);
  });

  it('多关键列：组合键去重（任一列不同即视为不同行）', () => {
    const m: Matrix = [
      ['A', 1],
      ['A', 2],
      ['A', 1],
      ['B', 1],
    ];
    const r = removeDuplicates(m, [0, 1]);
    expect(r.rows).toEqual([
      ['A', 1],
      ['A', 2],
      ['B', 1],
    ]);
    expect(r.removed).toBe(1);
  });

  it('表头：首行原样保留，不参与去重、不计入 removed', () => {
    const m: Matrix = [
      ['名称', '值'],
      ['A', 1],
      ['A', 2],
    ];
    const r = removeDuplicates(m, [0], { hasHeader: true });
    expect(r.rows).toEqual([
      ['名称', '值'],
      ['A', 1],
    ]);
    expect(r.removed).toBe(1);
  });

  it('空值：null / undefined / 空串视为相同（等价去重）', () => {
    const m: Matrix = [[null], [undefined], [''], ['x']];
    const r = removeDuplicates(m, [0]);
    expect(r.rows).toEqual([[''], ['x']]);
    expect(r.removed).toBe(2);
  });

  it('类型区分：数字 1 与文本 "1" 视为不同（不误去重）', () => {
    const m: Matrix = [[1], ['1']];
    const r = removeDuplicates(m, [0]);
    expect(r.removed).toBe(0);
    expect(r.rows).toEqual([[1], ['1']]);
  });

  it('无关键列 / 空矩阵：不去重、removed = 0', () => {
    expect(removeDuplicates([['A'], ['A']], []).removed).toBe(0);
    expect(removeDuplicates([], [0])).toEqual({ rows: [], removed: 0 });
  });

  it('原数据不被修改（不可变）', () => {
    const m: Matrix = [['A'], ['A'], ['A']];
    const snapshot = JSON.stringify(m);
    const r = removeDuplicates(m, [0]);
    expect(r.removed).toBe(2);
    expect(r.rows).toEqual([['A']]);
    // 入参保持原样
    expect(JSON.stringify(m)).toBe(snapshot);
  });

  it('布尔 / 不规则行：归一化并补齐为等宽', () => {
    const m: Matrix = [[true, 'k'], [true], [false, 'm', 9]];
    const r = removeDuplicates(m, [0]);
    // true 行重复被移除；输出等宽为 3 列
    expect(r.rows).toEqual([
      ['true', 'k', ''],
      ['false', 'm', 9],
    ]);
    expect(r.removed).toBe(1);
  });

  it('确定性：同一输入多次运行结果完全一致', () => {
    const m: Matrix = [
      [1, 'a'],
      [2, 'b'],
      [1, 'a'],
      [3, 'c'],
    ];
    const a = removeDuplicates(m, [0, 1]);
    const b = removeDuplicates(m, [0, 1]);
    expect(a).toEqual(b);
    expect(a.rows).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
  });
});
