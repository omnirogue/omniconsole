import { expect, it } from 'vitest'
import { planReportChain } from './__fixtures__/work-plan/plan-report-chain'
import type { SessionChain } from './session-chain-types'
import type { SessionOutcome } from './session-outcome-types'
import { workPlanCardPost } from './work-plan-card-post'

const CARD = 'btk_launch01'

function attached(patch: Partial<SessionOutcome> = {}): SessionChain {
  const chain = planReportChain()
  const outcome = chain.outcomeSet!.outcomes[0]!
  return {
    ...chain,
    outcomeSet: {
      ...chain.outcomeSet!,
      outcomes: [
        {
          ...outcome,
          taskRef: { taskId: CARD, attachedAt: 1_750_000_000_000 },
          ...patch
        }
      ]
    }
  }
}

/** The review receipt the person's approval writes; it is what makes the Outcome satisfied. */
function approval(outcome: SessionOutcome) {
  return {
    ...outcome.evidence[0]!,
    id: 'evidence-review',
    conditionId: 'dw-review',
    conditionKey: 'review:launch',
    kind: 'review' as const,
    target: 'launch',
    receipt: 'review:approved:1',
    version: undefined
  }
}

it('posts nothing for a standalone pursuit', () => {
  expect(workPlanCardPost(planReportChain())).toBeNull()
})

it('files a progress note while the Outcome is unproven, with an empty done[]', () => {
  const post = workPlanCardPost(attached({ evidence: [] }), null)
  expect(post?.taskId).toBe(CARD)
  expect(post?.note.note_kind).toBe('progress')
  expect(post?.note.payload.done).toEqual([])
  expect(post?.note.payload.next_action).toBe('none')
  // A progress note still carries what the host really holds: the spent verdict.
  expect(post?.note.payload.evidence.map((entry) => entry.ref)).toEqual([
    'plan-judge:select-winner:1'
  ])
  expect(post?.note.payload.knowledge).toEqual([])
})

it('files a final_report only when every Done When has a receipt', () => {
  const chain = attached()
  const outcome = chain.outcomeSet!.outcomes[0]!
  const satisfied = attached({
    status: 'satisfied',
    evidence: [...outcome.evidence, approval(outcome)]
  })
  const post = workPlanCardPost(satisfied, { label: 'Ship it' })!
  expect(post.note.note_kind).toBe('final_report')
  expect(post.note.payload.done).toHaveLength(2)
  expect(post.note.payload.evidence.length).toBeGreaterThanOrEqual(1)
  expect(post.note.payload.next_action).toBe('Ship it')
  expect(post.note.payload.knowledge).toHaveLength(1)
  expect(post.note.payload.summary.length).toBeLessThanOrEqual(200)
  expect(post.note).toMatchSnapshot()
})

it('maps each receipt to a task_evidence row of the right kind, and invents none', () => {
  const chain = attached()
  const outcome = chain.outcomeSet!.outcomes[0]!
  const withPr = attached({
    conditions: [
      ...outcome.conditions,
      { id: 'dw-pr', kind: 'pr', label: 'the PR is open', target: 'omnirogue/omni-ide#1' }
    ],
    evidence: [
      ...outcome.evidence,
      {
        ...outcome.evidence[0]!,
        id: 'evidence-pr',
        conditionId: 'dw-pr',
        conditionKey: 'pr:omnirogue/omni-ide#1',
        kind: 'pr',
        target: 'omnirogue/omni-ide#1',
        receipt: 'pr:open:1'
      }
    ]
  })
  const post = workPlanCardPost(withPr)!
  expect(post.evidence).toEqual([
    {
      kind: 'doc',
      ref: `sha256:${'a'.repeat(64)}:/workspace/launch/.omni/runs/chain-plan-report/plan-1/plan.json`,
      title: 'the plan document exists and matches work-plan-v1'
    },
    { kind: 'pr', ref: 'omnirogue/omni-ide#1', title: 'the PR is open' }
  ])
  // The unproven review condition has no receipt, so it appears in no row and in no done[].
  expect(post.note.payload.done).not.toContain('you approved the plan')
})

it('keeps a prior revision’s receipts as history, labelled with the revision they proved', () => {
  const chain = attached()
  const outcome = chain.outcomeSet!.outcomes[0]!
  const post = workPlanCardPost({
    ...chain,
    outcomeSet: {
      ...chain.outcomeSet!,
      evidenceHistory: [{ ...outcome.evidence[0]!, id: 'old', outcomeRevision: 1 }]
    }
  })!
  expect(post.note.payload.evidence.some((entry) => entry.label.startsWith('revision 1:'))).toBe(
    true
  )
})
