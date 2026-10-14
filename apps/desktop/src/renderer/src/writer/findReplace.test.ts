/**
 * 查找替换 + 字数统计 + 字体清单 单测（WPS 对齐批 1）。
 */
import { describe, it, expect } from 'vitest';
import { findAllMatches, applyReplaceAll } from './findReplace';
import { countWords, FONT_GROUPS, ALL_FONT_NAMES } from './fonts';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';

// 最小 schema：段落 + 文本
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline', inline: true },
  },
});

function makeDoc(...paragraphs: string[]) {
  const nodes = paragraphs.map((t) =>
    schema.node('paragraph', null, t ? [schema.text(t)] : []),
  );
  return schema.node('doc', null, nodes);
}

describe('findAllMatches', () => {
  it('单段内多处匹配按位置顺序返回', () => {
    const doc = makeDoc('abc abc abc');
    const m = findAllMatches(doc, 'abc');
    expect(m).toHaveLength(3);
    expect(m[0]).toEqual({ from: 1, to: 4 });
    expect(m[2]).toEqual({ from: 9, to: 12 });
  });

  it('跨段落定位正确（offset 累计）', () => {
    const doc = makeDoc('第一段目标', '第二段目标');
    const m = findAllMatches(doc, '目标');
    expect(m).toHaveLength(2);
    // 段2 起始 = 1(开) + 2(开) + 5(文本) + 1(闭) + 1 = 打开第二段的 text 前
    expect(m[1].from).toBeGreaterThan(m[0].to);
  });

  it('大小写不敏感为默认，可开启敏感模式', () => {
    const doc = makeDoc('Foo foo FOO');
    expect(findAllMatches(doc, 'foo')).toHaveLength(3);
    expect(findAllMatches(doc, 'foo', { caseSensitive: true })).toHaveLength(1);
  });

  it('空 needle 返回空', () => {
    expect(findAllMatches(makeDoc('abc'), '')).toHaveLength(0);
  });
});

describe('applyReplaceAll', () => {
  it('全部替换且位置不漂移（倒序）', () => {
    const doc = makeDoc('a目标b目标c');
    const tr = EditorState.create({ doc }).tr;
    const count = applyReplaceAll(tr, '目标', '替换');
    expect(count).toBe(2);
    expect(tr.doc.textContent).toBe('a替换b替换c');
  });

  it('替换后长度变化不破坏后续匹配', () => {
    const doc = makeDoc('xx yy xx');
    const tr = EditorState.create({ doc }).tr;
    const count = applyReplaceAll(tr, 'xx', 'xyz');
    expect(count).toBe(2);
    expect(tr.doc.textContent).toBe('xyz yy xyz');
  });
});

describe('countWords（WPS 口径）', () => {
  it('中文按字计，西文按词计', () => {
    const r = countWords('你好 world 你好');
    // 中文字 4 个（你好×2）+ 西文词 1 个（world）= 5
    expect(r.words).toBe(5);
  });

  it('空串归零', () => {
    expect(countWords('')).toEqual({ words: 0, charsNoSpace: 0, chars: 0 });
  });

  it('字符数区分空格', () => {
    const r = countWords('a b');
    expect(r.chars).toBe(3);
    expect(r.charsNoSpace).toBe(2);
  });
});

describe('FONT_GROUPS', () => {
  it('三分组且包含合规推荐字体', () => {
    expect(FONT_GROUPS).toHaveLength(3);
    expect(ALL_FONT_NAMES).toContain('思源黑体');
    expect(ALL_FONT_NAMES).toContain('阿里巴巴普惠体');
    expect(ALL_FONT_NAMES).toContain('宋体');
  });
});

// 供 TS 使用（避免未使用导入告警）
void TextSelection;
