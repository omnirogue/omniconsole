import { describe, expect, it } from 'vitest'
import { reviewRoundContractProblems } from '../../shared/session-chain-review-contract'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import { compileNextStepChain } from '../../shared/next-step-compile'
import {
  emptyNextStepDraft,
  type NextStepActor,
  type NextStepOutcomeStep
} from '../../shared/next-step-draft'
import { materializeSessionOutcomeSourceRepairs } from './session-outcome-source-repairs'

/**
 * Parity with the host-side review-round sites, so switching them to the one contract cannot
 * change what runs: session-outcome-source-repairs.ts:91,132,151 and session-outcome-steps.ts:140-161.
 */
const source: NextStepActor = { agent: 'codex', model: 'gpt-5.6-terra', effort: 'high' }

function reviews(maxRounds = 3, rounds = maxRounds): SessionChainAgentStep[] {
  return Array.from({ length: rounds }, (_, index) => index + 1).flatMap((round) =>
    ['first', 'second'].map((reviewerId) => ({
      id: `report_${reviewerId}_${round}`,
      outcomeId: 'report',
      editorStepId: 'report_review_editor',
      agent: 'codex' as const,
      model: 'gpt-6-astra',
      prompt: 'Review the finished report.',
      presetId: 'review' as const,
      status: 'queued' as const,
      group: `report_review_round_${round}`,
      review: {
        groupId: 'report_review',
        reviewerId,
        round,
        maxRounds,
        candidateVersion: `report:candidate:${round}`,
        repairWithSource: true
      }
    }))
  )
}

function chainWith(steps: SessionChainStep[]): SessionChain {
  return {
    id: 'chain',
    workspacePath: '/workspace',
    worktreeId: 'workspace',
    hostId: 'local',
    sourcePaneKey: 'source-pane',
    sourceRowKey: 'source-row',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps,
    outcomeSet: {
      schemaVersion: 1,
      revision: 1,
      updatedAt: 1,
      removals: [],
      attempts: [],
      completedSteps: [],
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: [
        {
          id: 'report',
          title: 'report',
          revision: 1,
          finish: 'my-review',
          status: 'pending',
          evidence: [],
          actions: [],
          dependsOn: [],
          conditions: [{ id: 'report', kind: 'report', target: 'report.md' }],
          stepIds: steps.map((step) => step.id)
        }
      ]
    }
  }
}

function problems(
  chain: Pick<SessionChain, 'steps'>,
  when: 'authored' | 'launching' = 'authored'
): { code: string; message: string }[] {
  const seen = new Map<string, string>()
  for (const step of chain.steps) {
    for (const problem of reviewRoundContractProblems(chain, step, when)) {
      seen.set(problem.code, problem.message)
    }
  }
  return [...seen].map(([code, message]) => ({ code, message }))
}

function refusal(chain: SessionChain): string {
  try {
    materializeSessionOutcomeSourceRepairs(chain, source)
    return ''
  } catch (error) {
    return (error as Error).message
  }
}

describe('review-round contract parity with the host', () => {
  it('accepts what the host accepts, and asks for the repairs only once a round must launch', () => {
    const chain = chainWith(reviews())
    expect(refusal(chain)).toBe('')
    expect(problems(chain)).toEqual([])
    expect(problems(chain, 'launching')).toEqual([
      {
        code: 'review-rounds-need-repair',
        // Verbatim from session-outcome-steps.ts:157.
        message: 'Repeated review rounds require their authorized repair owner before execution.'
      }
    ])
    const materialized = materializeSessionOutcomeSourceRepairs(chain, source)
    expect(problems(materialized, 'launching')).toEqual([])
  })

  it("refuses more rounds than the limit, in the host's own words", () => {
    const chain = chainWith(reviews(9, 3))
    expect(refusal(chain)).toBe('Repeated reviews must stay within the five-round limit.')
    expect(problems(chain)).toContainEqual({
      code: 'review-rounds-over-cap',
      message: 'Repeated reviews must stay within the five-round limit.'
    })
  })

  it('refuses a group that disagrees about its round count or its repair owner', () => {
    const steps = reviews()
    const chain = chainWith([
      ...steps.slice(0, 5),
      { ...steps[5]!, review: { ...steps[5]!.review!, repairWithSource: false } }
    ])
    expect(refusal(chain)).toBe(
      'Every source review must keep the same selected round count and repair owner.'
    )
    expect(problems(chain)).toContainEqual({
      code: 'review-group-inconsistent',
      message: 'Every source review must keep the same selected round count and repair owner.'
    })
  })

  it('refuses a round that lost its reviewers', () => {
    const chain = chainWith(reviews(3, 2))
    expect(refusal(chain)).toBe(
      'A repeated review round is missing its reviewers. Save the review plan again.'
    )
    expect(problems(chain)).toContainEqual({
      code: 'review-round-missing-reviewers',
      message: 'A repeated review round is missing its reviewers. Save the review plan again.'
    })
  })

  it('refuses rounds that do not keep the same unique reviewers', () => {
    const steps = reviews()
    const chain = chainWith([
      ...steps.slice(0, 2),
      { ...steps[2]!, review: { ...steps[2]!.review!, reviewerId: 'third' } },
      ...steps.slice(3)
    ])
    expect(refusal(chain)).toBe(
      'Every review round must retain the same unique selected reviewers.'
    )
    expect(problems(chain)).toContainEqual({
      code: 'review-round-reviewers-differ',
      message: 'Every review round must retain the same unique selected reviewers.'
    })
  })

  it('refuses a second source repair for one round', () => {
    const materialized = materializeSessionOutcomeSourceRepairs(chainWith(reviews()), source)
    const repair = materialized.steps.find(
      (step): step is SessionChainAgentStep => step.kind !== 'handoff' && Boolean(step.reviewRepair)
    )!
    const doubled = chainWith(
      materialized.steps.flatMap((step) =>
        step.id === repair.id ? [step, { ...repair, id: `${repair.id}_again` }] : [step]
      )
    )
    expect(refusal(doubled)).toBe('This review round already has more than one source repair step.')
    expect(problems(doubled)).toContainEqual({
      code: 'review-repair-duplicate',
      message: 'This review round already has more than one source repair step.'
    })
  })
})

/**
 * The rows of session-outcome-shape-conformance.test.ts, which pins what each enforcement point
 * says today, run through the one contract. A row whose verdict differs is named below with the
 * sentence that changes when its owner switches over; nothing here edits that file.
 */
const ASTRA: NextStepActor = { agent: 'codex', model: 'gpt-6-astra', effort: 'high' }
const OPUS: NextStepActor = { agent: 'claude', model: 'opus' }
const SONNET: NextStepActor = { agent: 'claude', model: 'sonnet' }
const PRODUCER: NextStepActor = { agent: 'codex', model: 'gpt-5.6-terra', effort: 'high' }

const buildStep = (
  id: string,
  actor: NextStepActor = PRODUCER,
  parallelGroup?: string
): NextStepOutcomeStep => ({
  id,
  kind: 'handoff',
  actor,
  presetId: 'implement',
  instructions: 'Ship it',
  ...(parallelGroup ? { parallelGroup } : {})
})
const repairStep = (id: string, actor: NextStepActor = PRODUCER): NextStepOutcomeStep => ({
  id,
  kind: 'handoff',
  actor,
  presetId: 'improve',
  instructions: 'Ship it',
  reviewRepair: true
})
const reviewStep = (
  reviewers: NextStepActor[],
  maxRounds: number,
  extra: { repairWithSource?: boolean; adversarial?: boolean } = {}
): NextStepOutcomeStep => ({
  id: 'review',
  kind: 'review',
  reviewers,
  maxRounds,
  instructions: 'Ship it',
  adversarial: extra.adversarial === true,
  ...(extra.repairWithSource ? { repairWithSource: true } : {})
})

function compileShape(steps: NextStepOutcomeStep[]): Pick<SessionChain, 'steps'> {
  return compileNextStepChain({
    draft: {
      ...emptyNextStepDraft(),
      outcomes: [{ id: 'ship', finish: { kind: 'complete' }, instructions: '', steps }]
    },
    chainId: 'chain',
    workspacePath: '/work',
    sessionLabel: 'Ship',
    defaultNote: 'Ship',
    now: 0,
    mintStepId: (position) => `dialog_step_${position}`,
    mintOperationId: () => 'dialog_operation'
  })
}

const ROWS: {
  name: string
  steps: NextStepOutcomeStep[]
  authored: string[]
  launching: string[]
}[] = [
  {
    name: 'one report-only round',
    steps: [buildStep('build'), reviewStep([ASTRA], 1)],
    authored: [],
    launching: []
  },
  {
    name: 'two rounds with a repair seat on the producer model',
    steps: [buildStep('build'), reviewStep([ASTRA], 2), repairStep('repair')],
    authored: [],
    launching: []
  },
  {
    // The canonical compiler also refuses this row because it cannot represent a repair seat on
    // another model; that is a format limit, not a round rule, so it keeps its own refusal.
    name: 'two rounds with a repair seat on another model',
    steps: [buildStep('build'), reviewStep([ASTRA], 2), repairStep('repair', SONNET)],
    authored: [],
    launching: []
  },
  {
    name: 'two rounds repaired by the original source',
    steps: [buildStep('build'), reviewStep([ASTRA], 2, { repairWithSource: true })],
    authored: [],
    launching: ['review-rounds-need-repair']
  },
  {
    name: 'five rounds repaired by the original source',
    steps: [buildStep('build'), reviewStep([ASTRA], 5, { repairWithSource: true })],
    authored: [],
    launching: ['review-rounds-need-repair']
  },
  {
    name: 'six rounds is over the five-round limit',
    steps: [buildStep('build'), reviewStep([ASTRA], 6, { repairWithSource: true })],
    authored: ['review-rounds-over-cap'],
    launching: ['review-rounds-over-cap']
  },
  {
    name: 'a parallel pair placed after a review',
    steps: [
      buildStep('build'),
      reviewStep([ASTRA], 1),
      buildStep('api', PRODUCER, 'after'),
      buildStep('ui', SONNET, 'after')
    ],
    authored: [],
    launching: []
  },
  {
    name: 'an adversarial round with two reviewers',
    steps: [buildStep('build'), reviewStep([ASTRA, OPUS], 1, { adversarial: true })],
    authored: [],
    launching: []
  },
  {
    // The canonical compiler refuses a review with no producer ahead of it; the dialog and the
    // team compiler both author it, so the contract keeps their verdict and leaves that rule
    // with the canonical compiler.
    name: 'a review with no producer before it',
    steps: [reviewStep([ASTRA], 1)],
    authored: [],
    launching: []
  }
]

describe('the one contract over the pinned conformance rows', () => {
  it.each(ROWS)('$name', (row) => {
    const chain = compileShape(row.steps)
    expect(chain.steps.length).toBeGreaterThan(0)
    expect(problems(chain).map((entry) => entry.code)).toEqual(row.authored)
    expect(problems(chain, 'launching').map((entry) => entry.code)).toEqual(row.launching)
  })

  it("refuses a repeated review whose repairer was stripped, in the executor's words", () => {
    const chain = compileShape([buildStep('build'), reviewStep([ASTRA], 2), repairStep('repair')])
    const stripped = {
      steps: chain.steps.filter((step) => step.kind === 'handoff' || !step.reviewRepair)
    }
    expect(problems(stripped)).toEqual([
      {
        code: 'review-rounds-need-repair',
        message: 'Repeated review rounds require their authorized repair owner before execution.'
      }
    ])
  })
})
