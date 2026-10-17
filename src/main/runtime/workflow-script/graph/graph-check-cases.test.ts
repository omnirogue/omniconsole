import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../../shared/child-process/process-spec'
import { createGraphChecker, runGraphCheck } from './graph-check'
import { graphCheckScore, runGraphCheckCases, type GraphCheckRun } from './graph-check-cases'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan'

// Passes a case that starts with "ok", hangs on "slow", and proves {case} and $OMNI_CASE_FILE agree.
const SCRIPT = [
  "import { readFileSync } from 'node:fs'",
  'const text = process.argv[2]',
  'if (readFileSync(process.env.OMNI_CASE_FILE, "utf8") !== text) {',
  '  console.log("case file differs")',
  '  process.exit(3)',
  '}',
  'if (text === "slow") setInterval(() => {}, 1000)',
  'else {',
  '  console.log("SCORE: 1000")',
  '  console.log("SCORE: " + text.length)',
  '  process.exit(text.startsWith("ok") ? 0 : 1)',
  '}'
].join('\n')

const done = (stdout: string, code = 0): ProcessResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

describe('practice cases', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-check-cases-'))
    writeFileSync(join(dir, 'case.mjs'), SCRIPT)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const command = `"${process.execPath}" case.mjs {case}`

  it('runs every case in turn, fills {case} and $OMNI_CASE_FILE, and fails a case that times out', async () => {
    const result = await runGraphCheck(
      {
        command,
        candidate: 'v1',
        scoreLastLine: true,
        cases: ['ok one', 'bad', 'ok {code} stays', 'slow'],
        timeoutSeconds: 2
      },
      { cwd: dir }
    )
    expect(result).toMatchObject({
      passed: false,
      cases: { total: 4, passed: 2, unavailable: 0 }
    })
    expect(result.unavailable).toBeUndefined()
    // A case that printed no score leaves the version without one.
    expect(result.score).toBeUndefined()
    expect(result.detail).toContain('2 of 4 practice cases passed.')
    expect(result.detail).toContain('Case 1 (ok one): passed · SCORE 6')
    expect(result.detail).toContain('Case 2 (bad): failed · SCORE 3')
    expect(result.detail).toContain('Case 3 (ok {code} stays): passed')
    expect(result.detail).toContain('Case 4 (slow): timed out after 2s')
    expect(result.detail).toContain('Case 2 output:')
  }, 30_000)

  it('passes a version only when every case passes, scored by the mean of its cases', async () => {
    const result = await runGraphCheck(
      { command, candidate: 'v1', scoreLastLine: true, cases: ['ok', 'okay'] },
      { cwd: dir }
    )
    expect(result).toMatchObject({ passed: true, score: 3, cases: { total: 2, passed: 2 } })
  }, 30_000)

  it('does not run a case the version budget leaves no time for, and never counts it passed', async () => {
    const clock = [0, 0, 1_500_000, 1_900_000]
    const launch = vi.fn(async ({ timeoutMs }: { timeoutMs: number }): Promise<GraphCheckRun> =>
      timeoutMs < 600_000 ? { ...done(''), timedOut: true } : done('SCORE: 1')
    )
    const result = await runGraphCheckCases(
      { command: 'x', candidate: 'v', cases: ['a', 'b', 'c'] },
      { dir, launch, timeoutMs: 600_000, now: () => clock.shift() ?? 2_000_000 }
    )
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch.mock.calls[1]![0].timeoutMs).toBe(300_000)
    expect(result).toMatchObject({
      passed: false,
      cases: { total: 3, passed: 1, unavailable: 2 }
    })
    expect(result.unavailable).toBeUndefined()
    expect(result.detail).toContain('Case 2 (b): could not run')
  })

  it('reports a version whose cases could not start at all as unavailable', async () => {
    const launch = async (): Promise<GraphCheckRun> => ({ error: 'spawn ENOENT' })
    const result = await runGraphCheckCases(
      { command: 'x', candidate: 'v', cases: ['a', 'b'] },
      { dir, launch, timeoutMs: 1_000 }
    )
    expect(result).toMatchObject({
      passed: false,
      unavailable: true,
      cases: { total: 2, passed: 0, unavailable: 2 }
    })
  })
})

describe('the SCORE line', () => {
  it('counts only the last non-empty line under rules 2, and any SCORE line before', async () => {
    expect(graphCheckScore('SCORE: 5\nmore output\n', true)).toBeUndefined()
    expect(graphCheckScore('noise\nSCORE: 5\n\n  \n', true)).toBe(5)
    expect(graphCheckScore('SCORE: 5\nmore output\n')).toBe(5)
    const run = async () => done('SCORE: 9\ndone\n')
    const strict = await runGraphCheck(
      { command: 'x', candidate: 'v', scoreLastLine: true },
      { cwd: tmpdir(), run }
    )
    expect(strict.score).toBeUndefined()
    const old = await runGraphCheck({ command: 'x', candidate: 'v' }, { cwd: tmpdir(), run })
    expect(old.score).toBe(9)
  })

  it('runs a case-less check with its own time limit', async () => {
    const run = vi.fn(async (_spec: ProcessSpec) => done('ok'))
    await runGraphCheck(
      { command: 'x', candidate: 'v', timeoutSeconds: 30 },
      { cwd: tmpdir(), run }
    )
    expect(run.mock.calls[0]![0]).toMatchObject({ timeoutMs: 30_000 })
  })
})

describe('replay of a check with practice cases', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('never runs a check when only recorded results may be used', async () => {
    dir = mkdtempSync(join(tmpdir(), 'graph-check-replay-'))
    const store = GraphJevStore.forExecution('exec-cases', dir, 'checks.json')
    const starts = GraphJevStore.forExecution('exec-cases', dir, 'check-starts.json')
    const run = vi.fn(async () => done('SCORE: 1'))
    const call = {
      id: 'improve/r1/a0/check',
      check: { command: 'npm test', candidate: 'v1', scoreLastLine: true, cases: ['a'] }
    } as GraphCall
    const replay = createGraphChecker({
      store,
      starts,
      cacheOnly: true,
      run,
      workspace: async () => dir
    })
    await expect(replay(call)).rejects.toThrow('not recorded')
    expect(run).not.toHaveBeenCalled()
    const live = createGraphChecker({ store, starts, run, workspace: async () => dir })
    const first = await live(call)
    expect(run).toHaveBeenCalledTimes(1)
    expect(await replay(call)).toEqual(first)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
