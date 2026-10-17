/**
 * 平台快捷键抽象单测（macOS 版新增）。
 *
 * 覆盖两类回归：
 *  1. **主修饰键映射**：mac 只认 metaKey、Windows 只认 ctrlKey —— 若退化为
 *     `ctrlKey || metaKey`，mac 上会吞掉 Ctrl+A/Ctrl+E 等 Emacs 光标移动快捷键；
 *  2. **文案映射**：UI 提示不能出现「Ctrl+F」出现在 mac 上（手写字符串回归）。
 */
import { describe, expect, it } from 'vitest';
import {
  accelLabelOn,
  isPrimaryModifierOn,
  primaryModifierLabelOn,
} from './platform';

describe('isPrimaryModifierOn（主修饰键判定）', () => {
  it('Windows：只认 ctrlKey，单独按 metaKey 不算', () => {
    expect(isPrimaryModifierOn({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(isPrimaryModifierOn({ ctrlKey: false, metaKey: true }, false)).toBe(false);
    expect(isPrimaryModifierOn({ ctrlKey: false, metaKey: false }, false)).toBe(false);
  });

  it('macOS：只认 metaKey，单独按 ctrlKey 不算（否则吞掉 Emacs 光标键）', () => {
    expect(isPrimaryModifierOn({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isPrimaryModifierOn({ ctrlKey: true, metaKey: false }, true)).toBe(false);
  });

  it('两者同时按下时两平台都判为真（不出现漏判）', () => {
    expect(isPrimaryModifierOn({ ctrlKey: true, metaKey: true }, true)).toBe(true);
    expect(isPrimaryModifierOn({ ctrlKey: true, metaKey: true }, false)).toBe(true);
  });
});

describe('primaryModifierLabelOn（主修饰键文案）', () => {
  it('mac 显示 ⌘，Windows 显示 Ctrl', () => {
    expect(primaryModifierLabelOn(true)).toBe('⌘');
    expect(primaryModifierLabelOn(false)).toBe('Ctrl');
  });
});

describe('accelLabelOn（组合键文案）', () => {
  it('单修饰键：mac ⌘F / Windows Ctrl+F', () => {
    expect(accelLabelOn('F', true)).toBe('⌘F');
    expect(accelLabelOn('F', false)).toBe('Ctrl+F');
  });

  it('带 Shift：mac ⌘⇧P / Windows Ctrl+Shift+P（与命令面板实际快捷键一致）', () => {
    expect(accelLabelOn('P', true, true)).toBe('⌘⇧P');
    expect(accelLabelOn('P', false, true)).toBe('Ctrl+Shift+P');
  });

  it('附加修饰键 Alt 在 mac 映射为 ⌥', () => {
    expect(accelLabelOn('F', true, false, ['Alt'])).toBe('⌘⌥F');
    expect(accelLabelOn('F', false, false, ['Alt'])).toBe('Ctrl+Alt+F');
  });

  it('F1 / Enter / 数字键等主键原样保留', () => {
    expect(accelLabelOn('F1', true)).toBe('⌘F1');
    expect(accelLabelOn('1', true)).toBe('⌘1');
    expect(accelLabelOn('Enter', true)).toBe('⌘Enter');
    expect(accelLabelOn('Z', false)).toBe('Ctrl+Z');
  });

  it('未知附加修饰键原样拼接（不丢修饰键）', () => {
    expect(accelLabelOn('K', true, false, ['Cmd'])).toBe('⌘CmdK');
    expect(accelLabelOn('K', false, false, ['Cmd'])).toBe('Ctrl+Cmd+K');
  });
});
