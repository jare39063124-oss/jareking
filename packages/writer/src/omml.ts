/**
 * OMML 公式生成器（WPS 对齐：公式能力）。
 *
 * 输入线性公式（如 `x^2 + y^2 = z^2`、`a/b`、`sqrt(x)`、`2(x+1)`），
 * 输出 Word/WPS 原生公式 XML（m:oMath 内部结构），导出 docx 后在
 * Word/WPS 中是**可编辑公式对象**（非图片、非纯文本）。
 *
 * 支持：+ - × ÷ ^（上标）、a/b（分数）、sqrt()（根号）、
 *      括号、数字/标识符（多字符变量名）、三角函数等标识符。
 * v1 有意不支持：矩阵/方程组/积分上下限/多级嵌套（登记 W-P2）。
 */

type Token =
  | { t: 'num'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '^' | '×' | '÷' | '=' | '<' | '>' | '(' | ')' | ',' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-zα-ωΑ-Ω]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9α-ωΑ-Ω]/.test(src[j])) j++;
      tokens.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const opMap: Record<string, Token> = {
      '+': { t: 'op', v: '+' },
      '-': { t: 'op', v: '-' },
      '*': { t: 'op', v: '*' },
      '×': { t: 'op', v: '×' },
      '/': { t: 'op', v: '/' },
      '÷': { t: 'op', v: '÷' },
      '^': { t: 'op', v: '^' },
      '=': { t: 'op', v: '=' },
      '<': { t: 'op', v: '<' },
      '>': { t: 'op', v: '>' },
      '(': { t: 'op', v: '(' },
      ')': { t: 'op', v: ')' },
      ',': { t: 'op', v: ',' },
    };
    const tok = opMap[c];
    if (tok) {
      tokens.push(tok);
      i++;
      continue;
    }
    throw new Error(`公式含不支持的字符「${c}」（位置 ${i + 1}）`);
  }
  return tokens;
}

type Node =
  | { k: 'run'; text: string }
  | { k: 'frac'; num: Node; den: Node }
  | { k: 'sup'; base: Node; exp: Node }
  | { k: 'rad'; body: Node }
  | { k: 'group'; children: Node[] };

/** 解析线性公式 → 结构树（递归下降） */
export function parseLinearFormula(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = () => tokens[pos++];

  /** expr := term (('+'|'-') term)* */
  function expr(): Node {
    const children: Node[] = [term()];
    while (peek() && peek().t === 'op' && ['+', '-', '=', '<', '>'].includes((peek() as { v: string }).v)) {
      const op = (eat() as { v: string }).v;
      children.push({ k: 'run', text: op === '*' ? '⋅' : op });
      children.push(term());
    }
    return children.length === 1 ? children[0] : { k: 'group', children };
  }

  /** term := factor (('*'|'×'|'/'|'÷') factor)* —— a/b 直接生成分数 */
  function term(): Node {
    let left = factor();
    while (peek() && peek().t === 'op' && ['*', '×', '/', '÷'].includes((peek() as { v: string }).v)) {
      const op = (eat() as { v: string }).v;
      const right = factor();
      if (op === '/' || op === '÷') left = { k: 'frac', num: left, den: right };
      else {
        left = { k: 'group', children: [left, { k: 'run', text: '⋅' }, right] };
      }
    }
    return left;
  }

  /** factor := atom ('^' factor)? */
  function factor(): Node {
    const base = atom();
    if (peek() && peek().t === 'op' && (peek() as { v: string }).v === '^') {
      eat();
      return { k: 'sup', base, exp: factor() };
    }
    return base;
  }

  /** atom := num | id(sqrt/函数) | '(' expr ')'，并支持隐式乘法（2(x+1)、sin(x)） */
  function atom(): Node {
    const t = peek();
    if (!t) throw new Error('公式意外结束');

    /** 紧跟括号时按隐式乘法消费：num/函数 × (expr) */
    const withImplicitParen = (node: Node): Node => {
      if (peek() && peek().t === 'op' && (peek() as { v: string }).v === '(') {
        eat();
        const inner = expr();
        if (!peek() || (peek() as { v: string }).v !== ')') throw new Error('括号不匹配：缺少右括号');
        eat();
        return { k: 'group', children: [node, inner] };
      }
      return node;
    };

    if (t.t === 'num') {
      eat();
      return withImplicitParen({ k: 'run', text: t.v });
    }
    if (t.t === 'id') {
      eat();
      if (t.v === 'sqrt' && peek() && peek().t === 'op' && (peek() as { v: string }).v === '(') {
        eat();
        const body = expr();
        if (!peek() || (peek() as { v: string }).v !== ')') throw new Error('括号不匹配：缺少右括号');
        eat();
        return { k: 'rad', body };
      }
      // 多字符标识符（sin/lim/变量名）：斜体变量排版交给 Word；函数名后接括号按隐式乘法
      return withImplicitParen({ k: 'run', text: t.v });
    }
    if (t.t === 'op' && t.v === '(') {
      eat();
      const inner = expr();
      if (!peek() || (peek() as { v: string }).v !== ')') throw new Error('括号不匹配：缺少右括号');
      eat();
      return inner;
    }
    throw new Error(`公式语法错误：「${(t as { v: string }).v}」`);
  }

  const tree = expr();
  if (pos < tokens.length) throw new Error('公式尾部有多余内容');
  return tree;
}

/** 结构树 → OMML XML（m: 命名空间，Word/WPS 原生公式） */
export function renderOmml(node: Node): string {
  switch (node.k) {
    case 'run':
      return `<m:r><m:t>${escapeXml(node.text)}</m:t></m:r>`;
    case 'frac':
      return `<m:f><m:fPr><m:type m:val="bar"/></m:fPr><m:num>${renderOmml(node.num)}</m:num><m:den>${renderOmml(node.den)}</m:den></m:f>`;
    case 'sup':
      return `<m:sSup><m:e>${renderOmml(node.base)}</m:e><m:sup>${renderOmml(node.exp)}</m:sup></m:sSup>`;
    case 'rad':
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${renderOmml(node.body)}</m:e></m:rad>`;
    case 'group':
      return node.children.map(renderOmml).join('');
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 线性公式 → 完整 m:oMath XML（供导出器直接嵌入 docx 段落） */
export function linearToOmml(linear: string): string {
  const tree = parseLinearFormula(linear);
  return `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${renderOmml(tree)}</m:oMath>`;
}

/** 校验线性公式合法性（UI 输入即时反馈） */
export function validateLinearFormula(linear: string): { ok: boolean; error?: string } {
  try {
    parseLinearFormula(linear);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}