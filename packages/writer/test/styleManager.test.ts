/**
 * styleManager 纯函数单测（Writer 样式管理器）。
 *
 * 覆盖：
 *  1. groupStyles：按 styleType 分组、分组顺序、组内按名排序、不改动入参
 *  2. makeUniqueStyleId：无冲突/单冲突/多冲突后缀 + slug 规范化
 *  3. cloneStyleDef：清 styleId/名称、复制属性（font 深拷贝）、isDefault 置 false
 *  4. resolveParagraphAttrs：沿 basedOn 链合并（继承 + 覆盖 + font 合并）
 *  5. resolveParagraphAttrs：环引用不崩溃、不死循环
 *  6. resolveParagraphAttrs：缺失样式 / 未提供样式表时返回空属性
 */

import { describe, it, expect } from 'vitest';

import {
  cloneStyleDef,
  groupStyles,
  makeUniqueStyleId,
  resolveParagraphAttrs,
} from '../src/styleManager.js';
import type { StyleDef, StyleSheet } from '../src/model/document.js';

/** 便捷构造 StyleDef */
function def(partial: Partial<StyleDef> & Pick<StyleDef, 'styleId' | 'styleType'>): StyleDef {
  return { type: 'styleDef', ...partial };
}

describe('styleManager', () => {
  it('1. groupStyles：按 styleType 分组并排序，且不改动入参', () => {
    const sheet: StyleSheet = {
      styles: [
        def({ styleId: 'P1', styleType: 'paragraph', name: 'CCC' }),
        def({ styleId: 'T1', styleType: 'table', name: 'MMM' }),
        def({ styleId: 'P2', styleType: 'paragraph', name: 'AAA' }),
        def({ styleId: 'C1', styleType: 'character', name: 'ZZZ' }),
        def({ styleId: 'P3', styleType: 'paragraph', name: 'BBB' }),
      ],
    };

    const groups = groupStyles(sheet);

    // 分组顺序：段落 → 字符 → 表格（空分组「编号样式」不输出）
    expect(groups.map((g) => g.group)).toEqual(['段落样式', '字符样式', '表格样式']);
    // 组内按显示名升序
    expect(groups[0].styles.map((s) => s.name)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(groups[1].styles.map((s) => s.styleId)).toEqual(['C1']);
    expect(groups[2].styles.map((s) => s.styleId)).toEqual(['T1']);

    // 入参顺序未被就地排序改动
    expect(sheet.styles.map((s) => s.styleId)).toEqual(['P1', 'T1', 'P2', 'C1', 'P3']);

    // 未提供样式表时返回空数组
    expect(groupStyles(undefined)).toEqual([]);
    expect(groupStyles({ styles: [] })).toEqual([]);
  });

  it('2. makeUniqueStyleId：slug 规范化 + 冲突数字后缀', () => {
    // 无冲突：直接使用 slug
    expect(makeUniqueStyleId('标题', [])).toBe('标题');
    // 单冲突：追加 1
    expect(makeUniqueStyleId('标题', ['标题'])).toBe('标题1');
    // 多冲突：递增到首个空位
    expect(makeUniqueStyleId('标题', ['标题', '标题1'])).toBe('标题2');
    // 空白/标点被剥除
    expect(makeUniqueStyleId('My Style!', [])).toBe('MyStyle');
    // 全为标点时回退默认 slug
    expect(makeUniqueStyleId('!!!', [])).toBe('JkStyle');
  });

  it('3. cloneStyleDef：清 styleId/名称、复制属性（font 深拷贝）、isDefault 置 false', () => {
    const src = def({
      styleId: 'Src',
      styleType: 'paragraph',
      name: '来源',
      isDefault: true,
      pPr: { jc: 'center' },
      rPr: { bold: true, size: 24, font: { eastAsia: '宋体' } },
    });

    const created = cloneStyleDef(src, '新样式', 'paragraph');

    // styleId 被清空（由调用方用 makeUniqueStyleId 赋值）
    expect(created.styleId).toBe('');
    expect(created.name).toBe('新样式');
    expect(created.styleType).toBe('paragraph');
    expect(created.isDefault).toBe(false);

    // 属性被复制
    expect(created.pPr).toEqual({ jc: 'center' });
    expect(created.rPr?.bold).toBe(true);
    expect(created.rPr?.size).toBe(24);
    expect(created.rPr?.font?.eastAsia).toBe('宋体');
    // font 为深拷贝，不与来源共享引用
    expect(created.rPr?.font).not.toBe(src.rPr?.font);

    // 无来源时返回干净骨架
    const empty = cloneStyleDef(undefined, 'X', 'character');
    expect(empty.styleId).toBe('');
    expect(empty.name).toBe('X');
    expect(empty.styleType).toBe('character');
    expect(empty.pPr).toBeUndefined();
    expect(empty.rPr).toBeUndefined();
  });

  it('4. resolveParagraphAttrs：沿 basedOn 链合并（继承 + 覆盖 + font 合并）', () => {
    const sheet: StyleSheet = {
      styles: [
        def({
          styleId: 'Base',
          styleType: 'paragraph',
          pPr: { jc: 'left' },
          rPr: { bold: true, size: 20, font: { eastAsia: '宋体', ascii: 'Arial' } },
        }),
        def({
          styleId: 'Mid',
          styleType: 'paragraph',
          basedOn: 'Base',
          rPr: { size: 28, font: { ascii: 'Calibri' } },
        }),
        def({
          styleId: 'Leaf',
          styleType: 'paragraph',
          basedOn: 'Mid',
          pPr: { jc: 'center' },
          rPr: { italic: true },
        }),
      ],
    };

    const leaf = resolveParagraphAttrs(sheet, 'Leaf');
    // 段落属性：叶子覆盖根
    expect(leaf.pPr.jc).toBe('center');
    // 字符属性：bold 继承自 Base、size 被 Mid 覆盖、italic 来自 Leaf
    expect(leaf.rPr.bold).toBe(true);
    expect(leaf.rPr.size).toBe(28);
    expect(leaf.rPr.italic).toBe(true);
    // font 子对象合并：eastAsia 继承 Base、ascii 被 Mid 覆盖
    expect(leaf.rPr.font?.eastAsia).toBe('宋体');
    expect(leaf.rPr.font?.ascii).toBe('Calibri');
    // 命中链：叶子 → 祖先
    expect(leaf.chain).toEqual(['Leaf', 'Mid', 'Base']);

    // 单独解析 Base：不带 italic
    const base = resolveParagraphAttrs(sheet, 'Base');
    expect(base.rPr.italic).toBeUndefined();
    expect(base.rPr.bold).toBe(true);
    expect(base.rPr.size).toBe(20);
  });

  it('5. resolveParagraphAttrs：环引用不崩溃、不死循环', () => {
    const sheet: StyleSheet = {
      styles: [
        def({ styleId: 'A', styleType: 'paragraph', basedOn: 'B', rPr: { bold: true } }),
        def({ styleId: 'B', styleType: 'paragraph', basedOn: 'A', rPr: { italic: true } }),
      ],
    };

    // A → B → A 环：应各自合并一次后停止
    const a = resolveParagraphAttrs(sheet, 'A');
    expect(a.rPr.bold).toBe(true);
    expect(a.rPr.italic).toBe(true);
    expect(a.chain).toEqual(['A', 'B']);

    // 自环：A 基于自身
    const selfCycle: StyleSheet = {
      styles: [def({ styleId: 'S', styleType: 'paragraph', basedOn: 'S', rPr: { size: 10 } })],
    };
    const s = resolveParagraphAttrs(selfCycle, 'S');
    expect(s.rPr.size).toBe(10);
    expect(s.chain).toEqual(['S']);
  });

  it('6. resolveParagraphAttrs：缺失样式 / 未提供样式表时返回空属性', () => {
    const missing = resolveParagraphAttrs({ styles: [] }, 'nope');
    expect(missing.pPr).toEqual({});
    expect(missing.rPr).toEqual({});
    expect(missing.chain).toEqual([]);

    const noSheet = resolveParagraphAttrs(undefined, 'nope');
    expect(noSheet.pPr).toEqual({});
    expect(noSheet.chain).toEqual([]);
  });
});
