import { describe, expect, it } from 'vitest'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { planWorkflowGraph, type GraphCall, type GraphOutcome } from './graph-plan'
import { graphCallSuperseded } from './graph-supersede'

/**
 * Regressions for what a live Discover run found when pointed at this runtime's own code
 * (2026-09-22, report in docs/workflows/WORKFLOW-CORE-2026-09-22.md §9). Numbers are the report's.
 */
const SEATS = (['claude', 'codex'] as const).map(
  (agent) =>
    ({
      id: agent,
      agent,
      accountId: 'x',
      model: `${agent}-model`,
      effort: null,
      lineage: agent === 'claude' ? 'anthropic' : 'openai',
      policyRevision: 'p'
    }) as ResolvedLocalWorkflowSeat
)

function drive(spec: WorkflowSpec, answer: (call: GraphCall) => unknown) {
  const config = {
    spec,
    seats: SEATS,
    access: 'frozen' as const,
    agentSeats: Object.fromEntries(
      spec.steps.map((step) => [step.id, step.agents.map((agent) => agent.route)])
    )
  }
  const outcomes = new Map<string, GraphOutcome>()
  let plan = planWorkflowGraph(config, { prompt: 'Task', evidence: '' }, outcomes)
  for (let pass = 0; pass < 50 && plan.ready.length; pass++) {
    for (const call of plan.ready) {
      const value = answer(call)
      outcomes.set(call.id, value === undefined ? { failed: true } : { value })
    }
    plan = planWorkflowGraph(config, { prompt: 'Task', evidence: '' }, outcomes)
  }
  return plan
}

const text = (markdown: string) => ({ markdown })
const item = (title: string) => ({
  title,
  detail: `A concrete failure scenario for ${title}.`,
  location: `src/${title.replace(/\W/g, '')}.ts:1`,
  severity: 'high'
})
const find = (maxItems = 4, agents = [{ route: 'claude' }]) => ({
  id: 'find',
  kind: 'do' as const,
  title: 'Find',
  agents,
  list: { maxItems }
})
const verify = (limit = 10) => ({
  id: 'verify',
  kind: 'review' as const,
  title: 'Verify',
  agents: [{ route: 'codex' }],
  inputs: ['find'],
  forEach: { step: 'find', limit }
})
const report = { id: 'report', kind: 'synthesize' as const, title: 'Report', inputs: ['verify'] }
const nothingNew = (maxRounds: number) => ({
  do: 'find',
  review: 'verify',
  until: 'nothing-new' as const,
  maxRounds
})

describe('defects Discover found in the graph runtime (live run, 2026-09-22)', () => {
  it('#1: items over the verify limit reach the report as not checked, never dropped', () => {
    const titles = ['alpha', 'beta', 'gamma', 'delta']
    const plan = drive(
      normalizeWorkflowSpec({ steps: [find(), verify(2), report], repeat: nothingNew(2) }),
      (call) =>
        call.id === 'find/r1/a0'
          ? { items: titles.map(item) }
          : call.stepId === 'find'
            ? { items: [] }
            : text('Checked.\nVERDICT: PASS')
    )
    const prompt = plan.calls.find((call) => call.stepId === 'report')!.prompt
    for (const title of titles) {
      expect(prompt).toContain(title)
    }
    expect(prompt.match(/not checked \(over the limit/g)).toHaveLength(2)
    expect(plan.outcome?.gaps).toContain(
      'Verify (round 1): 2 items over the limit of 2 were not checked; they are listed as unverified.'
    )
  })

  it('#2: a search that runs dry with its review as the final step completes with its findings', () => {
    const plan = drive(
      normalizeWorkflowSpec({ steps: [find(), verify()], repeat: nothingNew(3) }),
      (call) =>
        call.id === 'find/r1/a0'
          ? { items: [item('alpha')] }
          : call.stepId === 'find'
            ? { items: [] }
            : text('Real.\nVERDICT: PASS')
    )
    expect(plan.loop?.status).toBe('dry')
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.final?.markdown).toContain('## Confirmed (1)')
  })

  it('#5: a loop review that never ran blocks what reads it instead of passing as advisory', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          find(),
          { id: 'rules', kind: 'do', title: 'Rules', agents: [{ route: 'claude' }] },
          { ...verify(), inputs: ['find', 'rules'] },
          report
        ],
        repeat: nothingNew(2)
      }),
      (call) =>
        call.stepId === 'rules'
          ? undefined
          : call.stepId === 'find'
            ? { items: call.round === 1 ? [item('alpha')] : [] }
            : text('Report')
    )
    expect(plan.calls.some((call) => call.stepId === 'report')).toBe(false)
    expect(plan.outcome?.state).toBe('failed')
  })

  it('#6: a round in which a finder failed and nothing new came back does not end the search', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [find(4, [{ route: 'claude' }, { route: 'codex' }]), verify(), report],
        repeat: nothingNew(3)
      }),
      (call) =>
        call.id === 'find/r1/a0'
          ? { items: [item('alpha')] }
          : call.id === 'find/r2/a1'
            ? undefined
            : call.stepId === 'find'
              ? { items: [] }
              : text('Real.\nVERDICT: PASS')
    )
    expect(plan.calls.some((call) => call.id.startsWith('find/r3/'))).toBe(true)
    expect(plan.loop?.status).toBe('dry')
    expect(plan.outcome?.state).toBe('completed')
  })

  it('#8: a search that runs out of rounds says more may remain', () => {
    const plan = drive(
      normalizeWorkflowSpec({ steps: [find(), verify(), report], repeat: nothingNew(2) }),
      (call) =>
        call.stepId === 'find'
          ? { items: [item(`bug round ${call.round}`)] }
          : text('Real.\nVERDICT: PASS')
    )
    expect(plan.loop?.status).toBe('max-rounds')
    expect(plan.outcome?.gaps.join(' ')).toContain('so more may remain')
  })

  it('#3: a draft to revise is carried whole into the next round, not cut to a share', () => {
    const draft = `${'d'.repeat(40_000)}THE-END`
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          { id: 'write', kind: 'do', title: 'Write', agents: [{ route: 'claude' }] },
          {
            id: 'check',
            kind: 'review',
            title: 'Check',
            agents: [{ route: 'codex' }],
            inputs: ['write']
          }
        ],
        repeat: { do: 'write', review: 'check', until: 'approved', maxRounds: 2 }
      }),
      (call) =>
        call.stepId === 'write'
          ? text(draft)
          : text(call.round === 1 ? 'Fix it.\nVERDICT: FAIL' : 'Good.\nVERDICT: PASS')
    )
    const revision = plan.calls.find((call) => call.id === 'write/r2/a0')!.prompt
    expect(revision).toContain('THE-END')
    expect(revision).not.toContain('[… cut:')
    expect(plan.outcome?.state).toBe('completed')
  })

  it('#7: a crowded prompt shares its room; short reviews stay whole and the cuts are gaps', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          {
            id: 'draft',
            kind: 'do',
            title: 'Draft',
            agents: Array.from({ length: 8 }, () => ({ route: 'claude' }))
          },
          {
            id: 'critics',
            kind: 'review',
            title: 'Critics',
            agents: [{ route: 'codex' }],
            inputs: ['draft']
          },
          { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['draft', 'critics'] }
        ]
      }),
      (call) =>
        call.stepId === 'draft'
          ? text('a'.repeat(30_000))
          : call.stepId === 'critics'
            ? text('CRITIC-POINT: section 3 is wrong.\nVERDICT: FAIL')
            : text('Final')
    )
    const final = plan.calls.find((call) => call.stepId === 'final')!.prompt
    expect(final).toContain('CRITIC-POINT: section 3 is wrong.')
    expect(final.length).toBeLessThan(175_000)
    expect(plan.outcome?.gaps.join(' ')).toContain('cut to fit a prompt')
  })

  it('#9: a final ranking names every answer tied for first, and counts one model judging its own', () => {
    const rankSpec = (routes: string[]) =>
      normalizeWorkflowSpec({
        steps: [
          { id: 'answer', kind: 'do', title: 'Answer', agents: routes.map((route) => ({ route })) },
          {
            id: 'rank',
            kind: 'rank',
            title: 'Rank',
            agents: routes.map((route) => ({ route })),
            inputs: ['answer']
          }
        ]
      })
    // Each ranker puts the other's answer first: one vote each, a tie.
    const tie = drive(rankSpec(['claude', 'codex']), (call) =>
      call.stepId === 'answer'
        ? text(`answer ${call.agentIndex}`)
        : text(
            call.agentIndex === 0
              ? 'FINAL RANKING:\n1. Response B\n2. Response A'
              : 'FINAL RANKING:\n1. Response A\n2. Response B'
          )
    )
    expect(tie.outcome?.final?.markdown.match(/## Tied for first/g)).toHaveLength(2)
    expect(tie.outcome?.gaps.join(' ')).toContain('tied for first')
    // Every answer is the judges' own model's: none is favoured, so the votes count.
    const self = drive(rankSpec(['claude', 'claude']), (call) =>
      call.stepId === 'answer'
        ? text(`answer ${call.agentIndex}`)
        : text('FINAL RANKING:\n1. Response A\n2. Response B')
    )
    expect(self.outcome).toMatchObject({ state: 'completed' })
    expect(self.outcome?.final?.markdown).toContain('## Ranked first')
  })

  it('#10 and #14: a final review leads with the work it reviewed and states its count', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          { id: 'write', kind: 'do', title: 'Write', agents: [{ route: 'claude' }] },
          {
            id: 'check',
            kind: 'review',
            title: 'Check',
            agents: [{ route: 'codex' }, { route: 'claude' }, { route: 'codex' }],
            inputs: ['write']
          }
        ]
      }),
      (call) =>
        call.stepId === 'write'
          ? text('THE DELIVERABLE')
          : text(call.agentIndex === 1 ? 'No.\nVERDICT: FAIL' : 'Yes.\nVERDICT: PASS')
    )
    const markdown = plan.outcome?.final?.markdown ?? ''
    expect(markdown.startsWith('THE DELIVERABLE')).toBe(true)
    expect(markdown).toContain(
      'Not approved: 2 reviewers of 3 passed it, and approval needs every reviewer.'
    )
  })

  it('#12: until approved, a review that could not run stops the loop instead of revising blind', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          { id: 'write', kind: 'do', title: 'Write', agents: [{ route: 'claude' }] },
          { id: 'rules', kind: 'do', title: 'Rules', agents: [{ route: 'claude' }] },
          {
            id: 'check',
            kind: 'review',
            title: 'Check',
            agents: [{ route: 'codex' }],
            inputs: ['write', 'rules']
          }
        ],
        repeat: { do: 'write', review: 'check', until: 'approved', maxRounds: 3 }
      }),
      (call) => (call.stepId === 'rules' ? undefined : text('draft'))
    )
    expect(plan.calls.some((call) => call.id.startsWith('write/r2/'))).toBe(false)
    expect(plan.loop?.status).toBe('failed')
    expect(plan.outcome?.state).toBe('failed')
  })

  it('#13: once a step after an approved loop recorded a call, the loop review is final', () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        { id: 'write', kind: 'do', title: 'Write', agents: [{ route: 'claude' }] },
        {
          id: 'check',
          kind: 'review',
          title: 'Check',
          agents: [{ route: 'codex' }],
          inputs: ['write']
        },
        { id: 'summary', kind: 'synthesize', title: 'Summary', inputs: ['write'] }
      ],
      repeat: { do: 'write', review: 'check', until: 'approved', maxRounds: 2 }
    })
    expect(graphCallSuperseded(spec, 'check/r1/a0', ['write/r1/a0', 'summary/a0'])).toBe(true)
    expect(graphCallSuperseded(spec, 'check/r1/a0', ['write/r1/a0'])).toBe(false)
  })
})
