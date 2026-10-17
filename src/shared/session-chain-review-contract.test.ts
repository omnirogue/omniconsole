import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from './next-step-compile'
import {
  emptyNextStepDraft,
  nextStepReviewRepairProblem,
  nextStepReviewRoundsProblem,
  type NextStepOutcomeStep
} from './next-step-draft'
import { sessionReviewRoundDecision, type SessionReviewReceipt } from './session-chain-review'
import { transitionSessionReviewRound } from './session-chain-review-transition'
import { reviewRoundContractProblems } from './session-chain-review-contract'
import type { SessionChain, SessionChainAgentStep } from './session-chain-types'

const review: NextStepOutcomeStep = {
  id: 'review',
  kind: 'review',
  reviewers: [{ agent: 'claude' }, { agent: 'codex' }],
  maxRounds: 1,
  adversarial: false,
  instructions: 'Review the report.'
}

const repair: NextStepOutcomeStep = {
  id: 'repair',
  kind: 'handoff',
  actor: { agent: 'grok' },
  presetId: 'improve',
  reviewRepair: true,
  instructions: 'Repair the findings.'
}

function compile(steps: NextStepOutcomeStep[]): Pick<SessionChain, 'steps'> {
  return compileNextStepChain({
    draft: {
      ...emptyNextStepDraft(),
      outcomes: [{ id: 'outcome', finish: { kind: 'complete' }, instructions: '', steps }]
    },
    chainId: 'chain',
    workspacePath: '/work',
    sessionLabel: 'Report',
    defaultNote: 'Report',
    now: 1,
    mintStepId: (index) => `step_${index}`,
    mintOperationId: () => 'handoff'
  })
}

function reviewers(chain: Pick<SessionChain, 'steps'>): SessionChainAgentStep[] {
  return chain.steps.filter(
    (step): step is SessionChainAgentStep => step.kind !== 'handoff' && Boolean(step.review)
  )
}

function codes(
  chain: Pick<SessionChain, 'steps'>,
  when: 'authored' | 'launching' = 'authored'
): string[] {
  return [
    ...new Set(
      chain.steps.flatMap((step) =>
        reviewRoundContractProblems(chain, step, when).map((problem) => problem.code)
      )
    )
  ]
}

function edit(
  chain: Pick<SessionChain, 'steps'>,
  id: string,
  patch: Partial<SessionChainAgentStep>
): Pick<SessionChain, 'steps'> {
  return {
    steps: chain.steps.map((step) =>
      step.id === id ? ({ ...step, ...patch } as SessionChainAgentStep) : step
    )
  }
}

function withRounds(
  chain: Pick<SessionChain, 'steps'>,
  maxRounds: number
): Pick<SessionChain, 'steps'> {
  return {
    steps: chain.steps.map((step) =>
      step.kind !== 'handoff' && step.review
        ? ({ ...step, review: { ...step.review, maxRounds } } as SessionChainAgentStep)
        : step
    )
  }
}

describe('the one review-round contract', () => {
  it('says nothing about a step that is not part of a round', () => {
    const chain = compile([review])
    expect(
      reviewRoundContractProblems(chain, {
        id: 'x',
        agent: 'claude',
        prompt: 'p',
        status: 'queued'
      })
    ).toEqual([])
  })

  it('accepts every round the compiler produces today', () => {
    expect(codes(compile([review]))).toEqual([])
    expect(codes(compile([{ ...review, maxRounds: 3 }, repair]))).toEqual([])
    expect(codes(compile([{ ...review, maxRounds: 3 }, repair]), 'launching')).toEqual([])
  })

  // next-step-draft.ts:227-245 — the authoring rules the composer shows, and
  // next-outcome-compile.ts:131-138, which refuses to compile anything they reject.
  it('agrees with the draft rules about rounds that have no repair owner', () => {
    const unowned = { ...review, maxRounds: 3 }
    expect(nextStepReviewRoundsProblem(unowned, undefined)).toBe(
      'Choose one report-only round, or enable repairs for additional rounds.'
    )
    const compiled = compileNextStepChain({
      draft: {
        ...emptyNextStepDraft(),
        outcomes: [
          { id: 'outcome', finish: { kind: 'complete' }, instructions: '', steps: [unowned] }
        ]
      },
      chainId: 'chain',
      workspacePath: '/work',
      sessionLabel: 'Report',
      defaultNote: 'Report',
      now: 1,
      mintStepId: (index) => `step_${index}`,
      mintOperationId: () => 'handoff'
    })
    expect(compiled.problems).toMatchObject([{ kind: 'invalid-review-repair' }])
    expect(compiled.steps).toEqual([])
    // The same shape reaching a chain by any other door is refused here instead.
    expect(codes(withRounds(compile([review]), 3))).toContain('review-rounds-need-repair')
    expect(nextStepReviewRepairProblem(repair, undefined)).toBe(
      'Place a repair agent immediately after its review, or turn off repair mode.'
    )
  })

  // next-outcome-compile.ts:191-218 — reviewer identity, round group and candidate version.
  it('refuses a round whose reviewers lost their distinct identities', () => {
    const chain = compile([{ ...review, maxRounds: 2 }, repair])
    const [first, second] = reviewers(chain)
    const collided = edit(chain, second!.id, {
      review: { ...second!.review!, reviewerId: first!.review!.reviewerId }
    })
    expect(codes(collided)).toContain('review-round-reviewers-differ')
    // The same chain deadlocks the runtime decision, which is what the rule protects.
    const receipts: SessionReviewReceipt[] = [first!, second!].map((step) => ({
      stepId: step.id,
      reviewerId: first!.review!.reviewerId,
      candidateVersion: first!.review!.candidateVersion,
      status: 'pass',
      blockingFindings: [],
      recordedAt: 1
    }))
    expect(
      sessionReviewRoundDecision({
        expectedReviewerIds: [first!.review!.reviewerId, second!.review!.reviewerId],
        receipts,
        candidateVersion: first!.review!.candidateVersion,
        round: 1,
        maxRounds: 2,
        reviewOnly: false
      })
    ).toBe('blocked')
  })

  it('refuses reviewers of one round judging different candidate versions', () => {
    const chain = compile([{ ...review, maxRounds: 2 }, repair])
    const [, second] = reviewers(chain)
    expect(
      codes(edit(chain, second!.id, { review: { ...second!.review!, candidateVersion: 'other' } }))
    ).toContain('review-round-candidate-version')
  })

  // session-outcome-source-repairs.ts:91,132,151 — the host's shape rules for repeated reviews.
  it('refuses more rounds than the five-round limit and a group that disagrees with itself', () => {
    const chain = compile([{ ...review, maxRounds: 2 }, repair])
    const [first, second] = reviewers(chain)
    expect(
      codes(edit(chain, first!.id, { review: { ...first!.review!, maxRounds: 9 } }))
    ).toContain('review-rounds-over-cap')
    expect(
      codes(edit(chain, second!.id, { review: { ...second!.review!, repairWithSource: true } }))
    ).toContain('review-group-inconsistent')
  })

  it('refuses a round with no reviewers left in it', () => {
    const chain = compile([{ ...review, maxRounds: 2 }, repair])
    const round2 = reviewers(chain).filter((step) => step.review!.round === 2)
    expect(
      codes({ steps: chain.steps.filter((step) => !round2.some((entry) => entry.id === step.id)) })
    ).toContain('review-round-missing-reviewers')
  })

  it('refuses more than five reviewers in one round', () => {
    const six = Array.from({ length: 6 }, (_, index) => ({
      agent: 'claude' as const,
      model: `m${index}`
    }))
    expect(codes(compile([{ ...review, reviewers: six }]))).toContain('review-too-many-reviewers')
  })

  it('refuses two repairs for one round, a repair out of order and a forged consumption key', () => {
    const chain = compile([{ ...review, maxRounds: 2 }, repair])
    const found = chain.steps.find(
      (step): step is SessionChainAgentStep => step.kind !== 'handoff' && Boolean(step.reviewRepair)
    )!
    expect(codes({ steps: [...chain.steps, { ...found, id: `${found.id}_again` }] })).toContain(
      'review-repair-duplicate'
    )
    expect(
      codes({ steps: [found, ...chain.steps.filter((step) => step.id !== found.id)] })
    ).toContain('review-repair-out-of-order')
    expect(
      codes(
        edit(chain, found.id, { reviewRepair: { ...found.reviewRepair!, consumptionKey: 'k' } })
      )
    ).toContain('review-repair-consumption-key')
  })

  it('refuses a repair that names a review this plan does not have', () => {
    const chain = compile([{ ...review, maxRounds: 2 }, repair])
    const found = chain.steps.find(
      (step): step is SessionChainAgentStep => step.kind !== 'handoff' && Boolean(step.reviewRepair)
    )!
    expect(
      reviewRoundContractProblems({ steps: [found] }, found).map((entry) => entry.code)
    ).toEqual(['review-repair-unknown-group'])
  })

  it('refuses an assignment whose round cannot exist', () => {
    const chain = compile([review])
    const [first] = reviewers(chain)
    expect(codes(edit(chain, first!.id, { review: { ...first!.review!, round: 4 } }))).toEqual([
      'review-assignment-invalid'
    ])
  })

  // The original builder repairs: legal at authoring, required before the host launches a round.
  // next-step-outcome-sections.ts:68 defaults it on; session-outcome-steps.ts:140-161 demands the
  // materialized steps; session-chain-review-transition.ts:47-77 blocks the round without an owner.
  it('lets the original builder own the repairs until the host has to launch them', () => {
    const chain = compile([{ ...review, maxRounds: 3, repairWithSource: true }])
    expect(reviewers(chain)).toHaveLength(6)
    expect(codes(chain)).toEqual([])
    expect(codes(chain, 'launching')).toEqual(['review-rounds-need-repair'])
  })

  it('refuses the round the runtime transition also refuses', () => {
    const chain = withRounds(compile([review]), 3)
    const [first] = reviewers(chain)
    const transition = transitionSessionReviewRound({
      assignment: { ...first!.review!, round: 1 },
      reviewers: [
        {
          stepId: first!.id,
          reviewerId: first!.review!.reviewerId,
          output: 'OMNI_REVIEW_RESULT:{"status":"findings","blockingFindings":["x"]}'
        }
      ],
      hasAuthorizedRepair: false,
      reviewOnly: false,
      now: 1
    })
    expect(transition.next).toBe('block')
    expect(codes(chain)).toContain('review-rounds-need-repair')
  })
})
