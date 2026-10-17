import { describe, expect, it } from 'vitest'
import {
  graphPatchExits,
  graphPatchModeProblem,
  graphPatchNumstat,
  graphPatchPathProblem,
  graphPatchText,
  graphProtectedBy,
  normalizedPatchKey
} from './graph-check-patch'

const FILE = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n')

describe('the diff a version carries', () => {
  it('reads every ```diff block in order, closing only on a fence at the start of a line', () => {
    const markdown = [
      'Notes first.',
      '```diff',
      FILE,
      '+const fence = "```"',
      '```',
      'More notes.',
      '````patch',
      '--- a/y.ts',
      '+++ b/y.ts',
      '@@ -1 +1 @@',
      '-c',
      '+d',
      '````',
      '```ts',
      'const notADiff = 1',
      '```'
    ].join('\n')
    const patch = graphPatchText(markdown)!
    expect(patch).toContain('+const fence = "```"')
    expect(patch).toContain('--- a/y.ts')
    expect(patch).not.toContain('notADiff')
    expect(patch.endsWith('+d\n')).toBe(true)
  })

  it('has none without a diff block, or with an empty one', () => {
    expect(graphPatchText('Change x to y.\n```ts\nx = y\n```')).toBeUndefined()
    expect(graphPatchText('```diff\n\n```')).toBeUndefined()
  })

  it('separates plain file headers so --recount stops at each file, dropping blank lines between', () => {
    const second = ['--- a/y.ts', '+++ b/y.ts', '@@ -1 +1 @@', '-c', '+d'].join('\n')
    const patch = graphPatchText(`\`\`\`diff\n${FILE}\n\n${second}\n\`\`\``)!
    expect(patch.split('\n')).toEqual([
      ...FILE.split('\n'),
      'diff a/y.ts b/y.ts',
      ...second.split('\n'),
      ''
    ])
    // A file that already has its git header gets nothing more.
    const git = `diff --git a/y.ts b/y.ts\nindex 1..2 100644\n${second}`
    expect(graphPatchText(`\`\`\`diff\n${FILE}\n${git}\n\`\`\``)).toBe(`${FILE}\n${git}\n`)
  })
})

describe('what git names', () => {
  it('reads numstat -z records and marks binary ones', () => {
    expect(
      graphPatchNumstat('1\t0\ta b.txt\0-\t-\timg.png\0 create mode 100644 a b.txt\n')
    ).toEqual({
      paths: ['a b.txt', 'img.png'],
      binary: ['img.png']
    })
  })

  it('refuses links and submodules from the summary or the headers, and nothing else', () => {
    expect(graphPatchModeProblem(' create mode 120000 l\n', '')).toContain('symbolic link')
    expect(graphPatchModeProblem(' delete mode 160000 s\n', '')).toContain('submodule')
    expect(graphPatchModeProblem(' mode change 100644 => 120000 f\n', '')).toContain(
      'symbolic link'
    )
    expect(graphPatchModeProblem('', 'index abc1234..def5678 120000\n')).toContain('symbolic link')
    expect(graphPatchModeProblem('', 'old mode 160000\n')).toContain('submodule')
    expect(graphPatchModeProblem(' create mode 100755 run.sh\n', 'index a..b 100644\n')).toBe(
      undefined
    )
    // A line inside a hunk is content, never a header.
    expect(graphPatchModeProblem('', '+new file mode 120000\n')).toBeUndefined()
  })
})

describe('the paths a version may not change', () => {
  it('refuses a path outside the repository', () => {
    for (const path of [
      '../x',
      'a/../../x',
      '/etc/passwd',
      'C:/x',
      'a\\..\\x',
      'a//b',
      './x',
      ''
    ]) {
      expect(graphPatchPathProblem(path, []), path).toContain('outside the repository')
    }
  })

  it('refuses .git however a file system spells it', () => {
    for (const path of [
      '.git/config',
      'sub/.GIT/hooks/x',
      '.git./x',
      '.git /x',
      'GIT~1/x',
      '.g\u200Cit/x'
    ]) {
      expect(graphPatchPathProblem(path, []), path).toContain('inside .git')
    }
    expect(graphPatchPathProblem('.github/workflows/ci.yml', [])).toBeUndefined()
    expect(graphPatchPathProblem('src/.gitkeep', [])).toBeUndefined()
  })

  it('refuses a change to what Git ignores', () => {
    expect(graphPatchPathProblem('.gitignore', [])).toContain('changes what Git ignores')
    expect(graphPatchPathProblem('pkg/.GitIgnore', [])).toContain('changes what Git ignores')
  })

  it('names the protecting pattern', () => {
    expect(graphPatchPathProblem('tests/a.test.ts', [' ', 'tests/**'])).toBe(
      'tests/a.test.ts is protected (tests/**).'
    )
    expect(graphPatchPathProblem('src/a.ts', ['tests/**'])).toBeUndefined()
  })
})

describe('protected patterns, read as .gitignore reads them', () => {
  const cases: [string, string, boolean][] = [
    ['package.json', 'package.json', true],
    ['sub/package.json', 'package.json', true],
    ['src/a.test.ts', '*.test.ts', true],
    ['src/deep/a.test.ts', '*.test.ts', true],
    ['.github/workflows/ci.yml', '*.yml', true],
    ['tests/unit/a.ts', 'tests', true],
    ['src/tests/a.ts', 'tests', true],
    ['src/tests/a.ts', '/tests', false],
    ['tests/unit/a.ts', 'tests/', true],
    ['tests', 'tests/', false],
    ['tests/a.ts', 'tests/**', true],
    ['src/tests/a.ts', 'tests/**', false],
    ['src/a/b/c.spec.ts', 'src/**/*.spec.ts', true],
    ['src/c.spec.ts', 'src/**/*.spec.ts', true],
    ['lib/c.spec.ts', 'src/**/*.spec.ts', false],
    ['Tests/A.ts', 'tests/**', true],
    ['src\\a.ts', 'src\\a.ts', false],
    ['src/a.ts', 'src\\a.ts', true],
    ['a.ts', '# a.ts', false],
    ['a.ts', 'a?ts', true],
    ['a/ts', 'a?ts', false],
    ['x+y.ts', 'x+y.ts', true],
    ['x.ts', '', false]
  ]
  it.each(cases)('%s with %s → %s', (path, pattern, protectedPath) => {
    expect(graphProtectedBy(path, pattern)).toBe(protectedPath)
  })
})

describe('calls that end the process early', () => {
  it('are found only on added lines', () => {
    const patch = [
      '+++ b/process.exit(1).js',
      '-process.exit(1)',
      ' sys.exit(2)',
      '+  if (done) process.exit (0)',
      '+sys.exit(1); os._exit(3)',
      '+process.exitCode = 1'
    ].join('\n')
    expect(graphPatchExits(patch)).toEqual(['process.exit', 'sys.exit', 'os._exit'])
    expect(graphPatchExits('+return 1\n')).toEqual([])
  })
})

describe('one change, however its diff is written', () => {
  const patch = (lines: string[]) => `${lines.join('\n')}\n`
  const base = [
    'diff --git a/x.ts b/x.ts',
    'index 1a2b3c4..5d6e7f8 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -3,4 +3,5 @@ function total() {',
    ' const a = 1',
    '-return a',
    '+return a + 1',
    ' }'
  ]

  it('ignores what a recounted apply never reads: blob ids, hunk counts, section text', () => {
    const rewritten = [...base]
    rewritten[1] = 'index 0000000..fffffff 100644'
    rewritten[4] = '@@ -3 +3,9 @@'
    expect(normalizedPatchKey(patch(rewritten))).toBe(normalizedPatchKey(patch(base)))
  })

  it('keeps every byte that changes the code, where it goes, or a file mode', () => {
    const key = normalizedPatchKey(patch(base))
    const variants = [
      // Whitespace in a line changes the code it writes (indentation in Python, say).
      base.map((line) => (line === '+return a + 1' ? '+return  a + 1' : line)),
      // So does a comment (`// @ts-expect-error`, `# type: ignore`).
      base.map((line) => (line === '+return a + 1' ? '+return a + 1 // note' : line)),
      // Where a hunk starts can decide where it applies.
      base.map((line, index) => (index === 4 ? '@@ -30,4 +30,5 @@' : line)),
      base.map((line, index) => (index === 1 ? 'index 1a2b3c4..5d6e7f8 100755' : line)),
      [...base.slice(0, 2), '--- a/y.ts', '+++ b/y.ts', ...base.slice(4)]
    ]
    for (const variant of variants) {
      expect(normalizedPatchKey(patch(variant))).not.toBe(key)
    }
  })

  it('never reads a removed line as a file header', () => {
    // Removing the SQL comment `-- a` shows as `--- a`; what follows its tab is still the code.
    const removed = (tail: string) => [...base.slice(0, 5), `--- a\t${tail}`, ...base.slice(6)]
    expect(normalizedPatchKey(patch(removed('2026-01-01')))).not.toBe(
      normalizedPatchKey(patch(removed('2027-01-01')))
    )
  })
})
