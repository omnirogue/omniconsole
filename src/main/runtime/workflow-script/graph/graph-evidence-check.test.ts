import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  checkGraphEvidence,
  graphEvidenceLocation,
  graphExcerptFragments,
  graphMatchExcerpt
} from './graph-evidence-check'

const lines = (count: number, at: Record<number, string>) =>
  Array.from(
    { length: count },
    (_, index) => at[index + 1] ?? `const filler${index + 1} = ${index}`
  )

let workspace = ''
let outside = ''
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'graph-evidence-'))
  outside = await mkdtemp(join(tmpdir(), 'graph-evidence-outside-'))
  await mkdir(join(workspace, 'src'))
  await writeFile(
    join(workspace, 'src', 'cache.ts'),
    lines(120, { 10: 'if (entry.expires < now) {', 11: '  return entry.value', 12: '}' }).join('\n')
  )
  await writeFile(
    join(workspace, 'src', 'windows.ts'),
    'function load(path) {\r\n  const data = read(path)\r\n  return parse(data)\r\n}\r\n'
  )
  await writeFile(join(outside, 'secret.ts'), 'if (entry.expires < now) {\n')
  await writeFile(join(workspace, 'huge.ts'), Buffer.alloc(8 * 1024 * 1024 + 1, 97))
})

const check = (file: string, line: number, excerpt: string, root: string | null = workspace) =>
  checkGraphEvidence({ items: [{ key: 'k', file, line, excerpt }] }, root).then(
    (checks) => checks.k!
  )

describe('reading the quoted file inside the workspace', () => {
  it('reads a regular file inside the workspace', async () => {
    expect((await check(join('src', 'cache.ts'), 10, 'if (entry.expires < now) {')).status).toBe(
      'found'
    )
  })

  // Creating symlinks needs extra rights on Windows; the realpath rule is the same there.
  it.skipIf(process.platform === 'win32')(
    'follows a symlink only while its target stays inside the workspace',
    async () => {
      await symlink(join(outside, 'secret.ts'), join(workspace, 'src', 'escape.ts'))
      await symlink(join(workspace, 'src', 'cache.ts'), join(workspace, 'src', 'alias.ts'))
      const quote = 'if (entry.expires < now) {'
      expect((await check(join('src', 'alias.ts'), 10, quote)).status).toBe('found')
      expect(await check(join('src', 'escape.ts'), 1, quote)).toEqual({
        status: 'unreadable',
        line: 1
      })
    }
  )

  it('never reads outside the workspace, a directory, a missing file or one over the cap', async () => {
    for (const file of [
      join('..', '..', '..', '..', '..', 'etc', 'passwd'),
      join(outside, 'secret.ts'),
      'src',
      join('src', 'gone.ts'),
      'huge.ts'
    ]) {
      expect(await check(file, 1, 'if (entry.expires < now) {'), file).toEqual({
        status: 'unreadable',
        line: 1
      })
    }
  })

  it('marks every quote unreadable without a workspace, never found or missing', async () => {
    expect(await check('src/cache.ts', 10, 'if (entry.expires < now) {', null)).toEqual({
      status: 'unreadable',
      line: 10
    })
  })
})

describe('matching a quote', () => {
  const content = lines(200, {
    50: 'function settle(call) {',
    51: '  const outcome = outcomes.get(call.id)',
    52: '  if (!outcome) {',
    53: '    return pending',
    54: '  }',
    150: '  retries += 1'
  }).join('\n')

  it('finds a quote at or near the line, whitespace and line breaks ignored', () => {
    const quote = 'const outcome =   outcomes.get(call.id)\n    if (!outcome) {'
    expect(graphMatchExcerpt(content, quote, 51)).toMatchObject({ status: 'found', line: 51 })
    expect(graphMatchExcerpt(content, quote, 80)).toMatchObject({ status: 'found', line: 51 })
  })

  it('calls a quote more than 30 lines away moved, and one nowhere in the file missing', () => {
    expect(graphMatchExcerpt(content, 'retries += 1', 20)).toMatchObject({
      status: 'moved',
      line: 150
    })
    expect(graphMatchExcerpt(content, 'retries += 2', 150)).toMatchObject({
      status: 'missing',
      line: 150
    })
  })

  it('matches the parts of an elided quote in order, and only in order', () => {
    const elided = 'function settle(call) { ... return pending'
    expect(graphMatchExcerpt(content, elided, 50).status).toBe('found')
    expect(graphMatchExcerpt(content, 'function settle(call) {…return pending', 50).status).toBe(
      'found'
    )
    expect(
      graphMatchExcerpt(content, 'return pending ... function settle(call) {', 50).status
    ).toBe('missing')
    expect(graphExcerptFragments('a(\n  b) ... c;   …  ')).toEqual(['a( b)', 'c;'])
  })

  it('prefers the occurrence nearest the named line', () => {
    const twice = lines(300, { 20: 'reset()', 250: 'reset()' }).join('\n')
    expect(graphMatchExcerpt(twice, 'reset()', 240)).toMatchObject({ status: 'found', line: 250 })
    expect(graphMatchExcerpt(twice, 'reset()', 30)).toMatchObject({ status: 'found', line: 20 })
  })

  it('reads CRLF files and keeps the real lines, numbered, around the match', async () => {
    const found = await check('src/windows.ts', 2, 'const data = read(path)\n  return parse(data)')
    expect(found).toMatchObject({ status: 'found', line: 2 })
    expect(found.context).toBe(
      [
        '1 | function load(path) {',
        '2 |   const data = read(path)',
        '3 |   return parse(data)',
        '4 | }',
        '5 | '
      ].join('\n')
    )
  })

  it('keeps ±12 lines of context around the named line when the quote is missing', () => {
    const missing = graphMatchExcerpt(content, 'nothing like this', 100)
    const numbers = missing.context!.split('\n').map((row) => Number(row.split(' | ')[0]))
    expect(numbers[0]).toBe(88)
    expect(numbers.at(-1)).toBe(112)
  })
})

describe('reading a location', () => {
  it('takes path:line in its common forms and nothing without a line', () => {
    expect(graphEvidenceLocation('src/a.ts:12')).toEqual({ file: 'src/a.ts', line: 12 })
    expect(graphEvidenceLocation('./src/a.ts:12:5 (in load)')).toEqual({
      file: 'src/a.ts',
      line: 12
    })
    expect(graphEvidenceLocation('`src/a.ts:12-20`, src/b.ts:3')).toEqual({
      file: 'src/a.ts',
      line: 12
    })
    expect(graphEvidenceLocation('src/a.ts#L7')).toEqual({ file: 'src/a.ts', line: 7 })
    expect(graphEvidenceLocation('C:\\repo\\a.ts:9')).toEqual({ file: 'C:\\repo\\a.ts', line: 9 })
    expect(graphEvidenceLocation('src/a.ts')).toBeUndefined()
    expect(graphEvidenceLocation('the onboarding survey')).toBeUndefined()
    expect(graphEvidenceLocation('')).toBeUndefined()
    expect(graphEvidenceLocation('src/a.ts:0')).toBeUndefined()
  })
})
