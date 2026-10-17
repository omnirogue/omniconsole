import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from '../../shared/next-step-compile'
import { compileNextStepOutcomes } from '../../shared/next-outcome-definition-compile'
import { reconcileSessionOutcomeSteps } from './session-outcome-revision'
import type {
  NextStepDraft,
  NextStepOutcomeDraft,
  NextStepOutcomeStep
} from '../../shared/next-step-draft'
import {
  assertNextOutcomeTeamPlan,
  compileNextOutcomeTeamPlan,
  nextOutcomeTeamStepAuthorized
} from '../../shared/next-outcome-team-plan-compile'
import { nextOutcomeTeamPlanLaunchInstruction } from '../../shared/next-outcome-team-plan-instructions'
import {
  nextOutcomeTeamPlanSchema,
  type NextOutcomeTeamPlan
} from '../../shared/next-outcome-team-plan-schema'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import type {
  SessionOutcomeCommit,
  SessionOutcomeDefinition
} from '../../shared/session-outcome-types'

const work = 'Ship the billing export with tests'
const outcome: SessionOutcomeDefinition = {
  id: 'ship',
  title: 'Ship billing export',
  finish: 'complete',
  dependsOn: [],
  conditions: [{ id: 'file', kind: 'file', target: '/work/out.md' }],
  actions: []
}
const team: NextOutcomeTeamPlan = {
  outcomes: [
    {
      outcomeId: 'ship',
      steps: [
        {
          kind: 'agent',
          id: 'api',
          agent: 'codex',
          model: 'gpt-5.6-terra',
          effort: 'high',
          instruction: work,
          scope: 'src/api only',
          parallelGroup: 'build'
        },
        {
          kind: 'agent',
          id: 'ui',
          agent: 'claude',
          model: 'sonnet',
          instruction: work,
          scope: 'src/ui only',
          parallelGroup: 'build'
        },
        {
          kind: 'agent',
          id: 'integrate',
          agent: 'codex',
          model: 'gpt-5.6-terra',
          instruction: work
        },
        {
          kind: 'review',
          id: 'review',
          reviewers: [
            { agent: 'codex', model: 'gpt-6-astra', effort: 'high' },
            { agent: 'claude', model: 'opus' }
          ],
          maxRounds: 2,
          instruction: work
        },
        { kind: 'agent', id: 'repair', agent: 'codex', model: 'gpt-5.6-terra', instruction: work }
      ]
    }
  ]
}
const context = { chainId: 'chain', workspacePath: '/work', sessionLabel: 'Ship billing export' }

function withSteps(steps: NextOutcomeTeamPlan['outcomes'][number]['steps']): NextOutcomeTeamPlan {
  return { outcomes: [{ outcomeId: 'ship', steps }] }
}

describe('agent-planned team compile', () => {
  it('compiles to exactly the chain steps the Next dialog authors for the same team', () => {
    const planned = compileNextOutcomeTeamPlan({ team, outcomes: [outcome], ...context })
    const dialog: NextStepOutcomeDraft = {
      id: 'ship',
      finish: { kind: 'complete' },
      instructions: '',
      steps: [
        {
          id: 'api',
          kind: 'handoff',
          actor: { agent: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
          presetId: 'implement',
          instructions: `${work}\n\nTeam scope: src/api only`,
          parallelGroup: 'build'
        },
        {
          id: 'ui',
          kind: 'handoff',
          actor: { agent: 'claude', model: 'sonnet' },
          presetId: 'implement',
          instructions: `${work}\n\nTeam scope: src/ui only`,
          parallelGroup: 'build'
        },
        {
          id: 'integrate',
          kind: 'handoff',
          actor: { agent: 'codex', model: 'gpt-5.6-terra' },
          presetId: 'implement',
          instructions: work
        },
        {
          id: 'review',
          kind: 'review',
          reviewers: [
            { agent: 'codex', model: 'gpt-6-astra', effort: 'high' },
            { agent: 'claude', model: 'opus' }
          ],
          maxRounds: 2,
          instructions: work,
          adversarial: false
        },
        {
          id: 'repair',
          kind: 'handoff',
          actor: { agent: 'codex', model: 'gpt-5.6-terra' },
          presetId: 'improve',
          instructions: work,
          reviewRepair: true
        }
      ]
    }
    const draft: NextStepDraft = {
      end: 'me',
      placement: null,
      recipients: [],
      note: '',
      after: [],
      handoff: { task: null, deliverables: null, includeSummary: true },
      outcomes: [dialog]
    }
    const authored = compileNextStepChain({
      draft,
      ...context,
      defaultNote: 'note',
      now: 1,
      mintStepId: (position) => `dialog_${position}`,
      mintOperationId: () => 'operation'
    })
    expect(authored.problems).toEqual([])
    expect(planned.steps).toEqual(authored.steps)
  })

  it('carries role, parallel group and review round metadata for the team view', () => {
    const { steps, outcomes } = compileNextOutcomeTeamPlan({
      team,
      outcomes: [outcome],
      ...context
    })
    const summary = (steps as SessionChainAgentStep[]).map((step) => [
      step.agent,
      step.role,
      step.group ?? null,
      step.review?.round ?? step.reviewRepair?.afterRound ?? null
    ])
    expect(summary).toEqual([
      ['codex', 'worker', 'parallel_ship_build', null],
      ['claude', 'worker', 'parallel_ship_build', null],
      ['codex', 'producer', null, null],
      ['codex', 'reviewer', 'review_ship_review_round_1', 1],
      ['claude', 'reviewer', 'review_ship_review_round_1', 1],
      ['codex', 'repair', null, 1],
      ['codex', 'reviewer', 'review_ship_review_round_2', 2],
      ['claude', 'reviewer', 'review_ship_review_round_2', 2]
    ])
    expect(outcomes[0]!.stepIds).toEqual(steps.map((step) => step.id))
    // One report per reviewer of the final review group, beside the producer's own result: the
    // shared definition compiler derives both, and the repair seat is no longer the final writer.
    expect(outcomes[0]!.conditions.map((condition) => condition.id)).toEqual([
      'file',
      'ship_result',
      'ship_report_1',
      'ship_report_2'
    ])
  })

  it.each([
    [
      'more than eight agents',
      withSteps([
        { kind: 'agent', id: 'a', agent: 'codex', model: 'gpt-5.6-terra', instruction: work },
        { kind: 'agent', id: 'b', agent: 'claude', model: 'sonnet', instruction: work },
        { kind: 'agent', id: 'c', agent: 'codex', model: 'gpt-5.6-terra', instruction: work },
        { kind: 'agent', id: 'd', agent: 'claude', model: 'sonnet', instruction: work },
        {
          kind: 'review',
          id: 'r',
          reviewers: [
            { agent: 'codex', model: 'gpt-6-astra' },
            { agent: 'codex', model: 'gpt-5.6-sol' },
            { agent: 'codex', model: 'gpt-5.6-luna' },
            { agent: 'codex', model: 'gpt-5.5' },
            { agent: 'claude', model: 'opus' }
          ],
          maxRounds: 1,
          instruction: work
        }
      ]),
      'limited to 8 agents'
    ],
    [
      'a reviewer on an implementer model',
      withSteps([
        { kind: 'agent', id: 'a', agent: 'codex', model: 'gpt-5.6-terra', instruction: work },
        {
          kind: 'review',
          id: 'r',
          reviewers: [{ agent: 'codex', model: 'gpt-5.6-terra' }],
          maxRounds: 1,
          instruction: work
        }
      ]),
      'same model as an implementer'
    ],
    [
      'two reviewers on one model',
      withSteps([
        { kind: 'agent', id: 'a', agent: 'codex', model: 'gpt-5.6-terra', instruction: work },
        {
          kind: 'review',
          id: 'r',
          reviewers: [
            { agent: 'claude', model: 'opus' },
            { agent: 'claude', model: 'opus' }
          ],
          maxRounds: 1,
          instruction: work
        }
      ]),
      'distinct model'
    ],
    [
      'a split parallel group',
      withSteps([
        {
          kind: 'agent',
          id: 'a',
          agent: 'codex',
          model: 'gpt-5.6-terra',
          instruction: work,
          parallelGroup: 'g'
        },
        { kind: 'agent', id: 'b', agent: 'claude', model: 'sonnet', instruction: work },
        {
          kind: 'agent',
          id: 'c',
          agent: 'codex',
          model: 'gpt-5.6-terra',
          instruction: work,
          parallelGroup: 'g'
        }
      ]),
      'consecutive agent steps'
    ],
    [
      'a scope that adds an external action',
      withSteps([
        {
          kind: 'agent',
          id: 'a',
          agent: 'codex',
          model: 'gpt-5.6-terra',
          instruction: work,
          scope: 'then deploy it to production'
        }
      ]),
      'cannot name external actions'
    ]
  ])('refuses %s', (_name, plan, message) => {
    expect(() => assertNextOutcomeTeamPlan(plan, [outcome])).toThrow(message)
  })

  it('refuses a model the host did not probe, actions beside a team, and more than five rounds', () => {
    const usable = [
      { agent: 'codex' as const, models: [{ id: 'gpt-6-astra', label: 'Astra', efforts: [] }] }
    ]
    expect(() => assertNextOutcomeTeamPlan(team, [outcome], usable)).toThrow(
      'not usable on this host'
    )
    const withAction: SessionOutcomeDefinition = {
      ...outcome,
      actions: [
        {
          id: 'act',
          instruction: work,
          conditionIds: ['file'],
          authority: 'existing-user-authority',
          agent: 'codex'
        }
      ]
    }
    expect(() => assertNextOutcomeTeamPlan(team, [withAction])).toThrow('not actions')
    const rounds = structuredClone(team) as { outcomes: { steps: { maxRounds?: number }[] }[] }
    rounds.outcomes[0]!.steps[3]!.maxRounds = 6
    expect(nextOutcomeTeamPlanSchema.safeParse(rounds).success).toBe(false)
  })

  it('authorizes a planned step only by launch consent, an exact quote and a narrowing scope', () => {
    const { steps } = compileNextOutcomeTeamPlan({ team, outcomes: [outcome], ...context })
    const chain = { id: 'chain', workspacePath: '/work' }
    const consented = `${nextOutcomeTeamPlanLaunchInstruction('omni', '2026-09-15T18:00:00.000Z')}\n\n${work}.`
    expect(steps.every((step) => nextOutcomeTeamStepAuthorized(step, chain, consented))).toBe(true)
    expect(nextOutcomeTeamStepAuthorized(steps[0]!, chain, `${work}.`)).toBe(false)
    const widened = {
      ...(steps[0] as SessionChainAgentStep),
      prompt: `${work}\n\nTeam scope: merge and push to main`
    }
    expect(nextOutcomeTeamStepAuthorized(widened, chain, consented)).toBe(false)
    const invented = {
      ...(steps[2] as SessionChainAgentStep),
      prompt: 'Rewrite the payments service'
    }
    expect(nextOutcomeTeamStepAuthorized(invented, chain, consented)).toBe(false)
  })
})

/**
 * The same team, authored twice: by the planning agent (#298) and by the person in the Next
 * dialog. Both entry paths converge on these compilers, and exactly one fixture used to pin
 * them equal — steps only. A shape the two paths compile differently is invisible until the
 * host refuses one of them, so every shape below is checked at all three seams: the compiled
 * steps, the completion conditions derived from them, and the commit the host will accept.
 */
const consentedAt = '2026-09-15T18:00:00.000Z'
const consented = `${nextOutcomeTeamPlanLaunchInstruction('omni', consentedAt)}\n\n${work}.`
const terra = { agent: 'codex' as const, model: 'gpt-5.6-terra', effort: 'high' }
const astra = { agent: 'codex' as const, model: 'gpt-6-astra', effort: 'high' }
const opus = { agent: 'claude' as const, model: 'opus' }
const sonnet = { agent: 'claude' as const, model: 'sonnet' }
/** #291: an AI commit may not author a team's shape without the user's launch consent. */
const UNATTESTED = 'AI cannot add or rewrite steps outside its attested source task instructions.'

type PlanCase = {
  name: string
  finish: 'complete' | 'my-review'
  plan: NextOutcomeTeamPlan['outcomes'][number]['steps']
  dialog: NextStepOutcomeStep[]
  /** The exact sentence the AI guard answers with when the consent is missing. */
  unconsented: string
}

const implementer: NextStepOutcomeStep = {
  id: 'build',
  kind: 'handoff',
  actor: terra,
  presetId: 'implement',
  instructions: work
}

const PLANS: PlanCase[] = [
  {
    name: 'one implementer and a single report-only round',
    finish: 'complete',
    plan: [
      { kind: 'agent', id: 'build', ...terra, instruction: work },
      { kind: 'review', id: 'review', reviewers: [opus], maxRounds: 1, instruction: work }
    ],
    dialog: [
      implementer,
      {
        id: 'review',
        kind: 'review',
        reviewers: [opus],
        maxRounds: 1,
        instructions: work,
        adversarial: false
      }
    ],
    unconsented: UNATTESTED
  },
  {
    name: 'three rounds with no repair seat, repaired by the source',
    finish: 'complete',
    plan: [
      { kind: 'agent', id: 'build', ...terra, instruction: work },
      { kind: 'review', id: 'review', reviewers: [opus], maxRounds: 3, instruction: work }
    ],
    dialog: [
      implementer,
      {
        id: 'review',
        kind: 'review',
        reviewers: [opus],
        maxRounds: 3,
        instructions: work,
        adversarial: false,
        repairWithSource: true
      }
    ],
    unconsented: UNATTESTED
  },
  {
    name: 'three rounds with their own repair seat',
    finish: 'complete',
    plan: [
      { kind: 'agent', id: 'build', ...terra, instruction: work },
      { kind: 'review', id: 'review', reviewers: [opus], maxRounds: 3, instruction: work },
      { kind: 'agent', id: 'repair', ...terra, instruction: work }
    ],
    dialog: [
      implementer,
      {
        id: 'review',
        kind: 'review',
        reviewers: [opus],
        maxRounds: 3,
        instructions: work,
        adversarial: false
      },
      {
        id: 'repair',
        kind: 'handoff',
        actor: terra,
        presetId: 'improve',
        instructions: work,
        reviewRepair: true
      }
    ],
    unconsented: UNATTESTED
  },
  {
    name: 'a parallel implementer pair before an integrator',
    finish: 'complete',
    plan: [
      {
        kind: 'agent',
        id: 'api',
        ...terra,
        instruction: work,
        scope: 'src/api only',
        parallelGroup: 'build'
      },
      {
        kind: 'agent',
        id: 'ui',
        ...sonnet,
        instruction: work,
        scope: 'src/ui only',
        parallelGroup: 'build'
      },
      { kind: 'agent', id: 'integrate', ...terra, instruction: work }
    ],
    dialog: [
      {
        id: 'api',
        kind: 'handoff',
        actor: terra,
        presetId: 'implement',
        instructions: `${work}\n\nTeam scope: src/api only`,
        parallelGroup: 'build'
      },
      {
        id: 'ui',
        kind: 'handoff',
        actor: sonnet,
        presetId: 'implement',
        instructions: `${work}\n\nTeam scope: src/ui only`,
        parallelGroup: 'build'
      },
      { id: 'integrate', kind: 'handoff', actor: terra, presetId: 'implement', instructions: work }
    ],
    unconsented: UNATTESTED
  },
  {
    name: 'an adversarial round with two reviewers',
    finish: 'complete',
    plan: [
      { kind: 'agent', id: 'build', ...terra, instruction: work },
      {
        kind: 'review',
        id: 'review',
        reviewers: [astra, opus],
        maxRounds: 1,
        instruction: work,
        adversarial: true
      }
    ],
    dialog: [
      implementer,
      {
        id: 'review',
        kind: 'review',
        reviewers: [astra, opus],
        maxRounds: 1,
        instructions: work,
        adversarial: true
      }
    ],
    unconsented: UNATTESTED
  },
  {
    name: 'an outcome that finishes at my review',
    finish: 'my-review',
    plan: [{ kind: 'agent', id: 'build', ...terra, instruction: work }],
    dialog: [implementer],
    unconsented: UNATTESTED
  }
]

function dialogDraft(entry: PlanCase): NextStepOutcomeDraft {
  return { id: 'ship', finish: { kind: entry.finish }, instructions: '', steps: entry.dialog }
}

/** What the Next dialog compiles for the same team, authored by hand rather than derived. */
function authored(entry: PlanCase) {
  const draft: NextStepDraft = {
    end: 'me',
    placement: null,
    recipients: [],
    note: '',
    after: [],
    handoff: { task: null, deliverables: null, includeSummary: true },
    outcomes: [dialogDraft(entry)]
  }
  return compileNextStepChain({
    draft,
    ...context,
    defaultNote: 'note',
    now: 1,
    mintStepId: (position) => `dialog_${position}`,
    mintOperationId: () => 'operation'
  })
}

function planOf(entry: PlanCase) {
  return compileNextOutcomeTeamPlan({
    team: { outcomes: [{ outcomeId: 'ship', steps: entry.plan }] },
    outcomes: [{ ...outcome, finish: entry.finish }],
    ...context
  })
}

function chainOf(steps: SessionChainStep[]): SessionChain {
  return {
    id: context.chainId,
    workspacePath: context.workspacePath,
    worktreeId: 'repo::/work',
    hostId: 'local',
    sourcePaneKey: 'pane',
    sourceRowKey: 'row',
    auto: true,
    steps,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
}

function commitOf(entry: PlanCase, withConsent: boolean): SessionOutcomeCommit {
  return {
    source: 'ai',
    expectedRevision: 0,
    expectedSourcePrompt: consented,
    outcomes: planOf(entry).outcomes,
    ...(withConsent
      ? { teamPlanning: { source: 'agent-planned' as const, consentedAt, committedAt: 1 } }
      : {})
  }
}

describe.each(PLANS)('the planned and authored team agree on $name', (entry) => {
  it('compiles to exactly the chain steps the Next dialog authors', () => {
    const dialog = authored(entry)
    expect(dialog.problems).toEqual([])
    expect(planOf(entry).steps).toEqual(dialog.steps)
  })

  it('derives the same completion conditions from those steps', () => {
    const derived = compileNextStepOutcomes([dialogDraft(entry)], {
      ...context,
      fallbackActor: terra,
      steps: authored(entry).steps
    })
    const planned = planOf(entry)
    // The team's evidence is appended to the outcome the agent submitted; the dialog derives
    // exactly the same conditions from the same steps, so a compiler that starts pinning a
    // different writer or reviewer report shows up here rather than at execution time.
    expect(planned.outcomes[0]!.conditions).toEqual([
      ...outcome.conditions,
      ...derived[0]!.conditions
    ])
    expect(planned.outcomes[0]!.stepIds).toEqual(derived[0]!.stepIds)
  })

  it('is committable by its source agent under launch consent, and refused without it', () => {
    const { steps } = planOf(entry)
    const reconciled = reconcileSessionOutcomeSteps(
      chainOf(steps),
      undefined,
      commitOf(entry, true),
      consented
    )
    expect(reconciled.steps.map((step) => step.id)).toEqual(steps.map((step) => step.id))
    expect(() =>
      reconcileSessionOutcomeSteps(chainOf(steps), undefined, commitOf(entry, false), consented)
    ).toThrow(entry.unconsented)
  })
})

describe('the AI guard keeps its own sentence for each thing an unconsented commit adds', () => {
  /** An attestation that literally quotes every compiled prompt, so only the shape is left. */
  const quoting = (steps: SessionChainStep[]) =>
    [`${work}.`, ...steps.map((step) => (step.kind === 'handoff' ? '' : step.prompt))].join('\n\n')

  const refuse = (entry: PlanCase) => {
    const { steps } = planOf(entry)
    return () =>
      reconcileSessionOutcomeSteps(
        chainOf(steps),
        undefined,
        commitOf(entry, false),
        quoting(steps)
      )
  }

  it('refuses source-repair authority it was not given', () => {
    expect(refuse(PLANS[1]!)).toThrow(
      'AI cannot add original-builder repair authority or increase its review rounds.'
    )
  })

  it.each([PLANS[0]!, PLANS[3]!])('refuses the review rounds and groups in $name', (entry) => {
    expect(refuse(entry)).toThrow(
      'AI cannot add parallel groups or review rounds; they stay user-chosen under Next.'
    )
  })

  it('still admits a single quoted implementer step with no group, review or repair', () => {
    const entry = PLANS[5]!
    const { steps } = planOf(entry)
    expect(
      reconcileSessionOutcomeSteps(
        chainOf(steps),
        undefined,
        commitOf(entry, false),
        quoting(steps)
      ).steps
    ).toHaveLength(1)
  })
})
