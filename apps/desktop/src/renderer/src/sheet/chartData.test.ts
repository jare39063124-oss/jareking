/**
 * chartData 单元测试（Sheet「插入图表」T2.5）：矩阵 → 图表数据解析。
 * 纯函数，不依赖 Univer 运行时。
 */
import { describe, it, expect } from 'vitest';
import { buildChartData, toChartNumber, toChartLabel } from './chartData';

describe('toChartNumber', () => {
  it('number 原样，布尔转 1/0', () => {
    expect(toChartNumber(3.5)).toBe(3.5);
    expect(toChartNumber(true)).toBe(1);
    expect(toChartNumber(false)).toBe(0);
  });

  it('数字串（含千分位）可解析，非数字/空 → null', () => {
    expect(toChartNumber('1,200')).toBe(1200);
    expect(toChartNumber(' 42 ')).toBe(42);
    expect(toChartNumber('N/A')).toBeNull();
    expect(toChartNumber('')).toBeNull();
    expect(toChartNumber(null)).toBeNull();
    expect(toChartNumber(undefined)).toBeNull();
    expect(toChartNumber(Number.NaN)).toBeNull();
  });
});

describe('toChartLabel', () => {
  it('null/undefined → 空串，其余 String 化', () => {
    expect(toChartLabel(null)).toBe('');
    expect(toChartLabel(undefined)).toBe('');
    expect(toChartLabel(0)).toBe('0');
    expect(toChartLabel('Q1')).toBe('Q1');
  });
});

describe('buildChartData', () => {
  it('空矩阵 → 空数据', () => {
    expect(buildChartData([])).toEqual({ labels: [], series: [] });
    expect(buildChartData([[]])).toEqual({ labels: [], series: [] });
  });

  it('多列带表头：首行作系列名、首列作标签', () => {
    const d = buildChartData([
      ['季度', '营收', '成本'],
      ['Q1', 120, 80],
      ['Q2', 158, 90],
    ]);
    expect(d.labels).toEqual(['Q1', 'Q2']);
    expect(d.series).toEqual([
      { name: '营收', values: [120, 158] },
      { name: '成本', values: [80, 90] },
    ]);
  });

  it('多列无表头（首行数据列含数字）：整表作数据、系列名占位', () => {
    const d = buildChartData([
      [1, 10],
      [2, 20],
    ]);
    expect(d.labels).toEqual(['1', '2']);
    expect(d.series).toEqual([{ name: '系列1', values: [10, 20] }]);
  });

  it('单列纯数值：标签用行序，系列名「系列1」', () => {
    const d = buildChartData([[5], [8], [3]]);
    expect(d.labels).toEqual(['1', '2', '3']);
    expect(d.series).toEqual([{ name: '系列1', values: [5, 8, 3] }]);
  });

  it('单列首格为文本：作系列名', () => {
    const d = buildChartData([['销量'], [5], [8]]);
    expect(d.labels).toEqual(['1', '2']);
    expect(d.series).toEqual([{ name: '销量', values: [5, 8] }]);
  });

  it('非数字单元格下沉为 0，千分位数字串正常解析', () => {
    const d = buildChartData([
      ['品类', '数值'],
      ['A', '1,200'],
      ['B', 'N/A'],
    ]);
    expect(d.labels).toEqual(['A', 'B']);
    expect(d.series).toEqual([{ name: '数值', values: [1200, 0] }]);
  });

  it('标签为空时回退行号', () => {
    const d = buildChartData([
      ['名称', '值'],
      ['', 1],
      [null, 2],
    ]);
    expect(d.labels).toEqual(['1', '2']);
  });
});
