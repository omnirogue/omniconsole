import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { createGraphChecker, graphCandidateCode, runGraphCheck } from './graph-check'
import { graphCheckScore } from './graph-check-cases'
import { graphCheckArgv } from './graph-check-launch'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan'
import { drive, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

function checked(
  check: { command: string; stopWhenPassing?: boolean },
  maxRounds = 4
): WorkflowSpec {
  const spec = workflowTemplate('improve', ROUTES)
  return { ...spec, repeat: { ...spec.repeat!, maxRounds, check } }
}

/** A scripted check: the version text decides pass and score, e.g. "v2 pass 7". */
function answer(judge: (call: GraphCall) => unknown = () => undefined) {
  return (call: GraphCall) => {
    if (call.check) {
      const [, verdict, score] = call.check.candidate.split(' ')
      return {
        markdown: 'check',
        passed: verdict === 'pass',
        ...(score ? { score: Number(score) } : {}),
        detail: `output of ${call.check.candidate}`
      }
    }
    if (call.jev || call.stepId === 'judge') {
      return judge(call)
    }
    return undefined
  }
}

const trailOf = (plan: ReturnType<typeof drive>) => plan.loop!.improve!

describe('Improve with an objective check', () => {
  it('lets a passing challenger beat a failing best version without asking a judge', () => {
    const versions = ['v1 fail', 'v2 pass']
    const plan = drive(checked({ command: 'npm test' }, 2), (call) =>
      call.stepId === 'improve' && !call.check ? text(versions[call.round - 1]!) : answer()(call)
    )
    expect(trailOf(plan).rounds.map((round) => round.result)).toEqual(['first', 'new-best'])
    expect(trailOf(plan).rounds[1]!.judgedBy).toEqual(['check'])
    expect(plan.calls.some((call) => call.stepId === 'judge')).toBe(false)
    expect(plan.outcome?.final?.markdown.startsWith('v2 pass')).toBe(true)
  })

  it('keeps a passing best version when the challenger fails, even if a judge would prefer it', () => {
    const versions = ['v1 pass', 'v2 fail']
    const plan = drive(checked({ command: 'npm test' }, 2), (call) =>
      call.stepId === 'improve' && !call.check
        ? text(versions[call.round - 1]!)
        : answer(() => text('FINAL RANKING:\n1. Response B\n2. Response A'))(call)
    )
    expect(trailOf(plan).rounds[1]).toMatchObject({ result: 'kept', judgedBy: ['check'] })
    expect(plan.outcome?.final?.markdown.startsWith('v1 pass')).toBe(true)
  })

  it('ranks by score, and asks the judges only when the check cannot tell versions apart', () => {
    const versions = ['v1 pass 5', 'v2 pass 9', 'v3 pass 9']
    const plan = drive(checked({ command: 'node bench.mjs {code}' }, 3), (call) =>
      call.stepId === 'improve' && !call.check
        ? text(versions[call.round - 1]!)
        : answer((judge) =>
            judge.jev ? { markdown: 'FINAL RANKING:\n1. Response A\n2. Response B' } : undefined
          )(call)
    )
    const rounds = trailOf(plan).rounds
    expect(rounds[1]).toMatchObject({ result: 'new-best', judgedBy: ['check'] })
    // Equal scores: the judges decide, and a tie keeps the best version.
    expect(rounds[2]!.judgedBy).toContain('check')
    expect(rounds[2]!.judgedBy).toContain('jev')
    expect(rounds[2]!.candidates.every((candidate) => candidate.check?.score === 9)).toBe(true)
  })

  it('stops as soon as the best version passes, when asked to', () => {
    const versions = ['v1 fail', 'v2 pass', 'v3 pass']
    const plan = drive(checked({ command: 'npm test', stopWhenPassing: true }, 5), (call) =>
      call.stepId === 'improve' && !call.check ? text(versions[call.round - 1]!) : answer()(call)
    )
    expect(trailOf(plan).stop).toBe('verified')
    expect(trailOf(plan).rounds).toHaveLength(2)
    expect(plan.outcome?.final?.markdown).toContain('the best version passes the check')
  })

  it('tells the improvers how they are tested, and what the best version still fails', () => {
    const versions = ['v1 fail', 'v2 fail']
    const plan = drive(checked({ command: 'npm test' }, 2), (call) =>
      call.stepId === 'improve' && !call.check
        ? text(versions[call.round - 1]!)
        : answer(() => text('FINAL RANKING:\n1. Response A\n2. Response B'))(call)
    )
    const first = plan.calls.find((call) => call.id === 'improve/r1/a0')!.prompt
    const second = plan.calls.find((call) => call.id === 'improve/r2/a0')!.prompt
    expect(first).toContain('`npm test`')
    expect(second).toContain('FAILS it')
    expect(second).toContain('output of v1 fail')
  })

  it('names a check that could not run instead of quietly judging without it', () => {
    const plan = drive(checked({ command: 'missing-program' }, 2), (call) =>
      call.check
        ? undefined
        : call.stepId === 'improve'
          ? text(`v${call.round}`)
          : call.jev
            ? { markdown: 'FINAL RANKING:\n1. Response A\n2. Response B' }
            : undefined
    )
    expect(plan.outcome?.gaps.join(' ')).toContain('The check could not run')
    expect(trailOf(plan).rounds[0]!.candidates[0]!.check).toMatchObject({ unavailable: true })
  })

  it('skips JEV and model judges when every challenger is identical to the best version', () => {
    const versions = ['v1 pass 9', '  v1 pass 9\n']
    const plan = drive(checked({ command: 'node bench.mjs {code}' }, 2), (call) =>
      call.stepId === 'improve' && !call.check ? text(versions[call.round - 1]!) : answer()(call)
    )
    expect(trailOf(plan).rounds[1]).toMatchObject({ result: 'kept', judgedBy: ['check'] })
    expect(plan.calls.some((call) => call.stepId === 'judge')).toBe(false)
  })
})

describe('the check runner', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('splits a command line without a shell', () => {
    expect(graphCheckArgv('node "my bench.mjs" --n 3 {code}')).toEqual([
      'node',
      'my bench.mjs',
      '--n',
      '3',
      '{code}'
    ])
    expect(graphCheckArgv(`python3 -c 'print(1)'`)).toEqual(['python3', '-c', 'print(1)'])
    expect(graphCheckArgv('   ')).toEqual([])
  })

  it('reads the last SCORE line and the largest code block', () => {
    expect(graphCheckScore('SCORE: 1\nnoise\nSCORE: 2.5\n')).toBe(2.5)
    expect(graphCheckScore('score is 3')).toBeUndefined()
    expect(graphCandidateCode('Intro\n```py\nprint(2)\n```\n```js\nconsole.log(1)\n```')).toEqual({
      code: 'console.log(1)\n',
      extension: 'js'
    })
    expect(graphCandidateCode('no code')).toBeUndefined()
  })

  it('runs the command on the version and its code, and keeps the result for replay', async () => {
    dir = mkdtempSync(join(tmpdir(), 'graph-check-'))
    const bench = join(dir, 'bench.mjs')
    writeFileSync(
      bench,
      [
        "import { readFileSync } from 'node:fs'",
        'const code = readFileSync(process.argv[2], "utf8")',
        'console.log("SCORE: " + code.length)',
        'process.exit(code.includes("ok") ? 0 : 1)'
      ].join('\n')
    )
    const candidate = 'My answer\n```js\nconst ok = 1\n```'
    const result = await runGraphCheck(
      { command: `"${process.execPath}" bench.mjs {code}`, candidate },
      { cwd: dir }
    )
    expect(result).toMatchObject({ passed: true, score: 'const ok = 1\n'.length })
    const failing = await runGraphCheck(
      { command: `"${process.execPath}" bench.mjs {code}`, candidate: '```js\nnope\n```' },
      { cwd: dir }
    )
    expect(failing.passed).toBe(false)
    const missing = await runGraphCheck(
      { command: 'definitely-not-a-program-omni', candidate },
      { cwd: dir }
    )
    expect(missing).toMatchObject({ passed: false, unavailable: true })

    const store = GraphJevStore.forExecution('exec-check', dir, 'checks.json')
    const starts = GraphJevStore.forExecution('exec-check', dir, 'check-starts.json')
    let runs = 0
    const checker = createGraphChecker({
      store,
      starts,
      workspace: async () => dir,
      run: async () => {
        runs++
        return { code: 0, signal: null, stdout: 'SCORE: 4\n', stderr: '', timedOut: false }
      }
    })
    const call = {
      id: 'improve/r1/a0/check',
      check: { command: 'npm test', candidate }
    } as GraphCall
    const first = await checker(call)
    expect(await checker(call)).toEqual(first)
    expect(runs).toBe(1)
    const replay = createGraphChecker({ store, starts, cacheOnly: true })
    expect(await replay(call)).toEqual(first)
    await expect(replay({ ...call, id: 'other/check' })).rejects.toThrow('not recorded')
  })
})
