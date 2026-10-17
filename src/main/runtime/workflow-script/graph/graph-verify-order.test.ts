import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { describeWorkflow, planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { planWorkflowGraph, type GraphCall, type GraphOutcome } from './graph-plan'
import { configFor, task, text } from './graph-test-harness'

const found = (title: string, severity: string) => ({
  title,
  detail: `How ${title} breaks.`,
  location: `src/${title.replace(/\s+/g, '-')}.ts:1`,
  severity
})

function spec(options: { order?: boolean; crossFamily?: boolean } = {}) {
  return normalizeWorkflowSpec({
    title: 'Order',
    steps: [
      {
        id: 'find',
        kind: 'do',
        title: 'Find',
        agents: [{ route: 'claude' }],
        list: { maxItems: 8 }
      },
      {
        id: 'verify',
        kind: 'review',
        title: 'Verify',
        agents: [{ route: 'claude' }, { route: 'codex' }, { route: 'grok' }],
        inputs: ['find'],
        forEach: {
          step: 'find',
          limit: 2,
          ...(options.order === false ? {} : { order: 'impact' })
        },
        escalate: { max: 1, ...(options.crossFamily === false ? {} : { crossFamily: true }) }
      },
      {
        id: 'report',
        kind: 'synthesize',
        title: 'Report',
        agents: [{ route: 'claude' }],
        inputs: ['verify']
      }
    ]
  })
}

/** Runs the pure planner to the end, keeping every outcome so a replay can be compared. */
function run(workflow: ReturnType<typeof spec>, answer: (call: GraphCall) => unknown) {
  const config = configFor(workflow)
  const outcomes = new Map<string, GraphOutcome>()
  const order: string[] = []
  let plan = planWorkflowGraph(config, task, outcomes)
  for (let pass = 0; pass < 20 && plan.ready.length; pass++) {
    for (const call of plan.ready) {
      order.push(call.id)
      const value = answer(call)
      outcomes.set(call.id, value === undefined ? { failed: true } : { value })
    }
    plan = planWorkflowGraph(config, task, outcomes)
  }
  return { plan, outcomes, order, config }
}

// a: critical but trivial; b: low but severe; c: high and serious; d: medium, negligible.
const FOUND = [
  found('noisy log', 'critical'),
  found('lost write', 'low'),
  found('stale read', 'high'),
  found('typo', 'medium')
]
const IMPACT = { 'find.r1.1': 2, 'find.r1.2': 5, 'find.r1.3': 4, 'find.r1.4': 1 } as Record<
  string,
  number
>

function answers(impact: 'ok' | 'fail' = 'ok') {
  return (call: GraphCall) => {
    if (call.id === 'find/a0') {
      return { items: FOUND }
    }
    if (call.id === 'verify/impact') {
      return impact === 'fail'
        ? undefined
        : {
            items: Object.entries(IMPACT).map(([key, value]) => ({
              key,
              impact: value,
              why: `rated ${value}`
            }))
          }
    }
    if (call.id.startsWith('verify/')) {
      // The lost write's first review is unsure, so it escalates; everything else passes.
      return text(
        call.id === 'verify/find.r1.2/a1'
          ? 'Maybe guarded.\nVERDICT: UNSURE'
          : 'Traced it.\nVERDICT: PASS'
      )
    }
    return text('Report')
  }
}

describe('ordering what a review checks, and who checks it first', () => {
  it('rates impact once, checks the most important first, and a cross-family reviewer goes first', () => {
    const { plan, order, outcomes, config } = run(spec(), answers())
    expect(order.filter((id) => id.startsWith('verify'))).toEqual([
      'verify/impact',
      // Found by Claude, so Codex (agent 1) reviews first, highest impact first.
      'verify/find.r1.2/a1',
      'verify/find.r1.3/a1',
      // Unsure first review: the other families join.
      'verify/find.r1.2/a0',
      'verify/find.r1.2/a2'
    ])
    const targets = plan.runs.verify[0].targets!
    expect(
      targets.map((target) => [
        target.item.key,
        target.item.impact?.score,
        target.unchecked ?? false
      ])
    ).toEqual([
      ['find.r1.2', 5, false],
      ['find.r1.3', 4, false],
      ['find.r1.1', 2, true],
      ['find.r1.4', 1, true]
    ])
    expect(plan.runs.verify[0].notes.join('\n')).toContain('the least important ones went last')
    // The one-review item names its real reviewer, not whoever sits at position 0.
    expect(targets[1].voters).toEqual([1])
    const report = plan.calls.find((call) => call.id === 'report/a0')!.prompt
    expect(report).toContain('impact 5/5')
    expect(report).toContain('confirmed by one review')
    // Replay: the same outcomes plan the same run.
    const again = planWorkflowGraph(config, task, outcomes)
    expect(again.calls.map((call) => call.id)).toEqual(plan.calls.map((call) => call.id))
  })

  it('falls back to severity, never to JEV, when the triage does not answer', () => {
    const { plan, order } = run(spec(), answers('fail'))
    expect(order.filter((id) => id.endsWith('/a1') && id.startsWith('verify'))).toEqual([
      'verify/find.r1.1/a1',
      'verify/find.r1.3/a1'
    ])
    expect(plan.runs.verify[0].notes.join('\n')).toContain(
      'the impact triage did not answer, so the reviewers took the results by severity'
    )
  })

  it('keeps the old behavior when neither option is set', () => {
    const { order } = run(spec({ order: false, crossFamily: false }), answers())
    expect(order).not.toContain('verify/impact')
    expect(order.filter((id) => id.startsWith('verify')).slice(0, 2)).toEqual([
      'verify/find.r1.1/a0',
      'verify/find.r1.3/a0'
    ])
  })

  it('skips the triage when every item fits within the limit', () => {
    const small = (call: GraphCall) =>
      call.id === 'find/a0' ? { items: FOUND.slice(0, 2) } : answers()(call)
    expect(run(spec(), small).order).not.toContain('verify/impact')
  })

  it('counts the triage in the call bound and says it plainly', () => {
    expect(planWorkflowCalls(spec()).perStep.verify).toBe(2 + 1 * 2 + 1)
    const discover = workflowTemplate('discover')
    // 169 agent calls, and the app's quote check once in each of the two rounds.
    expect(planWorkflowCalls(discover).total).toBe(171)
    expect(planWorkflowCalls(discover).agentTotal).toBe(169)
    // No JEV screen since 2026-09-27: every finding goes to review, most important first.
    expect(describeWorkflow(discover).join('\n')).toContain(
      'Verify: 1 agent reviews for each item from Find using Brief, with repeats of one root cause merged, most important first; the first reviewer is from another model family than the finder'
    )
  })
})
