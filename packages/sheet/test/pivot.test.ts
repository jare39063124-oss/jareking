/**
 * Sheet 数据透视表聚合引擎 纯函数单测（WPS 对齐专项——数据透视表 MVP）。
 *
 * 覆盖：单行字段 sum / 多行字段多级分组 / 列字段横向展开 / count / avg /
 *      max+min / 空数据（含仅有表头）/ 非数字与千分位处理 / 无表头回退列名 /
 *      确定性（多次运行结果一致）。
 */
import { describe, it, expect } from 'vitest';
import { buildPivot, pivotToNumber, type PivotConfig } from '../src/pivot';

type Matrix = (string | number | boolean | null | undefined)[][];

describe('pivotToNumber', () => {
  it('number / boolean / 数字串 / 千分位 → 数字；其余 → null', () => {
    expect(pivotToNumber(12)).toBe(12);
    expect(pivotToNumber(true)).toBe(1);
    expect(pivotToNumber(false)).toBe(0);
    expect(pivotToNumber('3.5')).toBe(3.5);
    expect(pivotToNumber('1,234')).toBe(1234);
    expect(pivotToNumber('abc')).toBeNull();
    expect(pivotToNumber('')).toBeNull();
    expect(pivotToNumber(null)).toBeNull();
    expect(pivotToNumber(undefined)).toBeNull();
  });
});

describe('buildPivot', () => {
  it('单行字段 + sum：按行字段分组求和', () => {
    const m: Matrix = [
      ['区域', '金额'],
      ['东', 100],
      ['西', 200],
      ['东', 50],
    ];
    const cfg: PivotConfig = { rowFields: [0], values: [{ field: 1, agg: 'sum' }], hasHeader: true };
    const r = buildPivot(m, cfg);
    expect(r.header).toEqual(['区域', '金额 求和']);
    // 分组键字典序：东 < 西
    expect(r.rows).toEqual([
      ['东', 150],
      ['西', 200],
    ]);
  });

  it('多行字段：多级分组（按联合键字典序稳定排序）', () => {
    const m: Matrix = [
      ['区域', '城市', '金额'],
      ['东', '北京', 10],
      ['东', '上海', 20],
      ['西', '北京', 30],
    ];
    const cfg: PivotConfig = {
      rowFields: [0, 1],
      values: [{ field: 2, agg: 'sum' }],
      hasHeader: true,
    };
    const r = buildPivot(m, cfg);
    expect(r.header).toEqual(['区域', '城市', '金额 求和']);
    // 联合键 "东\u0001上海" < "东\u0001北京" < "西\u0001北京"
    expect(r.rows).toEqual([
      ['东', '上海', 20],
      ['东', '北京', 10],
      ['西', '北京', 30],
    ]);
  });

  it('带列字段：横向展开值字段（缺失组合聚合为 0）', () => {
    const m: Matrix = [
      ['区域', '季度', '金额'],
      ['东', 'Q1', 10],
      ['东', 'Q2', 20],
      ['西', 'Q1', 30],
    ];
    const cfg: PivotConfig = {
      rowFields: [0],
      colField: 1,
      values: [{ field: 2, agg: 'sum' }],
      hasHeader: true,
    };
    const r = buildPivot(m, cfg);
    expect(r.header).toEqual(['区域', 'Q1 求和', 'Q2 求和']);
    expect(r.rows).toEqual([
      ['东', 10, 20],
      ['西', 30, 0], // 西组无 Q2 → 0
    ]);
  });

  it('count：统计非空单元格（含文本，空串/null 不计）', () => {
    const m: Matrix = [
      ['类别', '值'],
      ['A', 1],
      ['A', 'x'],
      ['A', ''],
      ['B', null],
    ];
    const cfg: PivotConfig = { rowFields: [0], values: [{ field: 1, agg: 'count' }], hasHeader: true };
    const r = buildPivot(m, cfg);
    expect(r.header).toEqual(['类别', '值 计数']);
    expect(r.rows).toEqual([
      ['A', 2], // 1 与 'x' 非空；'' 不计
      ['B', 0], // 仅 null → 0
    ]);
  });

  it('avg：数值平均（非数字跳过）', () => {
    const m: Matrix = [
      ['类别', '值'],
      ['A', 10],
      ['A', 20],
      ['A', 30],
    ];
    const cfg: PivotConfig = { rowFields: [0], values: [{ field: 1, agg: 'avg' }], hasHeader: true };
    const r = buildPivot(m, cfg);
    expect(r.header).toEqual(['类别', '值 平均值']);
    expect(r.rows).toEqual([['A', 20]]);
  });

  it('max + min：同时产出两列聚合', () => {
    const m: Matrix = [
      ['类别', '值'],
      ['A', 10],
      ['A', 20],
      ['A', 30],
    ];
    const cfg: PivotConfig = {
      rowFields: [0],
      values: [
        { field: 1, agg: 'max' },
        { field: 1, agg: 'min' },
      ],
      hasHeader: true,
    };
    const r = buildPivot(m, cfg);
    expect(r.header).toEqual(['类别', '值 最大值', '值 最小值']);
    expect(r.rows).toEqual([['A', 30, 10]]);
  });

  it('空数据 → 空结果；仅有表头 → 表头保留、数据行为空', () => {
    const cfg: PivotConfig = { rowFields: [0], values: [{ field: 1, agg: 'sum' }], hasHeader: true };
    expect(buildPivot([], cfg)).toEqual({ header: [], rows: [] });

    const headerOnly: Matrix = [['区域', '金额']];
    expect(buildPivot(headerOnly, cfg)).toEqual({
      header: ['区域', '金额 求和'],
      rows: [],
    });
  });

  it('非数字与千分位：sum 跳过文本、解析千分位数字串', () => {
    const m: Matrix = [
      ['类别', '值'],
      ['A', '100'],
      ['A', 'abc'],
      ['A', '1,000'],
    ];
    const cfg: PivotConfig = { rowFields: [0], values: [{ field: 1, agg: 'sum' }], hasHeader: true };
    const r = buildPivot(m, cfg);
    expect(r.header).toEqual(['类别', '值 求和']);
    expect(r.rows).toEqual([['A', 1100]]); // 100 + 1000，'abc' 跳过
  });

  it('无表头（hasHeader=false）：字段名回退「列A/列B」记法，首行计入数据', () => {
    const m: Matrix = [
      [1, 10],
      [2, 20],
    ];
    const cfg: PivotConfig = { rowFields: [0], values: [{ field: 1, agg: 'sum' }], hasHeader: false };
    const r = buildPivot(m, cfg);
    expect(r.header).toEqual(['列A', '列B 求和']);
    expect(r.rows).toEqual([
      [1, 10],
      [2, 20],
    ]);
  });

  it('确定性：同一输入多次运行结果完全一致', () => {
    const m: Matrix = [
      ['区域', '季度', '金额'],
      ['东', 'Q2', 5],
      ['西', 'Q1', 7],
      ['东', 'Q1', 3],
      ['西', 'Q2', 9],
    ];
    const cfg: PivotConfig = {
      rowFields: [0],
      colField: 1,
      values: [{ field: 2, agg: 'sum' }],
      hasHeader: true,
    };
    const a = buildPivot(m, cfg);
    const b = buildPivot(m, cfg);
    expect(a).toEqual(b);
    expect(a.rows).toEqual([
      ['东', 3, 5],
      ['西', 7, 9],
    ]);
  });
});
