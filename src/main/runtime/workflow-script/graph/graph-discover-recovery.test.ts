import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { runWorkflowGraphProgram } from './graph-program'
import { planWorkflowGraph } from './graph-plan'
import { configFor, fakeContext, Fatal, task, text } from './graph-program-test-harness'
import { createGraphSeatSubstitute, SEAT_RULES } from './graph-seat-substitution'
import { createGraphScope } from './graph-scope'
import { graphDiscoverReportFallback } from './graph-discover-report-fallback'
import type { GraphTarget } from './graph-target'

const spec = normalizeWorkflowSpec({
  template: 'discover',
  steps: [
    {
      id: 'find',
      kind: 'do',
      title: 'Find',
      list: { maxItems: 10 },
      agents: [{ route: 'claude' }]
    },
    {
      id: 'verify',
      kind: 'review',
      title: 'Verify',
      inputs: ['find'],
      forEach: { step: 'find', limit: 10 },
      agents: [{ route: 'codex' }]
    },
    { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['verify'] }
  ]
})

describe('Discover preserves settled work', () => {
  it('completes with targets and a gap when the Report answer is rejected', async () => {
    const f = fakeContext((call) =>
      call.id.startsWith('find')
        ? {
            items: [
              {
                title: 'Lost writes',
                detail: 'Writes are lost on a concurrent flush.',
                location: 'src/store.ts:12',
                severity: 'high'
              }
            ]
          }
        : call.id.startsWith('verify')
          ? text('VERDICT: PASS')
          : new Error('Report timed out')
    )
    const result = await runWorkflowGraphProgram(f.context, configFor(spec), task)
    expect(result.final.markdown).toContain('Lost writes (confirmed)')
    expect(result.gaps.some((gap) => gap.startsWith('Report failed:'))).toBe(true)
    const plan = planWorkflowGraph(configFor(spec), task, f.outcomes)
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.final?.ranking?.[0].key).toBe('find.r1.1')
  })

  it('sorts the deterministic report by impact, then severity, and retains refutations', () => {
    const scope = createGraphScope(configFor(spec), task, new Map())
    const target = (key: string, impact: number, severity: 'high' | 'low'): GraphTarget => ({
      item: {
        key,
        title: key,
        detail: key,
        severity,
        impact: { score: impact, why: key },
        location: '',
        round: 1,
        sourceCallId: 'find/a0',
        repeats: 0
      },
      tally: key === 'A' ? 'refuted' : 'unverified',
      votes: [],
      texts: []
    })
    scope.outputs.set('verify', {
      status: 'ok',
      callIds: [],
      run: {
        stepId: 'verify',
        round: 1,
        state: 'done',
        calls: [],
        notes: [],
        targets: [target('A', 3, 'high'), target('B', 5, 'low'), target('C', 5, 'high')]
      }
    })
    const result = graphDiscoverReportFallback(scope, scope.byId.get('report'), 'timeout', [])!
    expect(result.final?.ranking?.map((row) => row.key)).toEqual(['C', 'B', 'A'])
    expect(result.final?.markdown).toContain('A (refuted)')
  })

  it('does not salvage a run whose Find never reached Verify', async () => {
    const f = fakeContext(() => new Error('Find failed'))
    await expect(runWorkflowGraphProgram(f.context, configFor(spec), task)).rejects.toThrow()
  })
})

describe('Discover single-agent failover', () => {
  const single = normalizeWorkflowSpec({
    template: 'discover',
    steps: [
      { id: 'brief', title: 'Brief', kind: 'do', agents: [{ route: 'claude' }] },
      { id: 'scout', title: 'Scout', kind: 'do', inputs: ['brief'], agents: [{ route: 'claude' }] },
      { id: 'report', title: 'Report', kind: 'synthesize', inputs: ['scout'] }
    ]
  })
  const config = (rules = SEAT_RULES) => {
    const base = { ...configFor(single), seatRules: rules }
    return {
      ...base,
      substitute: createGraphSeatSubstitute({
        config: base,
        capacity: async () => () => ({ state: 'fresh', remainingPercent: 80 })
      })
    }
  }

  it.each(['brief', 'scout'])(
    'moves a timed out or rejected %s to another model family once',
    async (step) => {
      const f = fakeContext((call) =>
        call.id === `${step}/a0` ? new Error('Rejected answer') : text('answer')
      )
      await runWorkflowGraphProgram(f.context, config(), task)
      expect(f.calls.filter((call) => call.id.startsWith(step)).map((call) => call.id)).toEqual([
        `${step}/a0`,
        `${step}/a0~seat-codex`
      ])
    }
  )

  it('stops after the alternate family also fails, and preserves fatal cancellation', async () => {
    const f = fakeContext(() => new Error('timed out'))
    await expect(runWorkflowGraphProgram(f.context, config(), task)).rejects.toThrow()
    expect(f.calls.map((call) => call.id)).toEqual(['brief/a0', 'brief/a0~seat-codex'])
    const stopped = fakeContext(() => new Fatal('Stopped'))
    await expect(runWorkflowGraphProgram(stopped.context, config(), task)).rejects.toThrow(
      'Stopped'
    )
    expect(stopped.calls).toHaveLength(1)
  })

  it('does not substitute same-lineage routes, unknown capacity, or change old replay rules', async () => {
    const c = config()
    c.seats = c.seats.map((seat) => ({ ...seat, lineage: 'anthropic' }))
    const choose = createGraphSeatSubstitute({
      config: c,
      capacity: async () => () => ({ state: 'fresh', remainingPercent: 90 })
    })
    const call = planWorkflowGraph(c, task, new Map()).ready[0]
    expect(await choose(call, 'timeout', true)).toBeUndefined()
    const unknown = createGraphSeatSubstitute({
      config: config(),
      capacity: async () => () => ({ state: 'unknown' })
    })
    expect(await unknown(call, 'timeout', true)).toBeUndefined()
    const old = fakeContext(() => new Error('Rejected answer'))
    await expect(runWorkflowGraphProgram(old.context, config(1), task)).rejects.toThrow()
    expect(old.calls).toHaveLength(1)
  })
})
