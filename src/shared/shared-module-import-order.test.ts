import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: the CLI compiles src/shared to CommonJS, where an import below a top-level statement is a
// `const x = require()` read before it is assigned; `omni outcome …` died on exactly that.
const SHARED_DIR = path.resolve(__dirname)

function lateValueImports(source: string): string[] {
  const late: string[] = []
  let code = false
  let inImport = false
  for (const line of source.split('\n')) {
    if (inImport) {
      inImport = !/from\s+['"][^'"]+['"]/.test(line)
      continue
    }
    if (/^import\s/.test(line)) {
      if (code && !/^import\s+type\s/.test(line)) {
        late.push(line.trim())
      }
      inImport = !/from\s+['"][^'"]+['"]|^import\s+['"]/.test(line)
      continue
    }
    if (/^(export\s+)?(const|let|var|function|class|async function|enum)\s/.test(line)) {
      code = true
    }
  }
  return late
}

describe('shared module import order', () => {
  it('keeps every value import above the first top-level declaration', () => {
    const offenders = readdirSync(SHARED_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .flatMap((name) =>
        lateValueImports(readFileSync(path.join(SHARED_DIR, name), 'utf8')).map(
          (line) => `${name}: ${line}`
        )
      )
    expect(offenders).toEqual([])
  })

  it('flags a value import placed below code, and not a type import', () => {
    expect(lateValueImports("export const a = 1\nimport { b } from './b'\n")).toEqual([
      "import { b } from './b'"
    ])
    expect(lateValueImports("export const a = 1\nimport type { B } from './b'\n")).toEqual([])
  })
})
