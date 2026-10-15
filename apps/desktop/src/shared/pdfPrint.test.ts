/**
 * pdfPrint.test.ts —— 打印管线共用纯函数验证（纸张规格 / 单位换算 / printToPDF 选项）。
 */
import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZE_MM,
  buildPrintToPdfOptions,
  mmToInches,
  mmToMicrons,
  normalizeMarginMm,
  resolvePageSizeMm,
} from './pdfPrint';

describe('PAGE_SIZE_MM（纸张规格单一事实源）', () => {
  it('规格值正确（毫米，纵向）', () => {
    expect(PAGE_SIZE_MM.A4).toEqual({ widthMm: 210, heightMm: 297 });
    expect(PAGE_SIZE_MM.A3).toEqual({ widthMm: 297, heightMm: 420 });
    expect(PAGE_SIZE_MM.B5).toEqual({ widthMm: 182, heightMm: 257 });
    expect(PAGE_SIZE_MM.Letter).toEqual({ widthMm: 215.9, heightMm: 279.4 });
    expect(PAGE_SIZE_MM.Legal).toEqual({ widthMm: 215.9, heightMm: 355.6 });
  });
});

describe('resolvePageSizeMm', () => {
  it('纵向：原样返回；横向：宽高互换', () => {
    expect(resolvePageSizeMm('A4', false)).toEqual({ widthMm: 210, heightMm: 297 });
    expect(resolvePageSizeMm('A4', true)).toEqual({ widthMm: 297, heightMm: 210 });
    expect(resolvePageSizeMm('Legal', true)).toEqual({ widthMm: 355.6, heightMm: 215.9 });
  });
});

describe('单位换算', () => {
  it('mmToMicrons：210mm → 210000 微米，四舍五入', () => {
    expect(mmToMicrons(210)).toBe(210000);
    expect(mmToMicrons(215.9)).toBe(215900);
    expect(mmToMicrons(0.0004)).toBe(0);
  });

  it('mmToInches：25.4mm → 1 英寸', () => {
    expect(mmToInches(25.4)).toBe(1);
    expect(mmToInches(0)).toBe(0);
  });
});

describe('normalizeMarginMm', () => {
  it('非法值（缺省 / NaN / 负数）回落默认 15，且钳制到 [0, 50]', () => {
    expect(normalizeMarginMm(undefined)).toBe(15);
    expect(normalizeMarginMm(Number.NaN)).toBe(15);
    expect(normalizeMarginMm(-5)).toBe(15);
    expect(normalizeMarginMm(120)).toBe(50);
    expect(normalizeMarginMm(0)).toBe(0);
    expect(normalizeMarginMm(20)).toBe(20);
  });
});

describe('buildPrintToPdfOptions', () => {
  it('默认：A4 / 纵向 / 15mm / printBackground=true / preferCSSPageSize=true（pageSize 单位=英寸）', () => {
    const opts = buildPrintToPdfOptions({ html: '<p>x</p>' });
    expect(opts.landscape).toBe(false);
    expect(opts.printBackground).toBe(true);
    expect(opts.preferCSSPageSize).toBe(true);
    // pageSize 为**英寸**（Chromium 会拒绝微米级对象尺寸）
    expect(opts.pageSize.width).toBeCloseTo(mmToInches(210), 10);
    expect(opts.pageSize.height).toBeCloseTo(mmToInches(297), 10);
    expect(opts.margins.top).toBeCloseTo(mmToInches(15), 10);
    expect(opts.margins.bottom).toBeCloseTo(mmToInches(15), 10);
    expect(opts.margins.left).toBeCloseTo(mmToInches(15), 10);
    expect(opts.margins.right).toBeCloseTo(mmToInches(15), 10);
  });

  it('显式传参：A3 横向 / 20mm → 宽高互换（英寸）+ margin 换算', () => {
    const opts = buildPrintToPdfOptions({
      html: '<p>x</p>',
      pageSize: 'A3',
      landscape: true,
      marginMm: 20,
    });
    expect(opts.landscape).toBe(true);
    expect(opts.pageSize.width).toBeCloseTo(mmToInches(420), 10);
    expect(opts.pageSize.height).toBeCloseTo(mmToInches(297), 10);
    expect(opts.margins.top).toBeCloseTo(mmToInches(20), 10);
  });

  it('pageSize 尺寸落在合法英寸区间（避免退回微米导致 printToPDF 失败）', () => {
    const opts = buildPrintToPdfOptions({ html: '<p>x</p>', pageSize: 'A4' });
    // A4 约 8.27in × 11.69in；若误用微米会得到 ~210000 的荒谬值
    expect(opts.pageSize.width).toBeGreaterThan(5);
    expect(opts.pageSize.width).toBeLessThan(15);
    expect(opts.pageSize.height).toBeGreaterThan(5);
    expect(opts.pageSize.height).toBeLessThan(20);
  });

  it('非法 marginMm 回落 15', () => {
    const opts = buildPrintToPdfOptions({ html: '<p>x</p>', marginMm: Number.NaN });
    expect(opts.margins.left).toBeCloseTo(mmToInches(15), 10);
  });
});
