/**
 * Parses a workflow script's `meta` object literal as data. Nothing is evaluated: only objects,
 * arrays, strings, numbers, true, false and null are accepted, so a literal can never run code,
 * reach the host, or hang the main process the way an evaluated one could.
 */
export class WorkflowMetaLiteralError extends Error {}

const MAX_DEPTH = 16
/** JavaScript's line terminators: LF, CR, LINE SEPARATOR, PARAGRAPH SEPARATOR. */
export const LINE_END = /[\n\r\u2028\u2029]/

export function parseWorkflowMetaLiteral(source: string): unknown {
  let at = 0
  const fail = (what: string): never => {
    throw new WorkflowMetaLiteralError(`${what} at character ${at}`)
  }
  const skip = () => {
    for (;;) {
      while (at < source.length && /\s/.test(source[at]!)) {
        at += 1
      }
      if (source.startsWith('//', at)) {
        const end = source.slice(at).search(LINE_END)
        at = end === -1 ? source.length : at + end + 1
      } else if (source.startsWith('/*', at)) {
        const end = source.indexOf('*/', at + 2)
        if (end === -1) {
          fail('unterminated comment')
        }
        at = end + 2
      } else {
        return
      }
    }
  }
  const string = (): string => {
    const quote = source[at]!
    at += 1
    let out = ''
    while (at < source.length && source[at] !== quote) {
      const char = source[at]!
      if (quote === '`' && char === '$' && source[at + 1] === '{') {
        fail('template interpolation is not a literal')
      }
      if (char === '\\') {
        const next = source[at + 1]
        const escapes: Record<string, string> = {
          n: '\n',
          t: '\t',
          r: '\r',
          b: '\b',
          f: '\f',
          v: '\v',
          '0': '\0'
        }
        if (next === undefined) {
          fail('unterminated string')
        }
        if (next === '\r' || next === '\n' || next === '\u2028' || next === '\u2029') {
          // A line continuation: the backslash and the line break (CRLF counts as one) vanish.
          at += next === '\r' && source[at + 2] === '\n' ? 3 : 2
          continue
        }
        if (next === 'u' && source[at + 2] === '{') {
          const close = source.indexOf('}', at + 3)
          const hex = close === -1 ? '' : source.slice(at + 3, close)
          const point = /^[0-9a-fA-F]+$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN
          if (!(point <= 0x10ffff)) {
            fail('bad escape')
          }
          out += String.fromCodePoint(point)
          at = close + 1
          continue
        }
        if (next === 'u' || next === 'x') {
          const hex = next === 'x' ? source.slice(at + 2, at + 4) : source.slice(at + 2, at + 6)
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== (next === 'x' ? 2 : 4)) {
            fail('bad escape')
          }
          out += String.fromCharCode(Number.parseInt(hex, 16))
          at += 2 + hex.length
          continue
        }
        out += escapes[next!] ?? next
        at += 2
        continue
      }
      if (quote !== '`' && (char === '\n' || char === '\r')) {
        fail('unterminated string')
      }
      if (char === '\r') {
        // A template's CR and CRLF read as LF, as in JavaScript.
        out += '\n'
        at += source[at + 1] === '\n' ? 2 : 1
        continue
      }
      out += char
      at += 1
    }
    if (source[at] !== quote) {
      fail('unterminated string')
    }
    at += 1
    return out
  }
  const key = (): string => {
    const char = source[at]
    if (char === '"' || char === "'") {
      return string()
    }
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(at))
    if (!match) {
      fail('expected a property name')
    }
    at += match![0].length
    return match![0]
  }
  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) {
      fail('nested too deeply')
    }
    skip()
    const char = source[at]
    if (char === '{') {
      at += 1
      const out: Record<string, unknown> = Object.create(null)
      for (;;) {
        skip()
        if (source[at] === '}') {
          at += 1
          return out
        }
        const name = key()
        if (name === '__proto__') {
          fail('__proto__ is not allowed')
        }
        skip()
        if (source[at] !== ':') {
          fail('expected ":" (shorthand, methods and getters are not literals)')
        }
        at += 1
        out[name] = value(depth + 1)
        skip()
        if (source[at] === ',') {
          at += 1
        } else if (source[at] !== '}') {
          fail('expected "," or "}"')
        }
      }
    }
    if (char === '[') {
      at += 1
      const out: unknown[] = []
      for (;;) {
        skip()
        if (source[at] === ']') {
          at += 1
          return out
        }
        out.push(value(depth + 1))
        skip()
        if (source[at] === ',') {
          at += 1
        } else if (source[at] !== ']') {
          fail('expected "," or "]"')
        }
      }
    }
    if (char === '"' || char === "'" || char === '`') {
      return string()
    }
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at))
    if (number) {
      at += number[0].length
      return Number(number[0])
    }
    for (const [word, result] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ] as const) {
      if (source.startsWith(word, at) && !/[A-Za-z0-9_$]/.test(source[at + word.length] ?? '')) {
        at += word.length
        return result
      }
    }
    return fail('only objects, arrays, strings, numbers, true, false and null are allowed')
  }
  const result = value(0)
  skip()
  if (at !== source.length) {
    fail('unexpected text after the literal')
  }
  return result
}
