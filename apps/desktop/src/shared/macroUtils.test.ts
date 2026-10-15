/**
 * 宏文件命名纯函数单测（安全边界：路径穿越 / 非法字符 / 长度）。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeMacroName, isValidMacroName, macroFileName, MACRO_FILE_EXT } from './macroUtils';

describe('sanitizeMacroName', () => {
  it('接受合法中文 / 英文 / 数字 / 连字符 / 空格', () => {
    expect(sanitizeMacroName('批量替换').ok).toBe(true);
    const r = sanitizeMacroName('My-Macro 01');
    expect(r.ok).toBe(true);
    expect(r.name).toBe('My-Macro 01');
  });

  it('去除首尾空白', () => {
    expect(sanitizeMacroName('  hello  ').name).toBe('hello');
  });

  it('拒绝路径穿越（..）', () => {
    expect(sanitizeMacroName('../evil').ok).toBe(false);
    expect(sanitizeMacroName('a/../../b').ok).toBe(false);
    expect(sanitizeMacroName('..').ok).toBe(false);
  });

  it('拒绝路径分隔符', () => {
    expect(sanitizeMacroName('a/b').ok).toBe(false);
    expect(sanitizeMacroName('a\\b').ok).toBe(false);
  });

  it('拒绝 Windows 非法字符', () => {
    expect(sanitizeMacroName('a:b').ok).toBe(false);
    expect(sanitizeMacroName('a*b').ok).toBe(false);
    expect(sanitizeMacroName('a|b').ok).toBe(false);
  });

  it('拒绝空名 / 纯空白 / 非字符串', () => {
    expect(sanitizeMacroName('').ok).toBe(false);
    expect(sanitizeMacroName('   ').ok).toBe(false);
    expect(sanitizeMacroName(123 as unknown as string).ok).toBe(false);
    expect(sanitizeMacroName(null).ok).toBe(false);
  });

  it('拒绝超长（>64）', () => {
    expect(sanitizeMacroName('a'.repeat(64)).ok).toBe(true);
    expect(sanitizeMacroName('a'.repeat(65)).ok).toBe(false);
  });

  it('拒绝以点号开头 / 结尾', () => {
    expect(sanitizeMacroName('.hidden').ok).toBe(false);
    expect(sanitizeMacroName('name.').ok).toBe(false);
  });
});

describe('isValidMacroName', () => {
  it('合法 true / 非法 false', () => {
    expect(isValidMacroName('ok')).toBe(true);
    expect(isValidMacroName('../x')).toBe(false);
  });
});

describe('macroFileName', () => {
  it('合法名补 .js 后缀', () => {
    expect(macroFileName('demo')).toBe(`demo${MACRO_FILE_EXT}`);
  });

  it('非法名抛错', () => {
    expect(() => macroFileName('../x')).toThrow();
  });
});
