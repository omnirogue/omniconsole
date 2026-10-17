import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '../../../../shared/child-process/run-process'
import type { GraphEvidenceCheck, GraphEvidenceRequest } from './graph-evidence-check'
import { createGraphEvidenceChecker } from './graph-evidence-checker'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan-types'
import { graphPreVerifyItem, type GraphPreVerifyItem } from './graph-pre-verify'
import { checkGraphPreVerify } from './graph-pre-verify-check'
import { runGraphSearch, type GraphSearchRun } from './graph-pre-verify-search'

const hasRg = (() => {
  try {
    return runProcessSync({ program: 'rg', args: ['--version'], timeoutMs: 5_000 }).code === 0
  } catch {
    return false
  }
})()

let base = ''
let root = ''
const put = (file: string, content: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), content)
}
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'graph-pre-verify-')))
  root = join(base, 'workspace')
  put('src/a.ts', 'line one\nconst x = compute()\nline three\n')
  put('pkg/core/b.ts', 'export function startWatcher() {\n  return 1\n}\n')
  put('dup/one/c.ts', 'one\n')
  put('dup/two/c.ts', 'two\n')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const fact = (fields: Partial<GraphPreVerifyItem> & { key: string }): GraphPreVerifyItem => ({
  citations: [],
  code: true,
  searches: [],
  ...fields
})

const check = (
  preVerify: GraphPreVerifyItem[],
  options: {
    items?: GraphEvidenceRequest['items']
    quotes?: Record<string, GraphEvidenceCheck>
  } = {},
  run?: GraphSearchRun
) => checkGraphPreVerify({ items: options.items ?? [], preVerify }, root, options.quotes ?? {}, run)

const result = (stdout: string, code: number | null, stderr = '') => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false
})

describe.skipIf(!hasRg)('the pre-verify, against a real workspace and rg', () => {
  it('passes a citation that exists and is in range', async () => {
    const { preVerify } = await check([
      fact({ key: 'k', citations: [{ file: 'src/a.ts', line: 2 }] })
    ])
    expect(preVerify.k).toEqual({
      citations: [{ file: 'src/a.ts', line: 2, status: 'ok', lines: 3 }],
      searches: [],
      flags: []
    })
  })

  it('flags a line or range past the end of the file', async () => {
    const { preVerify } = await check([
      fact({ key: 'k', citations: [{ file: 'src/a.ts', line: 2, end: 9 }] })
    ])
    expect(preVerify.k!.citations[0]).toMatchObject({ status: 'past-end', lines: 3 })
    expect(preVerify.k!.flags).toEqual(['`src/a.ts:2-9` is past the end of the file (3 lines).'])
    expect(preVerify.k!.dropped).toBeUndefined()
  })

  it('finds a shortened path as the one file ending so, and re-checks its quote there', async () => {
    const { preVerify, checks } = await check(
      [fact({ key: 'k', citations: [{ file: 'core/b.ts', line: 1 }] })],
      {
        items: [
          { key: 'k', file: 'core/b.ts', line: 1, excerpt: 'export function startWatcher() {' }
        ],
        quotes: { k: { status: 'unreadable', line: 1 } }
      }
    )
    expect(preVerify.k!.citations).toEqual([
      { file: 'core/b.ts', line: 1, status: 'ok', lines: 3, at: 'pkg/core/b.ts' }
    ])
    expect(preVerify.k!.flags).toEqual([])
    expect(checks.k).toMatchObject({ status: 'found', line: 1 })
  })

  it('leaves a path several files end with unchecked, and unflagged', async () => {
    const { preVerify } = await check([fact({ key: 'k', citations: [{ file: 'c.ts', line: 1 }] })])
    expect(preVerify.k).toMatchObject({
      citations: [{ status: 'unknown', why: '2 files end with this path' }],
      flags: []
    })
    expect(preVerify.k!.dropped).toBeUndefined()
  })

  it('drops a result none of whose files exists, when its quote is nowhere', async () => {
    const { preVerify } = await check([
      fact({
        key: 'k',
        citations: [
          { file: 'src/gone.ts', line: 4 },
          { file: 'lib/also-gone.ts', line: 1 }
        ],
        probe: 'no file in this workspace holds this line'
      })
    ])
    expect(preVerify.k).toMatchObject({
      citations: [{ status: 'absent' }, { status: 'absent' }],
      flags: [
        '`src/gone.ts:4` is not a file in the workspace.',
        '`lib/also-gone.ts:1` is not a file in the workspace.'
      ],
      dropped:
        'None of the files it cites exists in the workspace: `src/gone.ts:4`, `lib/also-gone.ts:1`.'
    })
  })

  it('flags, never drops, a result whose quote is in a file it does not cite', async () => {
    const { preVerify } = await check([
      fact({
        key: 'k',
        citations: [{ file: 'src/gone.ts', line: 2 }],
        probe: 'const x = compute()'
      })
    ])
    expect(preVerify.k!.dropped).toBeUndefined()
    expect(preVerify.k!.flags).toContain('Its quote is in `src/a.ts`, not in any file it cites.')
  })

  it('54: tries another ellipsis fragment before dropping a bad-path report', async () => {
    const facts = graphPreVerifyItem({
      key: 'k',
      title: 'Watcher issue',
      detail: 'Concrete watcher evidence.',
      location: 'src/gone.ts:1',
      excerpt:
        'a longer fabricated fragment that is nowhere in the workspace ... export function startWatcher() {'
    })!
    const { preVerify } = await check([facts])
    expect(preVerify.k!.dropped).toBeUndefined()
    expect(preVerify.k!.flags).toContain(
      'Its quote is in `pkg/core/b.ts`, not in any file it cites.'
    )
  })

  it('never drops a result that resolves one citation, or whose location is not code', async () => {
    const { preVerify } = await check([
      fact({
        key: 'one',
        citations: [
          { file: 'src/gone.ts', line: 1 },
          { file: 'src/a.ts', line: 1 }
        ]
      }),
      fact({ key: 'prose', code: false, citations: [{ file: 'src/gone.ts', line: 1 }] })
    ])
    expect(preVerify.one!.dropped).toBeUndefined()
    expect(preVerify.prose!.dropped).toBeUndefined()
    expect(preVerify.prose!.flags).toEqual(['`src/gone.ts:1` is not a file in the workspace.'])
  })

  it('flags a path outside the workspace, or a link out of it, and never drops it', async () => {
    writeFileSync(join(base, 'outside.ts'), 'secret\n')
    symlinkSync(join(base, 'outside.ts'), join(root, 'link.ts'))
    const { preVerify } = await check([
      fact({
        key: 'k',
        citations: [
          { file: '../outside.ts', line: 1 },
          { file: 'link.ts', line: 1 }
        ]
      })
    ])
    expect(preVerify.k).toMatchObject({
      citations: [
        { status: 'unknown', why: 'outside the workspace' },
        { status: 'unknown', why: 'a link out of the workspace' }
      ],
      flags: [
        '`../outside.ts:1` is outside the workspace.',
        '`link.ts:1` is a link out of the workspace.'
      ]
    })
    expect(preVerify.k!.dropped).toBeUndefined()
  })

  it('flags a quote not found, and an absence without its search', async () => {
    const { preVerify } = await check(
      [fact({ key: 'k', citations: [{ file: 'src/a.ts', line: 2 }], absence: 'never called' })],
      { quotes: { k: { status: 'missing', line: 2 } } }
    )
    expect(preVerify.k!.flags).toEqual([
      'Its quote is not in the file it names, even with whitespace ignored.',
      'It says "never called" but gives no search that shows it.'
    ])
  })

  it('re-runs an absence search: any match is flagged, no match is not', async () => {
    const { preVerify } = await check([
      fact({
        key: 'hit',
        absence: 'never called',
        searches: ['rg -n startWatcher pkg', 'rg -F "compute()"']
      }),
      fact({ key: 'none', absence: 'never called', searches: ['rg stopWatcher src'] })
    ])
    expect(preVerify.hit!.searches).toEqual([
      { search: 'rg -n startWatcher pkg', hits: ['pkg/core/b.ts:1'] },
      { search: 'rg -F "compute()"', hits: ['src/a.ts:2'] }
    ])
    expect(preVerify.hit!.flags).toEqual([
      'It says "never called", but its search `rg -n startWatcher pkg` matches at pkg/core/b.ts:1.',
      'It says "never called", but its search `rg -F "compute()"` matches at src/a.ts:2.'
    ])
    expect(preVerify.none).toMatchObject({
      searches: [{ search: 'rg stopWatcher src', hits: [] }],
      flags: []
    })
  })

  it('flags a search it will not re-run, naming why', async () => {
    const { preVerify } = await check([
      fact({ key: 'k', absence: 'missing', searches: ['rg x ../', 'rg -u x', 'rg x nowhere'] })
    ])
    expect(preVerify.k!.searches.map((entry) => entry.error)).toEqual([
      '../ is outside the workspace',
      'the app does not re-run -u',
      'nowhere is not in the workspace'
    ])
    expect(preVerify.k!.flags[0]).toBe(
      'Its search `rg x ../` could not be re-run (../ is outside the workspace).'
    )
  })
})

describe('the pre-verify without a working rg', () => {
  it('drops nothing and says the searches could not be re-run', async () => {
    const run = vi.fn<GraphSearchRun>(async () => {
      throw new Error('spawn rg ENOENT')
    })
    const { preVerify } = await check(
      [
        fact({
          key: 'k',
          citations: [{ file: 'src/gone.ts', line: 1 }],
          absence: 'never called',
          searches: ['rg startWatcher'],
          probe: 'no file in this workspace holds this line'
        })
      ],
      {},
      run
    )
    expect(preVerify.k).toEqual({
      citations: [
        {
          file: 'src/gone.ts',
          line: 1,
          status: 'unknown',
          why: "the workspace's files could not be listed"
        }
      ],
      absence: 'never called',
      searches: [{ search: 'rg startWatcher', error: 'ripgrep (rg) could not be started' }],
      flags: [
        'Its search `rg startWatcher` could not be re-run (ripgrep (rg) could not be started).'
      ]
    })
  })

  it('lists the workspace once for every citation it has to look for', async () => {
    const run = vi.fn<GraphSearchRun>(async () => result('pkg/core/b.ts\nsrc/a.ts\n', 0))
    await check(
      [
        fact({ key: 'a', citations: [{ file: 'core/b.ts', line: 1 }] }),
        fact({ key: 'b', citations: [{ file: 'b.ts', line: 2 }] })
      ],
      {},
      run
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![0]).toMatchObject({
      program: 'rg',
      args: expect.arrayContaining(['--files', '--hidden']),
      cwd: root
    })
  })

  it('re-runs at most thirty searches a round', async () => {
    const run = vi.fn<GraphSearchRun>(async () => result('', 1))
    const searches = ['rg one', 'rg two', 'rg three']
    const { preVerify } = await check(
      Array.from({ length: 11 }, (_, at) => fact({ key: `k${at}`, absence: 'missing', searches })),
      {},
      run
    )
    expect(run).toHaveBeenCalledTimes(30)
    expect(preVerify.k10!.searches.map((entry) => entry.error)).toEqual(
      Array(3).fill('the app re-runs at most 30 searches a round')
    )
    expect(preVerify.k10!.flags).toEqual([])
  })
})

describe('one search, as rg answers it', () => {
  const search = (stdout: string, code: number | null, stderr = '', timedOut = false) =>
    runGraphSearch('rg -n x', root, async () => ({ ...result(stdout, code, stderr), timedOut }))

  it('runs only allowlisted arguments, in the workspace, with a deadline', async () => {
    const run = vi.fn<GraphSearchRun>(async () => result('', 1))
    await runGraphSearch('rg -wi --type ts "a b" src', root, run)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'rg',
        cwd: root,
        timeoutMs: 5_000,
        args: [
          '--no-config',
          '--color',
          'never',
          '--path-separator',
          '/',
          '--no-heading',
          '--with-filename',
          '--line-number',
          '--max-count',
          '5',
          '-w',
          '-i',
          '--type',
          'ts',
          '-e',
          'a b',
          '--',
          'src'
        ]
      })
    )
  })

  it('keeps the first five hits, and counts a match even when rg also failed', async () => {
    const rows = Array.from({ length: 7 }, (_, at) => `./src/f${at}.ts:${at + 1}:x`).join('\n')
    expect(await search(rows, 0)).toEqual({
      search: 'rg -n x',
      hits: ['src/f0.ts:1', 'src/f1.ts:2', 'src/f2.ts:3', 'src/f3.ts:4', 'src/f4.ts:5'],
      more: true
    })
    expect(await search('src/a.ts:3:x\n', 2, 'rg: denied: Permission denied')).toEqual({
      search: 'rg -n x',
      hits: ['src/a.ts:3']
    })
  })

  it('reports an error or a timeout as not re-run', async () => {
    expect(await search('', 2, 'rg: regex parse error:\n  x(\n')).toEqual({
      search: 'rg -n x',
      error: 'rg: regex parse error:'
    })
    expect(await search('', null, '', true)).toEqual({
      search: 'rg -n x',
      error: 'it took over 5 s'
    })
  })
})

describe('the evidence checker with a pre-verify', () => {
  const call = (preVerify?: GraphPreVerifyItem[]): GraphCall => ({
    id: 'verify/r1/evidence',
    prompt: '',
    schema: {},
    output: 'text',
    seatId: 'evidence',
    dependencies: [],
    stepId: 'verify',
    round: 1,
    agentIndex: 6,
    evidence: {
      items: [{ key: 'k', file: 'src/a.ts', line: 2, excerpt: 'const x = compute()' }],
      ...(preVerify ? { preVerify } : {})
    },
    validateSemantics: () => null
  })
  const store = () => new GraphJevStore(join(base, 'records', 'evidence.json'))
  const verified = {
    k: { citations: [], searches: [], flags: ['A flag.'] },
    j: { citations: [], searches: [], flags: ['Gone.'], dropped: 'None exists.' }
  }

  it('never runs it, nor changes the outcome, for a request without one', async () => {
    const preVerify = vi.fn<typeof checkGraphPreVerify>()
    const outcome = await createGraphEvidenceChecker({
      store: store(),
      workspace: async () => root,
      preVerify
    })(call())
    expect(preVerify).not.toHaveBeenCalled()
    expect(outcome).toEqual({
      value: {
        markdown:
          'Quotes checked in the files: 1 found at their line, 0 found elsewhere in the file, 0 not found in the file, 0 in files that could not be read.',
        checks: { k: { status: 'found', line: 2, context: expect.any(String) } }
      }
    })
  })

  it('keeps its result with the quote checks, and replays it from the record', async () => {
    const preVerify = vi.fn<typeof checkGraphPreVerify>(async (_request, _root, checks) => ({
      preVerify: verified,
      checks
    }))
    const facts = [fact({ key: 'k', citations: [{ file: 'src/a.ts', line: 2 }] })]
    const outcome = await createGraphEvidenceChecker({
      store: store(),
      workspace: async () => root,
      preVerify
    })(call(facts))
    expect(preVerify).toHaveBeenCalledWith(call(facts).evidence, root, {
      k: expect.objectContaining({ status: 'found' })
    })
    expect(outcome).toMatchObject({ value: { preVerify: verified } })
    expect((outcome as { value: { markdown: string } }).value.markdown).toContain(
      'Citations and absence searches checked before review: 2 results, 1 dropped (no file they cite exists), 1 flagged for the reviewers.'
    )
    const replayed = await createGraphEvidenceChecker({ store: store(), cacheOnly: true })(
      call(facts)
    )
    expect(replayed).toEqual(outcome)
    await expect(
      createGraphEvidenceChecker({ store: store(), cacheOnly: true })(call())
    ).rejects.toThrow('not recorded')
  })

  it('skips it when the run has no workspace', async () => {
    const preVerify = vi.fn<typeof checkGraphPreVerify>()
    const outcome = await createGraphEvidenceChecker({ store: store(), preVerify })(
      call([fact({ key: 'k', citations: [{ file: 'src/a.ts', line: 2 }] })])
    )
    expect(preVerify).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ value: { error: 'this run has no workspace folder' } })
    expect(outcome).not.toHaveProperty('value.preVerify')
  })
})
