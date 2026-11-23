/** Token 类型 */
export type TokenType =
  | 'number'
  | 'string'
  | 'cellRef'
  | 'rangeRef'
  | 'identifier'
  | 'operator'
  | 'paren'
  | 'comma'
  | 'eof'

export interface Token {
  type: TokenType
  value: string
}

/**
 * 公式分词器
 * 将公式字符串拆分为 Token 序列
 */
export function tokenize(formula: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const s = formula.startsWith('=') ? formula.slice(1) : formula

  while (i < s.length) {
    const ch = s[i]

    // 空白跳过
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }

    // 字符串 "..."
    if (ch === '"') {
      let j = i + 1
      let str = ''
      while (j < s.length && s[j] !== '"') {
        str += s[j]
        j++
      }
      tokens.push({ type: 'string', value: str })
      i = j + 1
      continue
    }

    // 数字
    if (/[0-9.]/.test(ch)) {
      let j = i
      while (j < s.length && /[0-9.]/.test(s[j])) j++
      tokens.push({ type: 'number', value: s.slice(i, j) })
      i = j
      continue
    }

    // 单元格引用 / 范围引用 / 标识符
    if (/[A-Za-z]/.test(ch)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++
      const word = s.slice(i, j)
      const cellMatch = word.match(/^([A-Za-z]+)(\d+)$/)
      if (cellMatch) {
        // 检查是否是范围 A1:B3
        if (s[j] === ':') {
          let k = j + 1
          while (k < s.length && /[A-Za-z0-9]/.test(s[k])) k++
          const rangeEnd = s.slice(j + 1, k)
          if (/^[A-Za-z]+\d+$/.test(rangeEnd)) {
            tokens.push({ type: 'rangeRef', value: `${word}:${rangeEnd}` })
            i = k
            continue
          }
        }
        tokens.push({ type: 'cellRef', value: word })
        i = j
        continue
      }
      // 布尔值
      if (word.toUpperCase() === 'TRUE') {
        tokens.push({ type: 'identifier', value: 'TRUE' })
        i = j
        continue
      }
      if (word.toUpperCase() === 'FALSE') {
        tokens.push({ type: 'identifier', value: 'FALSE' })
        i = j
        continue
      }
      // 函数名
      tokens.push({ type: 'identifier', value: word })
      i = j
      continue
    }

    // 运算符
    if ('+-*/^'.includes(ch)) {
      tokens.push({ type: 'operator', value: ch })
      i++
      continue
    }

    // 比较运算符
    if (ch === '>' || ch === '<' || ch === '=') {
      if (s[i + 1] === '=') {
        tokens.push({ type: 'operator', value: ch + '=' })
        i += 2
      } else if (ch === '<' && s[i + 1] === '>') {
        tokens.push({ type: 'operator', value: '<>' })
        i += 2
      } else {
        tokens.push({ type: 'operator', value: ch })
        i++
      }
      continue
    }

    // 括号
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch })
      i++
      continue
    }

    // 逗号
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch })
      i++
      continue
    }

    throw new Error(`Unexpected character: ${ch}`)
  }

  tokens.push({ type: 'eof', value: '' })
  return tokens
}
