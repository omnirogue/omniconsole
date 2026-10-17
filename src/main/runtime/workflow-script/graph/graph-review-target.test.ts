import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { projectGraphRun } from '../local-workflow-graph-projection'
import { planWorkflowGraph, type GraphOutcome } from './graph-plan'
import { configFor, SEATS, task, text } from './graph-test-harness'

const finding = (title: string, severity: string) => ({
  title,
  detail: `How ${title} breaks.`,
  location: `src/${title.replace(/\s+/g, '-')}.ts:1`,
  severity
})
const PASS = text('Holds: the write is lost.\nVERDICT: PASS')
const FAIL = text('Refuted by the lock.\nVERDICT: FAIL')

// Brief → one Do listing findings → a Verify that escalates one item a round → Report.
const spec = normalizeWorkflowSpec({
  title: 'Early',
  steps: [
    { id: 'brief', kind: 'do', title: 'Brief', agents: [{ route: 'claude' }] },
    {
      id: 'find',
      kind: 'do',
      title: 'Find',
      agents: [{ route: 'claude' }],
      inputs: ['brief'],
      list: { maxItems: 8 }
    },
    {
      id: 'verify',
      kind: 'review',
      title: 'Verify',
      agents: [{ route: 'codex' }, { route: 'grok' }, { route: 'claude' }],
      inputs: ['brief', 'find'],
      forEach: { step: 'find', limit: 3 },
      escalate: { max: 1 }
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

function planned(answers: [string, GraphOutcome][]) {
  const outcomes = new Map<string, GraphOutcome>([
    ['brief/a0', { value: text('Brief') }],
    [
      'find/a0',
      {
        value: {
          items: [
            finding('lost write', 'high'),
            finding('stale read', 'high'),
            finding('torn page', 'critical')
          ]
        }
      }
    ],
    ...answers
  ])
  const plan = planWorkflowGraph(configFor(spec), task, outcomes)
  const snapshot = { graphProgramRevision: 1, seats: SEATS, task, access: 'frozen' }
  const graph = { spec, agentSeats: configFor(spec).agentSeats }
  const view = projectGraphRun({ ...snapshot, graph } as never, outcomes, true).graphRun
  return { plan, run: plan.runs.verify![0]!, view }
}

describe('findings verified while the review step still runs', () => {
  it('lists an item once its last review confirms it, and holds one that may escalate', () => {
    const { plan, run, view } = planned([
      ['verify/find.r1.1/a0', { value: PASS }],
      // Critical: a pass still sends it to the other reviewers once every first review is in.
      ['verify/find.r1.3/a0', { value: PASS }]
    ])
    expect(run.state).toBe('active')
    expect(run.targets).toBeUndefined()
    expect(plan.ready.map((call) => call.id)).toEqual(['verify/find.r1.2/a0'])
    expect(run.verifiedEarly?.map((target) => [target.item.key, target.tally])).toEqual([
      ['find.r1.1', 'confirmed']
    ])
    expect(view.verified).toEqual([
      {
        key: 'find.r1.1',
        title: 'lost write',
        detail: 'How lost write breaks.',
        location: 'src/lost-write.ts:1',
        severity: 'high',
        stepId: 'verify',
        round: 1
      }
    ])
  })

  it('adds an escalated item when its last reviewer answers, and never a refuted one', () => {
    const firsts: [string, GraphOutcome][] = [
      ['verify/find.r1.1/a0', { value: PASS }],
      ['verify/find.r1.2/a0', { value: FAIL }],
      ['verify/find.r1.3/a0', { value: PASS }]
    ]
    const escalating = planned([...firsts, ['verify/find.r1.3/a1', { value: PASS }]])
    expect(escalating.plan.ready.map((call) => call.id)).toEqual(['verify/find.r1.3/a2'])
    expect(escalating.view.verified?.map((finding) => finding.key)).toEqual(['find.r1.1'])

    const settled = planned([
      ...firsts,
      ['verify/find.r1.3/a1', { value: PASS }],
      ['verify/find.r1.3/a2', { value: FAIL }]
    ])
    expect(settled.run.state).not.toBe('active')
    expect(settled.run.verifiedEarly).toBeUndefined()
    // The settled round's own confirmed targets, in the step's order: critical first.
    expect(settled.view.verified?.map((finding) => finding.key)).toEqual(['find.r1.3', 'find.r1.1'])
  })

  it('reports nothing for a run without a for-each review', () => {
    const plain = normalizeWorkflowSpec({
      title: 'Plain',
      steps: [{ id: 'answer', kind: 'do', title: 'Answer', agents: [{ route: 'claude' }] }]
    })
    const snapshot = { graphProgramRevision: 1, seats: SEATS, task, access: 'frozen' }
    const graph = { spec: plain, agentSeats: configFor(plain).agentSeats }
    const view = projectGraphRun({ ...snapshot, graph } as never, new Map(), true).graphRun
    expect(view.verified).toBeUndefined()
  })
})
