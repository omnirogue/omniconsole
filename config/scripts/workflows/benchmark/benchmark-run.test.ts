import { summarizeDiscoverRounds } from './benchmark-rounds'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKFLOW_ROUTE_MODELS } from '../../../../src/main/runtime/workflow-script/local-workflow-models'
import {
  localWorkflowRunRequestSchema,
  localWorkflowRunSpec
} from '../../../../src/shared/local-workflow-run-request'
import type { DecisionResult } from '../../../../src/shared/structured-decisions'
import type { WorkflowRoute } from '../../../../src/shared/workflow-graph'
import { workflowModelsFlagPlan } from '../../../../src/shared/workflow-models-flag'
import { reportMarkdown, stat, summarizeArm } from './benchmark-report'
import { QUICK_DISCOVER_RUN, RECORDED_DISCOVER_RUN, fakeRun } from './benchmark-fakes'
import {
  readArms,
  runBenchmark,
  screenKeepProbabilities,
  type Arm,
  type Exec
} from './benchmark-run'

const noul = (probability: number): DecisionResult => ({
  provider: 'typesafe',
  model: 'jev-1.13.0',
  answers: { yes: { type: 'noul', noul: probability } },
  usage: { inputTokens: 2_000, outputTokens: 0 }
})
const ask = vi.fn(async () => noul(0.7))
const rank = vi.fn(async () => ({
  method: 'pairwise' as const,
  model: 'jev-1.13.0',
  order: ['b', 'a'],
  scores: { a: 0.2, b: 0.8 },
  criteria: [],
  unsure: false,
  calls: 2
}))

let dir = ''
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = ''
  }
})

describe('runBenchmark on the seeded Discover set', () => {
  it('runs every arm N times through omni workflow run, scores each, and reports variance and gates', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bench-'))
    // The screen kept certainty for t1 (#633): P(score ≥ 1) = 0.9.
    mkdirSync(join(dir, RECORDED_DISCOVER_RUN.executionId))
    writeFileSync(
      join(dir, RECORDED_DISCOVER_RUN.executionId, 'jev-ballots.json'),
      JSON.stringify({
        'verify/screen': {
          outcome: {
            value: { certainty: { t1: { confidence: 0.8, levels: [0.1, 0.2, 0.3, 0.2, 0.2] } } }
          }
        }
      })
    )
    expect(screenKeepProbabilities(dir, RECORDED_DISCOVER_RUN.executionId).get('t1')).toBeCloseTo(
      0.9
    )
    expect(screenKeepProbabilities(dir, 'no-such-run').size).toBe(0)
    const calls: string[][] = []
    const faster = fakeRun(RECORDED_DISCOVER_RUN.results.targets.slice(0, 3), {
      timing: { wallClockMs: 300_000, followedMs: 301_000 }
    })
    const exec: Exec = async (args) => {
      calls.push(args)
      if (calls.length === 4) {
        return {
          code: 1,
          stdout: '',
          stderr: 'The OmniConsole window closed before The discover workflow started.'
        }
      }
      const result = args.includes('--spec-file') ? faster : RECORDED_DISCOVER_RUN
      return { code: 0, stdout: JSON.stringify(result), stderr: '' }
    }
    const report = await runBenchmark({
      set: 'discover-seeded',
      arms: [
        { name: 'default', template: 'discover' },
        {
          name: 'one-round',
          template: 'discover',
          specFile: '/arms/one-round.json',
          routes: ['claude', 'codex']
        }
      ],
      reps: 2,
      kitDir: __dirname,
      exec,
      worktree: 'path:/fixture',
      noul: { ask, rank },
      attemptsDir: dir
    })
    expect(calls[2]).toEqual([
      'workflow',
      'run',
      '--template',
      'discover',
      '--origin',
      'benchmark',
      '--operation-id',
      expect.any(String),
      '--prompt-file',
      join(__dirname, 'discover-seeded', 'prompt.md'),
      '--worktree',
      'path:/fixture',
      '--routes',
      'claude,codex',
      '--spec-file',
      '/arms/one-round.json',
      '--json'
    ])
    const [base, quick] = report.arms
    expect(base).toMatchObject({ runs: 2, failed: 0, recall: { n: 2, mean: 0.5, stdev: 0 } })
    expect(base!.wallClockMs).toMatchObject({ mean: 600_000 })
    expect(quick).toMatchObject({ runs: 2, failed: 1, recall: { n: 1, mean: 0.25 } })
    expect(report.runs[3]!.error).toContain('window closed')
    expect(report.gates.map((gate) => gate.gate)).toEqual([
      'set-aside: findings in the answer key',
      'set-aside: every finding (unkeyed count as non-findings)'
    ])
    // 11 + 11 + 3 findings from the three settled runs; one lacks a key match per full run (t8).
    expect(report.gates[1]!.n).toBe(25)
    expect(report.gates[0]!.n).toBe(23)
    expect(report.gates[1]!.noul.costUsdPerDecision).toBeCloseTo(0.000084)
    const markdown = reportMarkdown(report)
    expect(markdown).toContain('| default | discover | 2 (0) | 0.50 ± 0.00 |')
    expect(markdown).toContain('Missed by default: B02 (2/2)')
    expect(markdown).toContain('| set-aside: findings in the answer key | 23 (0 NOUL failed) |')
  })
})

describe('runBenchmark arm flags', () => {
  const recordCalls = async (arms: Arm[]): Promise<string[][]> => {
    const calls: string[][] = []
    await runBenchmark({
      set: 'discover-seeded',
      arms,
      reps: 1,
      kitDir: __dirname,
      exec: async (args) => {
        calls.push(args)
        return { code: 0, stdout: JSON.stringify(RECORDED_DISCOVER_RUN), stderr: '' }
      }
    })
    return calls
  }
  const prompt = ['--prompt-file', join(__dirname, 'discover-seeded', 'prompt.md')]

  it('gives an arm without the new fields the same argv as before', async () => {
    const [call] = await recordCalls([{ name: 'A', template: 'discover' }])
    expect(call).toEqual([
      'workflow',
      'run',
      '--template',
      'discover',
      '--origin',
      'benchmark',
      '--operation-id',
      expect.any(String),
      ...prompt,
      '--json'
    ])
  })

  it('turns each set field into its exact flag, after the spec file', async () => {
    const calls = await recordCalls([
      { name: 'm', template: 'discover', models: '*=cheap;verify=frontier;report=frontier' },
      { name: 'r', template: 'discover', runsOn: 'local' },
      { name: 'b', template: 'discover', requestedBy: 'Sal' },
      { name: 'q', template: 'discover', request: 'Re-run the 12-bug benchmark' },
      {
        name: 'all',
        template: 'discover',
        specFile: '/arms/one-round.json',
        models: 'cheap',
        runsOn: 'fleet',
        requestedBy: 'Uma',
        request: 'yes, run it'
      }
    ])
    const tails = calls.map((call) => call.slice(8))
    expect(tails.slice(0, 4)).toEqual([
      [...prompt, '--models', '*=cheap;verify=frontier;report=frontier', '--json'],
      [...prompt, '--runs-on', 'local', '--json'],
      [...prompt, '--requested-by', 'Sal', '--json'],
      [...prompt, '--request', 'Re-run the 12-bug benchmark', '--json']
    ])
    expect(tails[4]).toEqual([
      ...prompt,
      '--spec-file',
      '/arms/one-round.json',
      '--models',
      'cheap',
      '--runs-on',
      'fleet',
      '--requested-by',
      'Uma',
      '--request',
      'yes, run it',
      '--json'
    ])
  })
})

describe('the D9 matrix (arms/discover-d9-matrix.json)', () => {
  const arms = readArms(join(__dirname, 'arms', 'discover-d9-matrix.json'))
  const arm = (name: string): Arm => arms.find((entry) => entry.name === name)!
  // Studio's benchmark runs seat Claude, Codex and Grok; Gemini, where set up, never judges.
  const HOSTS: WorkflowRoute[][] = [
    ['claude', 'codex', 'grok'],
    ['claude', 'codex', 'grok', 'gemini']
  ]
  const spec = (entry: Arm, routes: readonly WorkflowRoute[]) =>
    localWorkflowRunSpec(
      localWorkflowRunRequestSchema.parse({
        template: entry.template,
        prompt: 'x',
        ...(entry.models ? { models: entry.models } : {}),
        ...(entry.runsOn ? { runsOn: entry.runsOn } : {}),
        ...(entry.specFile ? { spec: JSON.parse(readFileSync(entry.specFile, 'utf8')) } : {})
      }),
      (entry.routes ?? routes) as WorkflowRoute[]
    )

  it('loads every isolated and crossed arm as a valid workflow', () => {
    expect(arms.map((entry) => entry.name)).toEqual(['A', 'B', 'B2', 'R', 'B2R', 'S55', 'A55', 'C'])
    // Pinned to the computer the matrix runs on; who asked is added once A5 is approved.
    expect(arms.every((entry) => entry.runsOn === 'local' && !entry.requestedBy)).toBe(true)
    expect(existsSync(arm('C').specFile!)).toBe(true)
    for (const routes of HOSTS) {
      for (const entry of arms) {
        expect(() => spec(entry, routes), entry.name).not.toThrow()
      }
      expect(spec(arm('C'), routes).steps.find((step) => step.id === 'find')!.agents).toEqual([
        { route: 'claude', model: 'claude-opus-5-5[1m]' }
      ])
    }
  })

  it('names only models the workflow catalog offers', () => {
    const named = arms.flatMap((entry) =>
      Object.values(entry.models ? workflowModelsFlagPlan(entry.models).steps : {}).flatMap(
        (step) => (step as { agents?: { route?: WorkflowRoute; model?: string }[] }).agents ?? []
      )
    )
    expect(named.some((agent) => agent.model === 'claude-opus-5-5[1m]')).toBe(true)
    for (const agent of named.filter((entry) => entry.route && entry.model)) {
      expect(WORKFLOW_ROUTE_MODELS[agent.route!].map((model) => model.id)).toContain(agent.model)
    }
  })

  it('changes only the named step, including crossed Verify and Report arms', () => {
    for (const routes of HOSTS) {
      for (const [child, parent, changed] of [
        ['B', 'A', 'find'],
        ['B2', 'B', 'verify'],
        ['R', 'B', 'report'],
        ['B2R', 'B2', 'report'],
        ['B2R', 'R', 'verify'],
        ['S55', 'A', 'scout'],
        ['A55', 'A', 'find']
      ]) {
        const before = spec(arm(parent!), routes)
        const after = spec(arm(child!), routes)
        expect(after.steps.filter((step) => step.id !== changed)).toEqual(
          before.steps.filter((step) => step.id !== changed)
        )
        expect(after.steps.map((step) => step.id)).toEqual(before.steps.map((step) => step.id))
      }
      for (const entry of arms) {
        const planned = spec(entry, routes)
        expect(
          Object.fromEntries(
            planned.steps.map((step) => [
              step.id,
              step.agents.map(
                (agent) =>
                  `${agent.route}:${WORKFLOW_ROUTE_MODELS[agent.route].find((model) => (agent.model ? model.id === agent.model : model.isDefault))!.resolved}`
              )
            ])
          )
        ).toEqual(entry.expectedModels)
        expect(
          planned.steps.every((step) =>
            step.agents.every(
              (agent) =>
                routes.includes(agent.route) &&
                (!agent.model ||
                  WORKFLOW_ROUTE_MODELS[agent.route].some((model) => model.id === agent.model))
            )
          )
        ).toBe(true)
      }
    }
  })

  it('runs every arm N times through the harness', async () => {
    const calls: string[][] = []
    const report = await runBenchmark({
      set: 'discover-seeded',
      arms,
      reps: 2,
      kitDir: __dirname,
      exec: async (args) => {
        calls.push(args)
        const entry = arms[Math.floor((calls.length - 1) / 2)]!
        const result = structuredClone(RECORDED_DISCOVER_RUN)
        result.calls = Object.entries(entry.expectedModels!).flatMap(([stage, models]) =>
          models.map((model, i) => ({
            id: `${stage}/a${i}`,
            stage,
            route: model.split(':')[0]!,
            model: model.slice(model.indexOf(':') + 1),
            effort: null,
            state: 'completed' as const,
            attempt: 1,
            durationMs: 1,
            tokens: 'unknown' as const,
            costUsd: 'unknown' as const,
            costSource: 'unknown' as const
          }))
        )
        return { code: 0, stdout: JSON.stringify(result), stderr: '' }
      }
    })
    expect(report.arms.map((entry) => [entry.arm, entry.runs])).toEqual([
      ['A', 2],
      ['B', 2],
      ['B2', 2],
      ['R', 2],
      ['B2R', 2],
      ['S55', 2],
      ['A55', 2],
      ['C', 2]
    ])
    expect(calls[14]).toEqual(expect.arrayContaining(['quick-discover', '--spec-file']))
    expect(calls[14]).toContain(join(__dirname, 'arms', 'quick-discover-1m.json'))
  })
})

describe('runBenchmark on the Decide set', () => {
  it('measures the one-answer and final-check gates without running a workflow', async () => {
    const exec = vi.fn<Exec>()
    const report = await runBenchmark({
      set: 'decide',
      arms: [{ name: 'council', template: 'council' }],
      reps: 1,
      kitDir: __dirname,
      exec,
      noul: { ask, rank },
      gatesOnly: true
    })
    expect(exec).not.toHaveBeenCalled()
    expect(report.gates.map((gate) => [gate.gate, gate.n])).toEqual([
      ['one-answer routing', 10],
      ['final check: is B better than A', 10]
    ])
    // Today nothing routes one-answer questions, so the rule is right on the five judgment ones.
    expect(report.gates[0]!.current.accuracy).toBe(0.5)
  })

  it('aggregates each repetition over the matched questions, and shows what went unscored', async () => {
    const exec: Exec = async () => ({
      code: 0,
      stdout: JSON.stringify(fakeRun([], { template: 'council', markdown: 'An answer' })),
      stderr: ''
    })
    // Attempts run arm by arm, repetition by repetition, question by question (10 each).
    let call = 0
    const judge = vi.fn(async () => {
      const index = call++
      const arm = index < 20 ? 'A' : 'B'
      const rep = Math.floor(index / 10) % 2 === 0 ? 1 : 2
      if (arm === 'B' && rep === 2 && index % 10 === 9) {
        return { failed: 'JEV answered overloaded' }
      }
      const run = arm === 'A' ? (rep === 1 ? 3 : 2) : 3.5
      return {
        method: 'rubric' as const,
        model: 'jev-1.13.0',
        order: ['run', 'reference'],
        scores: { run, reference: 3 },
        criteria: [],
        unsure: false,
        calls: 2
      }
    })
    const report = await runBenchmark({
      set: 'decide',
      arms: [
        { name: 'A', template: 'council' },
        { name: 'B', template: 'council', routes: ['claude'] }
      ],
      reps: 2,
      kitDir: __dirname,
      exec,
      judge
    })
    expect(report.runs).toHaveLength(40)
    expect(report.runs.every((run) => /^Q\d\d$/.test(run.question ?? ''))).toBe(true)
    // Q10 lacks a score in one attempt, so no arm is compared on it.
    expect(report.matchedQuestions).toEqual([
      'Q01',
      'Q02',
      'Q03',
      'Q04',
      'Q05',
      'Q06',
      'Q07',
      'Q08',
      'Q09'
    ])
    const [a, b] = report.arms
    // Statistics are across repetitions (n = 2), not across questions.
    expect(a!.decideGap).toMatchObject({ n: 2, mean: -0.5 })
    expect(a!.decideGap!.stdev).toBeCloseTo(Math.SQRT1_2)
    expect(b!.decideGap).toMatchObject({ n: 2, mean: 0.5, stdev: 0 })
    expect(b!.unscored).toEqual([{ question: 'Q10', rep: 2, reason: 'JEV answered overloaded' }])
    const markdown = reportMarkdown(report)
    expect(markdown).toContain('over 9 matched questions')
    expect(markdown).toContain('Unscored for B: Q10 #2 (JEV answered overloaded)')
  })

  it('lists attempts it did not judge instead of dropping them', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'no window' })
    const report = await runBenchmark({
      set: 'decide',
      arms: [{ name: 'A', template: 'council' }],
      reps: 1,
      kitDir: __dirname,
      exec
    })
    expect(report.matchedQuestions).toEqual([])
    expect(report.arms[0]!.decideGap).toMatchObject({ n: 0 })
    expect(report.arms[0]!.unscored).toHaveLength(10)
    expect(report.arms[0]!.unscored![0]!.reason).toContain('no window')
  })
})

describe('stat', () => {
  it('gives the sample variance, and none below two values', () => {
    expect(stat([1, 2, 3])).toMatchObject({ mean: 2, variance: 1, stdev: 1, min: 1, max: 3 })
    expect(stat([4])).toMatchObject({ mean: 4, variance: null, stdev: null })
    expect(stat([])).toMatchObject({ n: 0, mean: null })
  })
})

describe('summarizeArm', () => {
  it('leaves runs with partial token counts out of token comparisons, as unknown', () => {
    const partial = fakeRun([], {
      usage: {
        tokens: 'unknown',
        partialTokens: { input: 5, output: 1, knownCalls: 1, unknownCalls: 2 },
        callsWithTokens: 1,
        callsTotal: 3,
        costUsd: 'unknown',
        costSource: 'unknown'
      }
    })
    const summary = summarizeArm('a', 'discover', [
      { arm: 'a', rep: 1, result: RECORDED_DISCOVER_RUN },
      { arm: 'a', rep: 2, result: partial }
    ])
    expect(summary.tokens).toMatchObject({ n: 1, mean: 100_000, unknownRuns: 1 })
  })

  it('reports a Quick Discover arm by its any-verdict recall, since it confirms nothing', async () => {
    const report = await runBenchmark({
      set: 'discover-seeded',
      arms: [{ name: 'C', template: 'quick-discover' }],
      reps: 1,
      kitDir: __dirname,
      exec: async () => ({ code: 0, stdout: JSON.stringify(QUICK_DISCOVER_RUN), stderr: '' })
    })
    const [quick] = report.arms
    expect(quick).toMatchObject({ runs: 1, failed: 0, recall: { mean: 0 } })
    expect(quick!.recallAnyVerdict!.mean).toBeCloseTo(8 / 12)
    expect(quick!.missed).toHaveLength(12)
    const markdown = reportMarkdown(report)
    expect(markdown).toContain('| C | quick-discover | 1 (0) | 0.00 | 0.67 |')
    expect(markdown).toContain('Recall (any verdict) also counts refuted and unverified ones')
  })
})

it('reports complete bills from failed runs and labels partial and unknown totals', () => {
  const priced = (costUsd: number | 'unknown', partial = false) =>
    fakeRun([], {
      state: 'failed',
      usage: {
        tokens: 'unknown',
        callsWithTokens: 0,
        callsTotal: 1,
        costUsd,
        costSource: 'cli',
        ...(partial ? { costPartial: true as const } : {})
      }
    })
  const summary = summarizeArm(
    'x',
    'discover',
    [priced(2), priced(3, true), priced('unknown')].map((result, i) => ({
      arm: 'x',
      rep: i + 1,
      result
    }))
  )
  expect(summary.costUsd).toMatchObject({
    n: 1,
    mean: 2,
    unknownRuns: 1,
    partialRuns: 1
  })
})

it('invalidates a benchmark arm whose actual model differs from its pin', async () => {
  const report = await runBenchmark({
    set: 'discover-seeded',
    arms: [
      {
        name: 'pinned',
        template: 'discover',
        expectedModels: { find: ['claude:claude-haiku-5-5'] }
      }
    ],
    reps: 1,
    kitDir: __dirname,
    exec: async () => ({ code: 0, stderr: '', stdout: JSON.stringify(RECORDED_DISCOVER_RUN) })
  })
  expect(report.runs[0]?.error).toContain('find resolved to no calls')
  expect(report.runs[0]?.discover).toBeUndefined()
})

it('keeps round-specific bills and unknown round cost separate', () => {
  const run = structuredClone(RECORDED_DISCOVER_RUN)
  run.results.targets = run.results.targets
    .slice(0, 2)
    .map((target, i) => ({ ...target, round: i + 1 }))
  run.calls = [1, 2, 3].map((round) => ({
    id: `find/r${round}/a0`,
    stage: 'find',
    model: 'opus',
    effort: null,
    state: 'completed',
    attempt: 1,
    durationMs: 1,
    tokens: 'unknown',
    costUsd: round === 2 ? 'unknown' : 2,
    costSource: round === 2 ? 'unknown' : 'cli'
  }))
  expect(summarizeDiscoverRounds([{ arm: 'x', rep: 1, result: run }])).toEqual([
    { round: 1, targets: 1, confirmed: 1, knownCostUsd: 2, unpricedCalls: 0 },
    { round: 2, targets: 1, confirmed: 1, knownCostUsd: 'unknown', unpricedCalls: 1 },
    { round: 3, targets: 0, confirmed: 0, knownCostUsd: 2, unpricedCalls: 0 }
  ])
})
