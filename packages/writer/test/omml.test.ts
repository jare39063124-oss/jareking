/**
 * OMML 公式生成器 单测（WPS 对齐：公式能力）。
 */
import { describe, it, expect } from 'vitest';
import { linearToOmml, validateLinearFormula, parseLinearFormula } from '../src/omml';

describe('parseLinearFormula', () => {
  it('上标右结合：x^2', () => {
    const t = parseLinearFormula('x^2');
    expect(t).toEqual({ k: 'sup', base: { k: 'run', text: 'x' }, exp: { k: 'run', text: '2' } });
  });

  it('a/b 生成分数', () => {
    const t = parseLinearFormula('a/b');
    expect(t).toEqual({
      k: 'frac',
      num: { k: 'run', text: 'a' },
      den: { k: 'run', text: 'b' },
    });
  });

  it('sqrt(x) 生成根号', () => {
    const t = parseLinearFormula('sqrt(x)');
    expect(t.k).toBe('rad');
  });

  it('括号表达式', () => {
    const t = parseLinearFormula('2(x+1)');
    expect(t.k).toBe('group');
  });
});

describe('linearToOmml', () => {
  it('毕达哥拉斯：sSup + group + 等号 run', () => {
    const xml = linearToOmml('x^2+y^2=z^2');
    expect(xml).toContain('<m:oMath');
    expect(xml).toContain('<m:sSup>');
    expect(xml).toContain('<m:t>x</m:t>');
    expect(xml).toContain('<m:t>=</m:t>');
    expect(xml).toContain('<m:t>z</m:t>');
  });

  it('分数输出 m:f 结构', () => {
    const xml = linearToOmml('a/b');
    expect(xml).toContain('<m:f>');
    expect(xml).toContain('<m:num>');
    expect(xml).toContain('<m:den>');
  });

  it('根号输出 m:rad + degHide', () => {
    const xml = linearToOmml('sqrt(x)');
    expect(xml).toContain('<m:rad>');
    expect(xml).toContain('degHide');
  });

  it('多字符变量名与三角函数保留', () => {
    const xml = linearToOmml('sin(x)/cos(x)');
    expect(xml).toContain('<m:t>sin</m:t>');
    expect(xml).toContain('<m:t>cos</m:t>');
  });

  it('XML 转义（< > & 视为运算符/字符安全）', () => {
    expect(() => linearToOmml('x<y')).not.toThrow();
  });
});

describe('validateLinearFormula', () => {
  it('合法公式通过', () => {
    expect(validateLinearFormula('a^2+b^2').ok).toBe(true);
  });
  it('括号不匹配报错', () => {
    const r = validateLinearFormula('(x+1');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it('不支持字符报错并给位置', () => {
    const r = validateLinearFormula('x@y');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('@');
  });
});
// ---- docx 往返（公式 → OMML → 解析保真） ----
describe('公式 docx 往返', () => {
  it('formula inline 导出为 m:oMath，再解析回 formula', async () => {
    const { exportDocx, parseDocx } = await import('../src/index.js');
    const doc = {
      body: [
        {
          type: 'paragraph' as const,
          runs: [
            { type: 'run' as const, text: '公式：' },
            { type: 'formula' as const, text: 'x^2+y^2=z^2' },
          ],
        },
      ],
      sections: [],
    };
    const bytes = await exportDocx(doc);
    // OOXML 里含 m:oMath 与 m 命名空间
    const xml = new TextDecoder().decode(bytes);
    expect(xml).toContain('m:oMath');
    expect(xml).toContain('officeDocument/2006/math');

    const reparsed = await parseDocx(bytes);
    const para = reparsed.body.find((b) => b.type === 'paragraph') as
      | { type: 'paragraph'; runs: { type: string; text?: string }[] }
      | undefined;
    const formula = para?.runs?.find((r) => r.type === 'formula');
    expect(formula).toBeDefined();
    expect(formula?.text).toContain('x');
  });
});
