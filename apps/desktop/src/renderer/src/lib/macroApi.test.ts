/**
 * 宏相关纯函数单测（代码校验 / 错误归一 / 日志序列化）。
 */
import { describe, it, expect } from 'vitest';
import {
  validateMacroCode,
  describeError,
  serializeLogArg,
  MACRO_TIMEOUT_MS,
  MAX_MACRO_CODE_LENGTH,
  JK_API_METHODS,
  SAMPLE_MACRO,
} from './macroApi';

describe('validateMacroCode', () => {
  it('空 / 纯空白 / 非字符串拒绝', () => {
    expect(validateMacroCode('').ok).toBe(false);
    expect(validateMacroCode('  \n\t ').ok).toBe(false);
    expect(validateMacroCode(undefined).ok).toBe(false);
  });

  it('正常代码通过', () => {
    expect(validateMacroCode('jk.log("hi")').ok).toBe(true);
  });

  it('超长拒绝', () => {
    const long = 'x'.repeat(MAX_MACRO_CODE_LENGTH + 1);
    expect(validateMacroCode(long).ok).toBe(false);
  });
});

describe('describeError', () => {
  it('Error → message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });
  it('字符串原样', () => {
    expect(describeError('oops')).toBe('oops');
  });
  it('对象序列化', () => {
    expect(describeError({ a: 1 })).toBe('{"a":1}');
  });
  it('null / undefined', () => {
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined');
  });
});

describe('serializeLogArg', () => {
  it('字符串 / 数字 / 布尔 / 空值', () => {
    expect(serializeLogArg('a')).toBe('a');
    expect(serializeLogArg(42)).toBe('42');
    expect(serializeLogArg(true)).toBe('true');
    expect(serializeLogArg(null)).toBe('null');
    expect(serializeLogArg(undefined)).toBe('undefined');
  });

  it('对象 JSON 序列化', () => {
    expect(serializeLogArg({ a: 1 })).toBe('{"a":1}');
  });

  it('循环引用不抛异常', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(typeof serializeLogArg(o)).toBe('string');
  });

  it('函数降级为标记', () => {
    expect(serializeLogArg(() => 1)).toContain('[Function');
  });
});

describe('常量', () => {
  it('默认超时 5s', () => {
    expect(MACRO_TIMEOUT_MS).toBe(5000);
  });
  it('白名单包含核心 API', () => {
    const joined = JK_API_METHODS.join(' ');
    expect(joined).toContain('jk.getText');
    expect(joined).toContain('jk.applyOps');
    expect(joined).toContain('jk.sheet.setValues');
  });
  it('示例宏非空', () => {
    expect(SAMPLE_MACRO.trim().length).toBeGreaterThan(0);
  });
});
