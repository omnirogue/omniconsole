import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { independentReviewTriggers } from '../../../../src/shared/orchestration-task-templates'
import { claudeTranscriptUsage, codexRolloutUsage, transcriptUsage } from './agent-transcript-usage'
import {
  pairTasks,
  reportMarkdown,
  summarizeArm,
  type ArmRun,
  type TokenUsage
} from './direct-vs-coordinated-report'
import { reviewVerdict, runArm } from './direct-vs-coordinated-run'
import type { BenchDeps, BenchOptions, BenchTask } from './direct-vs-coordinated-stage'
import {
  IMPLEMENT_BOUNDED_KIT_DIR,
  materializeFixture,
  verifyAcceptance
} from './implement-bounded-verify'

const TASKS = (
  JSON.parse(readFileSync(join(IMPLEMENT_BOUNDED_KIT_DIR, 'tasks.json'), 'utf8')) as {
    tasks: BenchTask[]
  }
).tasks
const task = (id: string): BenchTask => TASKS.find((entry) => entry.id === id)!

const OPTIONS: BenchOptions = {
  runId: 'run_1',
  workspace: 'path:/bench',
  host: 'Mac Studio',
  owner: 'Benchmark harness',
  implementer: { agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  reviewer: { agent: 'codex' },
  stageTimeoutMs: 600_000
}

const USAGE: TokenUsage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }

type Script = {
  /** One entry per QA run. */
  qa: { pass: number; fail: number }[]
  review?: string
  usage?: (agent: string) => TokenUsage | 'unknown'
  /** worker-start is refused for this stage number (1-based). */
  refuseStart?: number
  /** No report ever arrives; the worker sits on a prompt. */
  neverReports?: boolean
}

function fakeDeps(script: Script): { deps: BenchDeps; calls: string[][] } {
  const calls: string[][] = []
  let clock = 1_000
  let stageNumber = 0
  let qaNumber = 0
  const reply = (result: unknown) => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, result }),
    stderr: ''
  })
  const deps: BenchDeps = {
    omni: async (args) => {
      calls.push(args)
      clock += 1_000
      const command = args.slice(0, 2).join(' ')
      if (command === 'orchestration task-create') {
        stageNumber += 1
        return reply({ task: { id: `task_${stageNumber}` } })
      }
      if (command === 'orchestration worker-start') {
        return script.refuseStart === stageNumber
          ? {
              code: 1,
              stdout: JSON.stringify({ ok: false, error: { message: 'no capacity' } }),
              stderr: ''
            }
          : reply({ dispatchId: `ctx_${stageNumber}` })
      }
      if (command === 'orchestration check' && args.includes('--wait')) {
        clock += 30_000
        return script.neverReports
          ? reply({ deliveryId: null, messages: [] })
          : reply({
              deliveryId: `delivery_${stageNumber}`,
              messages: [
                {
                  id: `msg_${stageNumber}`,
                  type: 'worker_done',
                  body: 'done',
                  payload: JSON.stringify({
                    dispatchId: `ctx_${stageNumber}`,
                    outcome: 'succeeded'
                  })
                }
              ]
            })
      }
      if (command === 'orchestration worker-show' && args.includes('--receipt')) {
        return reply({
          receipt: {
            route: { actual: { model: 'observed-model' } },
            phaseDurations: { startupMs: 3_000 }
          }
        })
      }
      if (command === 'orchestration worker-show') {
        return reply({
          worker: { agent_terminal_handle: `term_${stageNumber}` },
          observation: script.neverReports ? { agentWait: { source: 'hook' } } : { agentWait: null }
        })
      }
      if (command === 'session list') {
        return reply({
          sessions: [{ terminal: `term_${stageNumber}`, transcriptPath: '/t.jsonl' }]
        })
      }
      return reply({})
    },
    materialize: (label) => `/bench/run/${label}`,
    verify: async () => {
      clock += 2_000
      const result = script.qa[qaNumber] ?? { pass: 0, fail: 1 }
      qaNumber += 1
      return { ...result, output: 'not ok 1 - folds diacritics' }
    },
    readUsage: (_path, agent) => (script.usage ? script.usage(agent) : USAGE),
    readText: (path) => (path.endsWith('REVIEW.md') ? (script.review ?? null) : null),
    now: () => clock,
    log: () => undefined
  }
  return { deps, calls }
}

describe('direct versus coordinated runs', () => {
  it('direct: one agent, one QA run, no intervention when acceptance passes', async () => {
    const { deps, calls } = fakeDeps({ qa: [{ pass: 6, fail: 0 }] })
    const run = await runArm(deps, OPTIONS, 'direct', task('slug'), 1)
    expect(run.stages.map((stage) => stage.stage)).toEqual(['implement'])
    expect(run).toMatchObject({
      verified: true,
      firstPassVerified: true,
      retries: 0,
      humanInterventions: 0,
      review: 'not-justified'
    })
    expect(run.stages[0]).toMatchObject({
      observedModel: 'observed-model',
      startupMs: 3_000,
      tokens: USAGE
    })
    const [stage] = run.stages
    expect(stage!.startedAtMs).toBeLessThan(stage!.launchedAtMs!)
    expect(stage!.launchedAtMs!).toBeLessThan(stage!.reportedAtMs!)
    expect(stage!.reportedAtMs!).toBeLessThan(stage!.endedAtMs)
    const start = calls.find((args) => args[1] === 'worker-start')!
    expect(start).toEqual(
      expect.arrayContaining(['--close-on-completion', '--model', 'claude-sonnet-5-5'])
    )
    // The worker is observed before the ack releases its terminal.
    const order = calls.map((args) => (args.includes('--ack') ? 'ack' : args.slice(0, 2).join(' ')))
    expect(order.indexOf('session list')).toBeLessThan(order.indexOf('ack'))
  })

  it('direct: a failed acceptance run costs one human intervention and one repair', async () => {
    const { deps, calls } = fakeDeps({
      qa: [
        { pass: 4, fail: 2 },
        { pass: 6, fail: 0 }
      ]
    })
    const run = await runArm(deps, OPTIONS, 'direct', task('slug'), 1)
    expect(run.stages.map((stage) => stage.stage)).toEqual(['implement', 'repair'])
    expect(run).toMatchObject({
      verified: true,
      firstPassVerified: false,
      retries: 1,
      humanInterventions: 1
    })
    const repairSpec = calls.filter((args) => args[1] === 'task-create')[1]!
    expect(repairSpec[repairSpec.indexOf('--spec') + 1]).toContain('not ok 1 - folds diacritics')
  })

  it('coordinated: reviews only a brief that touches a guard family', async () => {
    expect(independentReviewTriggers(task('slug').objective)).toEqual([])
    expect(independentReviewTriggers(task('usage-rollup').objective)).toEqual([])
    expect(independentReviewTriggers(task('host-guard').objective)).toEqual([
      'permissions',
      'cross-host'
    ])

    const plain = fakeDeps({ qa: [{ pass: 6, fail: 0 }] })
    const unreviewed = await runArm(plain.deps, OPTIONS, 'coordinated', task('slug'), 1)
    expect(unreviewed.stages.map((stage) => stage.stage)).toEqual(['implement'])
    expect(unreviewed.review).toBe('not-justified')

    const guarded = fakeDeps({ qa: [{ pass: 7, fail: 0 }], review: 'Looks right.\nVERDICT: pass' })
    const reviewed = await runArm(guarded.deps, OPTIONS, 'coordinated', task('host-guard'), 1)
    expect(reviewed.stages.map((stage) => `${stage.stage}:${stage.agent}`)).toEqual([
      'implement:claude',
      'review:codex'
    ])
    expect(reviewed).toMatchObject({
      review: 'pass',
      retries: 0,
      humanInterventions: 0,
      verified: true
    })
  })

  it('coordinated: a blocking review is repaired without a person, then re-verified', async () => {
    const { deps } = fakeDeps({
      qa: [
        { pass: 7, fail: 0 },
        { pass: 7, fail: 0 }
      ],
      review: 'src/host-guard.mjs:12 inherited keys pass.\nVERDICT: block'
    })
    const run = await runArm(deps, OPTIONS, 'coordinated', task('host-guard'), 1)
    expect(run.stages.map((stage) => stage.stage)).toEqual(['implement', 'review', 'repair'])
    expect(run).toMatchObject({
      review: 'block',
      retries: 1,
      humanInterventions: 0,
      verified: true
    })
    expect(run.qa).toHaveLength(2)
  })

  it('a refused start is an error with no invented duration', async () => {
    const { deps } = fakeDeps({ qa: [], refuseStart: 1 })
    const run = await runArm(deps, OPTIONS, 'direct', task('slug'), 1)
    expect(run.error).toContain('no capacity')
    expect(run.verified).toBe(false)
    const summary = summarizeArm('direct', [run])
    expect(summary).toMatchObject({ runs: 1, errors: 1, meanWallClockMs: null, verified: 0 })
  })

  it('a worker waiting on a person is counted and never stopped', async () => {
    const { deps, calls } = fakeDeps({ qa: [], neverReports: true })
    const run = await runArm(
      deps,
      { ...OPTIONS, stageTimeoutMs: 90_000 },
      'direct',
      task('slug'),
      1
    )
    expect(run.stages[0]).toMatchObject({
      outcome: 'timeout',
      detail: 'The worker is waiting on a person.'
    })
    expect(run.humanInterventions).toBe(1)
    expect(calls.some((args) => ['worker-stop', 'worker-abandon'].includes(args[1]!))).toBe(false)
    expect(calls.some((args) => args[0] === 'terminal')).toBe(false)
  })
})

describe('direct versus coordinated report', () => {
  const run = (patch: Partial<ArmRun>): ArmRun => ({
    arm: 'direct',
    taskId: 'slug',
    rep: 1,
    startedAtMs: 0,
    endedAtMs: 60_000,
    stages: [
      {
        stage: 'implement',
        dispatchId: 'ctx_1',
        agent: 'claude',
        observedModel: 'm',
        startedAtMs: 2_000,
        launchedAtMs: 5_000,
        reportedAtMs: 45_000,
        endedAtMs: 46_000,
        outcome: 'succeeded',
        startupMs: 3_000,
        tokens: USAGE
      }
    ],
    qa: [{ startedAtMs: 46_000, endedAtMs: 48_000, pass: 6, fail: 0 }],
    verified: true,
    firstPassVerified: true,
    retries: 0,
    humanInterventions: 0,
    coordinatorQuestions: 0,
    review: 'not-justified',
    ...patch
  })

  it('splits wall clock into agent, QA and coordination time', () => {
    const summary = summarizeArm('direct', [run({})])
    expect(summary).toMatchObject({
      meanWallClockMs: 60_000,
      meanAgentMs: 40_000,
      meanQaMs: 2_000,
      meanCoordinationMs: 18_000,
      tokens: USAGE,
      costUsd: 'unknown'
    })
  })

  it('keeps tokens unknown when one stage did not report, with the known part beside it', () => {
    const second = run({ arm: 'direct', taskId: 'usage-rollup' })
    second.stages = [{ ...second.stages[0]!, tokens: 'unknown', reportedAtMs: null }]
    const summary = summarizeArm('direct', [run({}), second])
    expect(summary.tokens).toBe('unknown')
    // A stage with no report time leaves agent and coordination time unknown, never guessed.
    expect(summary).toMatchObject({
      meanWallClockMs: 60_000,
      meanAgentMs: null,
      meanCoordinationMs: null
    })
    expect(summary.partialTokens).toEqual({ ...USAGE, reportedStages: 1, stages: 2 })
    const markdown = reportMarkdown({
      set: 'implement-bounded',
      setVersion: 1,
      startedAt: '2026-10-03T00:00:00.000Z',
      host: 'Mac Studio',
      runs: [],
      arms: [summary],
      pairs: [],
      notes: []
    })
    expect(markdown).toContain('direct tokens: unknown (1 of 2 agent stages reported')
    expect(markdown).toContain('Cost: unknown')
  })

  it('pairs the two arms of one task and leaves a missing side unknown', () => {
    const pairs = pairTasks([
      run({}),
      run({ arm: 'coordinated', endedAtMs: 150_000 }),
      run({ taskId: 'host-guard' }),
      run({ taskId: 'host-guard', arm: 'coordinated', error: 'review timeout', verified: false })
    ])
    expect(pairs[0]).toMatchObject({
      taskId: 'slug',
      wallClockRatio: 2.5,
      coordinatedVerified: true
    })
    expect(pairs[1]).toMatchObject({
      taskId: 'host-guard',
      coordinatedWallClockMs: null,
      wallClockRatio: null,
      coordinatedVerified: false
    })
  })

  it('reads the last verdict line only', () => {
    expect(reviewVerdict('VERDICT: block\nfixed\nVERDICT: pass')).toBe('pass')
    expect(reviewVerdict('no verdict here')).toBe('unknown')
    expect(reviewVerdict(null)).toBe('unknown')
  })
})

describe('agent transcript usage', () => {
  it('counts each Claude API message once', () => {
    const line = (id: string, input: number, output: number) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 50 }
        }
      })
    const text = [
      line('m1', 3, 10),
      line('m1', 3, 10),
      line('m2', 1, 4),
      '{"type":"user"}',
      '{torn'
    ].join('\n')
    expect(claudeTranscriptUsage(text)).toEqual({
      input: 4,
      output: 14,
      cacheRead: 100,
      cacheWrite: 0
    })
    expect(claudeTranscriptUsage('{"type":"user"}')).toBe('unknown')
  })

  it('takes the last Codex running total and separates cached input', () => {
    const event = (input: number, cached: number, output: number) =>
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output
            }
          }
        }
      })
    expect(codexRolloutUsage([event(100, 60, 5), event(300, 200, 9)].join('\n'))).toEqual({
      input: 100,
      output: 9,
      cacheRead: 200,
      cacheWrite: 0
    })
    expect(
      codexRolloutUsage('{"type":"event_msg","payload":{"type":"token_count","info":null}}')
    ).toBe('unknown')
  })

  it('is unknown for a missing transcript or an agent it cannot read', () => {
    expect(transcriptUsage('claude', null)).toBe('unknown')
    expect(transcriptUsage('gemini', '{}')).toBe('unknown')
  })
})

describe('implement-bounded set', () => {
  let scratch: string | null = null
  afterEach(() => {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true })
      scratch = null
    }
  })

  it('fails every acceptance test on the untouched fixture and passes on the reference', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'implement-bounded-'))
    const dir = join(scratch, 'fixture')
    materializeFixture(dir)
    for (const entry of TASKS) {
      const stub = await verifyAcceptance(dir, entry)
      expect(stub.pass, entry.id).toBe(0)
      expect(stub.fail, entry.id).toBeGreaterThan(0)
    }
    cpSync(join(IMPLEMENT_BOUNDED_KIT_DIR, 'reference'), join(dir, 'src'), { recursive: true })
    for (const entry of TASKS) {
      const reference = await verifyAcceptance(dir, entry)
      expect(reference.fail, entry.id).toBe(0)
      expect(reference.pass, entry.id).toBeGreaterThan(4)
    }
  })
})
