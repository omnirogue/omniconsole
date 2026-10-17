import { describe, expect, it } from 'vitest'
import type {
  LocalWorkflowGraphRun,
  LocalWorkflowCallView,
  LocalWorkflowView
} from './local-workflow-view'
import { workflowRunResult } from './workflow-run-result'

const STARTED = { worktreeId: 'wt', conversationId: 'tab', executionId: 'exec-1' }

function call(id: string, extra: Partial<LocalWorkflowCallView> = {}): LocalWorkflowCallView {
  return {
    id,
    stageId: id.split('/')[0],
    agent: 'claude',
    seatLabel: 'Claude',
    model: 'claude-opus-5',
    effort: 'high',
    state: 'completed',
    attempt: 1,
    attemptLimit: 3,
    transport: 'headless',
    stdout: '',
    stderr: '',
    outputTruncated: false,
    ...extra
  }
}

function result(calls: LocalWorkflowCallView[], extra: Partial<LocalWorkflowView> = {}) {
  const view: LocalWorkflowView = {
    executionId: STARTED.executionId,
    fence: 1,
    sequence: 1,
    preset: 'discover',
    state: 'completed',
    connection: 'connected',
    prompt: 'Find bugs',
    startedAt: 1_000,
    finishedAt: 2_000,
    running: 0,
    queued: 0,
    reused: 0,
    actions: [],
    stages: [],
    calls,
    ...extra
  }
  return workflowRunResult(view, STARTED, 'discover', 1_500)
}

describe('workflowRunResult cost', () => {
  it('72: preserves a partial sum across terminal attempts in the run total', () => {
    expect(
      result([call('find/a0', { cost: { usd: 1.5, source: 'cli', partial: true } })]).usage
    ).toMatchObject({ costUsd: 1.5, costPartial: true })
  })

  it('keeps the requester id when present and omits it on older runs', () => {
    expect(result([], { requestedBy: 'Uma', requestedById: 'emp_uma' })).toMatchObject({
      requestedBy: 'Uma',
      requestedById: 'emp_uma'
    })
    expect(result([])).not.toHaveProperty('requestedById')
  })

  it('preserves impact in the run result for deterministic page fallback ordering', () => {
    const impact = { score: 5, why: 'large effect' }
    const graphRun = {
      spec: { template: 'discover', steps: [] },
      steps: [
        {
          id: 'verify',
          rounds: [
            { round: 1, targets: [{ key: 'a', tally: 'confirmed', votes: [], repeats: 0, impact }] }
          ]
        }
      ]
    } as unknown as LocalWorkflowGraphRun
    expect(result([], { graphRun }).results.targets[0].impact).toEqual(impact)
  })

  it('takes each call cost and its source from the view, else says unknown', () => {
    const run = result([
      call('find/1', { cost: { usd: 0.4625705, source: 'cli' } }),
      call('find/2', { agent: 'codex', cost: { usd: 0.02, source: 'table' } }),
      call('verify/1', { state: 'failed' })
    ])
    expect(run.calls.map(({ costUsd, costSource }) => ({ costUsd, costSource }))).toEqual([
      { costUsd: 0.4625705, costSource: 'cli' },
      { costUsd: 0.02, costSource: 'table' },
      { costUsd: 'unknown', costSource: 'unknown' }
    ])
  })

  it('sums a run priced entirely by the providers as cli, with no partial flag', () => {
    const run = result([
      call('find/1', { cost: { usd: 1.25, source: 'cli' } }),
      call('find/2', { cost: { usd: 0.5, source: 'cli' } })
    ])
    expect(run.usage.costUsd).toBeCloseTo(1.75)
    expect(run.usage.costSource).toBe('cli')
    expect(run.usage).not.toHaveProperty('costPartial')
  })

  it('labels the sum table when any priced call is a list-price estimate', () => {
    const run = result([
      call('find/1', { cost: { usd: 1.25, source: 'cli' } }),
      call('find/2', { agent: 'codex', cost: { usd: 0.5, source: 'table' } })
    ])
    expect(run.usage.costUsd).toBeCloseTo(1.75)
    expect(run.usage.costSource).toBe('table')
  })

  it('marks the sum partial when some calls were not priced, never treating them as 0', () => {
    const run = result([
      call('find/1', { cost: { usd: 1.25, source: 'cli' } }),
      call('find/2', { agent: 'gemini' })
    ])
    expect(run.usage).toMatchObject({ costUsd: 1.25, costPartial: true, costSource: 'cli' })
  })

  it('says unknown when no call was priced or there were no calls', () => {
    for (const run of [result([call('find/1'), call('find/2')]), result([])]) {
      expect(run.usage.costUsd).toBe('unknown')
      expect(run.usage.costSource).toBe('unknown')
      expect(run.usage).not.toHaveProperty('costPartial')
    }
  })
})

it('marks run cost partial when one call has an unpriced earlier attempt', () => {
  expect(
    result([call('find/a0', { cost: { usd: 2, source: 'cli', partial: true } })]).usage
  ).toMatchObject({ costUsd: 2, costPartial: true })
})

it('50: preserves merged locations and uses the latest reviewed target once', () => {
  const first = {
    key: 'a',
    title: 'First',
    detail: 'Details',
    location: 'src/a.ts:1',
    severity: 'high' as const,
    repeats: 0,
    tally: 'unverified' as const,
    votes: [],
    unchecked: true
  }
  const later = {
    ...first,
    unchecked: false,
    tally: 'confirmed' as const,
    alsoMerged: ['b'],
    alsoReported: [
      {
        title: 'Second',
        detail: 'More evidence',
        location: 'src/b.ts:2',
        severity: 'high' as const
      }
    ]
  }
  const graphRun = {
    spec: { version: 1 as const, title: 'Discover', template: 'discover' as const, steps: [] },
    levels: {},
    gaps: [],
    notes: [],
    steps: [
      {
        id: 'verify',
        state: 'done' as const,
        agents: [],
        rounds: [
          {
            round: 1,
            state: 'done' as const,
            calls: [],
            notes: [],
            targets: [first, { ...first, key: 'b' }]
          },
          { round: 2, state: 'done' as const, calls: [], notes: [], targets: [later] }
        ]
      }
    ]
  }
  const run = result([], { graphRun })
  expect(run.results.targets).toHaveLength(1)
  expect(run.results.targets[0]).toMatchObject({
    tally: 'confirmed',
    alsoReported: [{ location: 'src/b.ts:2' }]
  })
})
