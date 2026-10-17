/**
 * One table of outcome shapes × every point that enforces the outcome runtime's contracts.
 *
 * Why this file exists: "a repeated review must name its repairer" is enforced in SEVEN places
 * with FOUR different sentences — the draft validator, the dialog compiler, the host's
 * repairWithSource materialization, the host executor guard, the canonical compiler, the
 * review-round decision and the AI revision guard — and only three of them were pinned. A point
 * that quietly stops agreeing with its siblings is the defect class that cost seven landing
 * passes: each one still passed its own author's tests. Every row below runs ONE shape through
 * EVERY point that can take it and asserts accept-or-refuse plus the exact refusal text.
 *
 * Where two points legitimately disagree today the row says so in a KNOWN DISAGREEMENT comment
 * rather than hiding it. This file pins the behaviour that exists; it decides no policy.
 */
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ launch: vi.fn() }))
// #283 refuses an oversized brief before a step launches; the real export shells out, so the
// executor seam is stubbed exactly as its neighbouring launch tests stub it.
vi.mock('./session-outcome-executor', () => ({
  launchSessionOutcomeAction: mocks.launch,
  sessionOutcomeExecutionBrief: () => 'brief'
}))
// The real candidate version shells out to git; these rows are about admission, not candidates.
vi.mock('./session-outcome-candidate', () => ({
  sessionOutcomeCandidatePaths: () => [],
  sessionOutcomeCandidateVersion: async () => 'candidate-1'
}))

import { advanceSessionOutcomeSteps } from './session-outcome-steps'
import { materializeSessionOutcomeSourceRepairs } from './session-outcome-source-repairs'
import { reconcileSessionOutcomeSteps } from './session-outcome-revision'
import { compileSessionOutcomeWorkflow } from './session-outcome-workflow-compile'
import { compileNextStepChain } from '../../shared/next-step-compile'
import { compileNextStepOutcomes } from '../../shared/next-outcome-definition-compile'
import {
  compileNextOutcomeTeamPlan,
  nextOutcomeTeamDrafts
} from '../../shared/next-outcome-team-plan-compile'
import { nextOutcomeTeamPlanLaunchInstruction } from '../../shared/next-outcome-team-plan-instructions'
import {
  nextStepOutcomeProblems,
  nextStepReviewRoundsProblem,
  type NextStepActor,
  type NextStepDraft,
  type NextStepOutcomeDraft,
  type NextStepOutcomeFinish,
  type NextStepOutcomeStep
} from '../../shared/next-step-draft'
import { SESSION_REVIEW_RESULT_MARKER } from '../../shared/session-chain-review'
import { transitionSessionReviewRound } from '../../shared/session-chain-review-transition'
import type {
  NextOutcomeTeamActor,
  NextOutcomeTeamStep
} from '../../shared/next-outcome-team-plan-schema'
import type {
  SessionChain,
  SessionChainAgentStep,
  SessionChainStep
} from '../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeCommit,
  SessionOutcomeDefinition
} from '../../shared/session-outcome-types'

const WORK = 'Ship the billing export with tests'
const OUTCOME_ID = 'ship'
const CHAIN_ID = 'chain'
const WORKSPACE = '/work'
const LABEL = 'Ship billing export'
const CONSENTED_AT = '2026-09-15T18:00:00.000Z'
const AUTHORITY = `${nextOutcomeTeamPlanLaunchInstruction('omni', CONSENTED_AT)}\n\n${WORK}.`

type Actor = NextStepActor & NextOutcomeTeamActor
/** The producer, and the only repair seat the canonical compiler can preserve beside it. */
const PRODUCER: Actor = { agent: 'codex', model: 'gpt-5.6-terra', effort: 'high' }
const ASTRA: Actor = { agent: 'codex', model: 'gpt-6-astra', effort: 'high' }
const OPUS: Actor = { agent: 'claude', model: 'opus' }
const SONNET: Actor = { agent: 'claude', model: 'sonnet' }

const build = (
  id: string,
  actor: Actor = PRODUCER,
  extra: { parallelGroup?: string } = {}
): NextStepOutcomeStep => ({
  id,
  kind: 'handoff',
  actor,
  presetId: 'implement',
  instructions: WORK,
  ...extra
})
const repairSeat = (id: string, actor: Actor = PRODUCER): NextStepOutcomeStep => ({
  id,
  kind: 'handoff',
  actor,
  presetId: 'improve',
  instructions: WORK,
  reviewRepair: true
})
const review = (
  id: string,
  reviewers: Actor[],
  maxRounds: number,
  extra: { repairWithSource?: boolean; adversarial?: boolean } = {}
): NextStepOutcomeStep => ({
  id,
  kind: 'review',
  reviewers,
  maxRounds,
  instructions: WORK,
  adversarial: extra.adversarial === true,
  ...(extra.repairWithSource ? { repairWithSource: true } : {})
})
const teamBuild = (
  id: string,
  actor: Actor = PRODUCER,
  extra: { parallelGroup?: string } = {}
): NextOutcomeTeamStep => ({ kind: 'agent', id, ...actor, instruction: WORK, ...extra })
const teamReview = (
  id: string,
  reviewers: Actor[],
  maxRounds: number,
  adversarial = false
): NextOutcomeTeamStep => ({
  kind: 'review',
  id,
  reviewers,
  maxRounds,
  instruction: WORK,
  ...(adversarial ? { adversarial: true } : {})
})

type Shape = {
  name: string
  finish: NextStepOutcomeFinish
  steps: NextStepOutcomeStep[]
  /** The same shape as an agent-planned team; every shape here is expressible as one. */
  team: NextOutcomeTeamStep[]
  /** nextStepOutcomeProblems (src/shared/next-step-draft.ts). */
  draftProblems: string[]
  /** compileNextStepChain: compiled step count and the review rounds it emits. */
  compiled: { steps: number; rounds: number[] }
  /** compileNextStepOutcomes: the condition kinds the finish is verified by. */
  conditionKinds: string[]
  /** compileNextOutcomeTeamPlan: null accepts, a string is the exact refusal. */
  teamRefusal: string | null
  /** advanceSessionOutcomeSteps at the first review round, or at the first step. */
  executor: { blocked: string | null; launched: number }
  /** compileSessionOutcomeWorkflow: a stage count accepts, a string is the exact refusal. */
  canonical: number | string
  /** transitionSessionReviewRound on round 1 with blocking findings. */
  roundOne: 'finish' | 'launch-repair' | 'block' | null
}

const EXECUTOR_REFUSAL =
  'Repeated review rounds require their authorized repair owner before execution.'
const CANONICAL_REPAIR_REFUSAL =
  'Choose an authorized repair step before requesting multiple review rounds.'
const ROUNDS_REFUSAL = 'Choose between one and five review rounds.'

const SHAPES: Shape[] = [
  {
    name: 'one report-only round',
    finish: { kind: 'complete' },
    steps: [build('build'), review('review', [ASTRA], 1)],
    team: [teamBuild('build'), teamReview('review', [ASTRA], 1)],
    draftProblems: [],
    compiled: { steps: 2, rounds: [1] },
    conditionKinds: ['file', 'report'],
    teamRefusal: null,
    executor: { blocked: null, launched: 1 },
    canonical: 1,
    roundOne: 'finish'
  },
  {
    name: 'two rounds with a repair seat on the producer model',
    finish: { kind: 'complete' },
    steps: [build('build'), review('review', [ASTRA], 2), repairSeat('repair')],
    team: [teamBuild('build'), teamReview('review', [ASTRA], 2), teamBuild('repair')],
    draftProblems: [],
    compiled: { steps: 4, rounds: [1, 2] },
    conditionKinds: ['file', 'report'],
    teamRefusal: null,
    executor: { blocked: null, launched: 1 },
    canonical: 1,
    roundOne: 'launch-repair'
  },
  {
    name: 'two rounds with a repair seat on another model',
    finish: { kind: 'complete' },
    steps: [build('build'), review('review', [ASTRA], 2), repairSeat('repair', SONNET)],
    team: [teamBuild('build'), teamReview('review', [ASTRA], 2), teamBuild('repair', SONNET)],
    draftProblems: [],
    compiled: { steps: 4, rounds: [1, 2] },
    conditionKinds: ['file', 'report'],
    teamRefusal: null,
    // KNOWN DISAGREEMENT: the dialog and the agent-planned team both allow a repair seat on a
    // different model than the producer; the canonical compiler cannot represent that pair and
    // refuses it (session-outcome-workflow-compile.ts:111-115). Encoded, not silently allowed.
    executor: { blocked: null, launched: 1 },
    canonical:
      'This task workflow cannot preserve a different producer and repair model or effort. Use a separate review after the producer completes.',
    roundOne: 'launch-repair'
  },
  {
    name: 'two rounds repaired by the original source',
    finish: { kind: 'complete' },
    steps: [build('build'), review('review', [ASTRA], 2, { repairWithSource: true })],
    team: [teamBuild('build'), teamReview('review', [ASTRA], 2)],
    draftProblems: [],
    compiled: { steps: 3, rounds: [1, 2] },
    conditionKinds: ['file', 'report'],
    teamRefusal: null,
    // KNOWN DISAGREEMENT: a repairWithSource chain is admitted by the validator, the dialog
    // compiler and the team compiler, and refused by the host executor and the canonical
    // compiler until materializeSessionOutcomeSourceRepairs binds the producer as repairer.
    // The pair is pinned below in "materializing the source repairs".
    executor: { blocked: EXECUTOR_REFUSAL, launched: 0 },
    canonical: CANONICAL_REPAIR_REFUSAL,
    roundOne: 'finish'
  },
  {
    name: 'five rounds repaired by the original source',
    finish: { kind: 'complete' },
    steps: [build('build'), review('review', [ASTRA], 5, { repairWithSource: true })],
    team: [teamBuild('build'), teamReview('review', [ASTRA], 5)],
    draftProblems: [],
    compiled: { steps: 6, rounds: [1, 2, 3, 4, 5] },
    conditionKinds: ['file', 'report'],
    teamRefusal: null,
    executor: { blocked: EXECUTOR_REFUSAL, launched: 0 },
    canonical: CANONICAL_REPAIR_REFUSAL,
    roundOne: 'finish'
  },
  {
    name: 'six rounds is over the five-round limit',
    finish: { kind: 'complete' },
    steps: [build('build'), review('review', [ASTRA], 6, { repairWithSource: true })],
    team: [teamBuild('build'), teamReview('review', [ASTRA], 6)],
    draftProblems: [ROUNDS_REFUSAL],
    // KNOWN DISAGREEMENT: the validator refuses six rounds, the dialog compiler still emits all
    // six (it only re-runs the repair/rounds pair, never the round cap), and the host executor,
    // the canonical compiler and the materialization each refuse it with their own sentence.
    compiled: { steps: 7, rounds: [1, 2, 3, 4, 5, 6] },
    conditionKinds: ['file', 'report'],
    teamRefusal: ROUNDS_REFUSAL,
    executor: { blocked: EXECUTOR_REFUSAL, launched: 0 },
    canonical: 'Canonical reviews support up to five reviewers and five rounds.',
    roundOne: 'finish'
  },
  {
    name: 'a parallel implementer pair before an integrator',
    finish: { kind: 'complete' },
    steps: [
      build('api', PRODUCER, { parallelGroup: 'build' }),
      build('ui', SONNET, { parallelGroup: 'build' }),
      build('integrate')
    ],
    team: [
      teamBuild('api', PRODUCER, { parallelGroup: 'build' }),
      teamBuild('ui', SONNET, { parallelGroup: 'build' }),
      teamBuild('integrate')
    ],
    draftProblems: [],
    compiled: { steps: 3, rounds: [] },
    conditionKinds: ['file'],
    teamRefusal: null,
    // WP-4a: the host executor launches the whole cohort of the first incomplete step, so an
    // authored group now runs side by side here exactly as the canonical graph draws it.
    // Pinned by name below.
    executor: { blocked: null, launched: 2 },
    canonical: 3,
    roundOne: null
  },
  {
    name: 'a parallel pair placed after a review',
    finish: { kind: 'complete' },
    steps: [
      build('build'),
      review('review', [ASTRA], 1),
      build('api', PRODUCER, { parallelGroup: 'after' }),
      build('ui', SONNET, { parallelGroup: 'after' })
    ],
    team: [
      teamBuild('build'),
      teamReview('review', [ASTRA], 1),
      teamBuild('api', PRODUCER, { parallelGroup: 'after' }),
      teamBuild('ui', SONNET, { parallelGroup: 'after' })
    ],
    draftProblems: [],
    compiled: { steps: 4, rounds: [1] },
    // A later writer makes the earlier group's reports stale, so only the final writer's
    // manifest is the condition (next-outcome-definition-compile.ts:69-71).
    conditionKinds: ['file'],
    // KNOWN DISAGREEMENT: the dialog allows a group after a review; an agent-planned team may
    // not, because the seat after a review is that review's repair agent.
    teamRefusal: 'The agent step after a review is its repair agent and cannot start a parallel group.',
    executor: { blocked: null, launched: 1 },
    canonical: 3,
    roundOne: 'finish'
  },
  {
    name: 'an adversarial round with two reviewers',
    finish: { kind: 'complete' },
    steps: [build('build'), review('review', [ASTRA, OPUS], 1, { adversarial: true })],
    team: [teamBuild('build'), teamReview('review', [ASTRA, OPUS], 1, true)],
    draftProblems: [],
    compiled: { steps: 3, rounds: [1, 1] },
    conditionKinds: ['file', 'report', 'report'],
    teamRefusal: null,
    executor: { blocked: null, launched: 2 },
    canonical: 1,
    roundOne: 'finish'
  },
  {
    name: 'a review with no producer before it',
    finish: { kind: 'complete' },
    steps: [review('review', [ASTRA], 1)],
    team: [teamReview('review', [ASTRA], 1)],
    draftProblems: [],
    compiled: { steps: 1, rounds: [1] },
    conditionKinds: ['report'],
    teamRefusal: null,
    executor: { blocked: null, launched: 1 },
    // KNOWN DISAGREEMENT: the dialog and the team compiler both author a review-first outcome;
    // the canonical compiler requires the producer stage ahead of its reviewers.
    canonical: 'A canonical review group requires its producer before its reviewers.',
    roundOne: 'finish'
  },
  {
    name: 'one implementer finishing at my review',
    finish: { kind: 'my-review' },
    steps: [build('build')],
    team: [teamBuild('build')],
    draftProblems: [],
    compiled: { steps: 1, rounds: [] },
    conditionKinds: ['review'],
    teamRefusal: null,
    executor: { blocked: null, launched: 1 },
    canonical: 1,
    roundOne: null
  }
]

function draftOutcome(shape: Shape): NextStepOutcomeDraft {
  return { id: OUTCOME_ID, finish: shape.finish, instructions: '', steps: shape.steps }
}

function compileShape(shape: Shape): ReturnType<typeof compileNextStepChain> {
  const draft: NextStepDraft = {
    end: 'done',
    placement: null,
    recipients: [],
    note: '',
    after: [],
    handoff: { task: null, deliverables: null, includeSummary: false },
    outcomes: [draftOutcome(shape)]
  }
  return compileNextStepChain({
    draft,
    chainId: CHAIN_ID,
    workspacePath: WORKSPACE,
    sessionLabel: LABEL,
    defaultNote: LABEL,
    now: 0,
    mintStepId: (position) => `dialog_step_${position}`,
    mintOperationId: () => 'dialog_operation'
  })
}

function defineShape(shape: Shape, steps: readonly SessionChainStep[]): SessionOutcomeDefinition[] {
  return compileNextStepOutcomes([draftOutcome(shape)], {
    chainId: CHAIN_ID,
    workspacePath: WORKSPACE,
    sessionLabel: LABEL,
    fallbackActor: PRODUCER,
    steps
  })
}

function seedOutcome(finish: SessionOutcomeDefinition['finish']): SessionOutcomeDefinition {
  return {
    id: OUTCOME_ID,
    title: LABEL,
    finish,
    dependsOn: [],
    conditions: [{ id: 'seed', kind: 'file', target: '/work/out.md' }],
    actions: []
  }
}

function chainFor(
  steps: SessionChainStep[],
  definitions: SessionOutcomeDefinition[],
  completedSteps: string[] = []
): SessionChain {
  return {
    id: CHAIN_ID,
    workspacePath: WORKSPACE,
    worktreeId: 'tree',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'source',
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
      completedSteps,
      continuation: { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
      outcomes: definitions.map(
        (definition): SessionOutcome => ({
          ...definition,
          stepIds: steps.map((step) => step.id),
          revision: 1,
          status: 'pending',
          evidence: []
        })
      )
    }
  }
}

function agentSteps(steps: readonly SessionChainStep[]): SessionChainAgentStep[] {
  return steps.filter((step): step is SessionChainAgentStep => step.kind !== 'handoff')
}

/** Advance the chain at its first review round, or at its first step when it has none. */
async function advanceAt(chain: SessionChain, budget = 2) {
  mocks.launch.mockReset()
  mocks.launch.mockResolvedValue({})
  let current = chain
  const access = {
    runtime: {} as never,
    read: () => current,
    save: (updated: SessionChain) => {
      current = updated
    },
    persistAttempt: () => {}
  }
  const advance = await advanceSessionOutcomeSteps(access, current.outcomeSet!.outcomes[0]!, budget)
  return {
    blocked: current.outcomeSet!.outcomes[0]!.blockedReason ?? null,
    launched: advance.launched
  }
}

function atFirstReview(steps: SessionChainStep[], definitions: SessionOutcomeDefinition[]) {
  const at = steps.findIndex((step) => step.kind !== 'handoff' && step.review)
  return chainFor(
    steps,
    definitions,
    steps.slice(0, Math.max(at, 0)).map((step) => step.id)
  )
}

const verdictLine = (status: 'pass' | 'findings') =>
  `${SESSION_REVIEW_RESULT_MARKER}${JSON.stringify({
    status,
    blockingFindings: status === 'findings' ? ['The export drops the tax column.'] : []
  })}`

/** Judge one round exactly as finishReviewRound does: repair authority read from the chain. */
function judgeRound(
  steps: readonly SessionChainStep[],
  round: number,
  status: 'pass' | 'findings' | 'crashed'
) {
  const agents = agentSteps(steps)
  const groupId = agents.find((step) => step.review)?.review?.groupId
  if (!groupId) {
    return null
  }
  const reviewers = agents.filter(
    (step) => step.review?.groupId === groupId && step.review.round === round
  )
  return transitionSessionReviewRound({
    assignment: reviewers[0]!.review!,
    reviewers: reviewers.map((step) => ({
      stepId: step.id,
      reviewerId: step.review!.reviewerId,
      output: status === 'crashed' ? '' : verdictLine(status),
      ...(status === 'crashed' ? { crashed: true } : {})
    })),
    hasAuthorizedRepair: agents.some(
      (step) => step.reviewRepair?.groupId === groupId && step.reviewRepair.afterRound === round
    ),
    reviewOnly: !agents.some((step) => step.reviewRepair?.groupId === groupId),
    now: 1
  })
}

function commit(
  definitions: SessionOutcomeDefinition[],
  overrides: Partial<SessionOutcomeCommit>
): SessionOutcomeCommit {
  return { source: 'user', expectedRevision: 0, outcomes: definitions, ...overrides }
}

describe('the draft validator takes every shape', () => {
  it.each(SHAPES)('$name', (shape) => {
    expect(nextStepOutcomeProblems([draftOutcome(shape)])).toEqual(shape.draftProblems)
  })

  it.each(SHAPES)('$name: no round needs a repairer the shape does not name', (shape) => {
    const problems = shape.steps.map((step, index) =>
      nextStepReviewRoundsProblem(step, shape.steps[index + 1])
    )
    expect(problems.filter(Boolean)).toEqual([])
  })
})

describe('the dialog compiler takes every shape', () => {
  it.each(SHAPES)('$name', (shape) => {
    const compiled = compileShape(shape)
    expect(compiled.problems).toEqual([])
    expect(compiled.steps).toHaveLength(shape.compiled.steps)
    expect(
      agentSteps(compiled.steps).flatMap((step) => (step.review ? [step.review.round] : []))
    ).toEqual(shape.compiled.rounds)
    expect(
      defineShape(shape, compiled.steps)[0]!.conditions.map((condition) => condition.kind)
    ).toEqual(shape.conditionKinds)
  })
})

describe('the agent-planned team compiler takes the same shape', () => {
  it.each(SHAPES)('$name', (shape) => {
    const compile = () =>
      compileNextOutcomeTeamPlan({
        team: { outcomes: [{ outcomeId: OUTCOME_ID, steps: shape.team }] },
        outcomes: [seedOutcome(shape.finish.kind === 'my-review' ? 'my-review' : 'complete')],
        chainId: CHAIN_ID,
        workspacePath: WORKSPACE,
        sessionLabel: LABEL
      })
    if (shape.teamRefusal) {
      expect(compile).toThrow(shape.teamRefusal)
      return
    }
    // #298: the planned team and the Next dialog converge on the same compiled steps.
    expect(compile().steps).toEqual(compileShape(shape).steps)
  })
})

describe('the AI revision guard takes every shape', () => {
  it.each(SHAPES)('$name: a user commit keeps every compiled step', (shape) => {
    const steps = compileShape(shape).steps
    const definitions = defineShape(shape, steps)
    const reconciled = reconcileSessionOutcomeSteps(
      chainFor(steps, definitions),
      undefined,
      commit(definitions, { source: 'user' }),
      AUTHORITY
    )
    expect(reconciled.steps.map((step) => step.id)).toEqual(steps.map((step) => step.id))
  })

  it.each(SHAPES)('$name: launch consent lets the source agent commit it', (shape) => {
    const steps = compileShape(shape).steps
    const definitions = defineShape(shape, steps)
    // #291 refused a consented team exactly here. The bypass is re-checked per step against the
    // attested prompt, so every shape a consented team can author must pass — including the two
    // that motivated it: a review repaired by its source, and a parallel group.
    const reconciled = reconcileSessionOutcomeSteps(
      chainFor(steps, definitions),
      undefined,
      commit(definitions, {
        source: 'ai',
        expectedSourcePrompt: AUTHORITY,
        teamPlanning: { source: 'agent-planned', consentedAt: CONSENTED_AT, committedAt: 1 }
      }),
      AUTHORITY
    )
    expect(reconciled.steps.map((step) => step.id)).toEqual(steps.map((step) => step.id))
  })
})

describe('the host executor guard takes every shape', () => {
  it.each(SHAPES)('$name', async (shape) => {
    const steps = compileShape(shape).steps
    const advanced = await advanceAt(atFirstReview(steps, defineShape(shape, steps)))
    expect(advanced).toEqual(shape.executor)
  })
})

describe('the canonical compiler takes every shape', () => {
  it.each(SHAPES)('$name', (shape) => {
    const steps = compileShape(shape).steps
    const compile = () => compileSessionOutcomeWorkflow(chainFor(steps, defineShape(shape, steps)))
    if (typeof shape.canonical === 'string') {
      expect(compile).toThrow(shape.canonical)
      return
    }
    expect(compile().stages).toHaveLength(shape.canonical)
  })
})

describe('the review-round decision takes every shape', () => {
  it.each(SHAPES)('$name: blocking findings in round one', (shape) => {
    const steps = compileShape(shape).steps
    expect(judgeRound(steps, 1, 'findings')?.next ?? null).toBe(shape.roundOne)
  })

  it.each(SHAPES.filter((shape) => shape.roundOne))('$name: a passing round finishes', (shape) => {
    const steps = compileShape(shape).steps
    expect(judgeRound(steps, 1, 'pass')?.next).toBe('finish')
  })
})

describe('materializing the source repairs', () => {
  const sourceShapes = SHAPES.filter((shape) => shape.executor.blocked === EXECUTOR_REFUSAL)

  it.each(sourceShapes.filter((shape) => shape.compiled.rounds.length <= 5))(
    '$name: binding the producer as repairer admits the shape everywhere',
    async (shape) => {
      const steps = compileShape(shape).steps
      const bound = materializeSessionOutcomeSourceRepairs(
        atFirstReview(steps, defineShape(shape, steps))
      )
      const rounds = shape.compiled.rounds.length
      expect(agentSteps(bound.steps).filter((step) => step.reviewRepair)).toHaveLength(rounds - 1)
      // The host executor, the canonical compiler and the round decision all change their answer
      // together once the repairer exists; a point that keeps refusing has drifted.
      expect(await advanceAt(bound)).toEqual({ blocked: null, launched: 1 })
      expect(compileSessionOutcomeWorkflow(bound).stages).toHaveLength(1)
      expect(judgeRound(bound.steps, 1, 'findings')?.next).toBe('launch-repair')
    }
  )

  it('refuses to bind a source repairer past the five-round limit', () => {
    const shape = SHAPES.find((entry) => entry.compiled.rounds.length === 6)!
    const steps = compileShape(shape).steps
    expect(() =>
      materializeSessionOutcomeSourceRepairs(atFirstReview(steps, defineShape(shape, steps)))
    ).toThrow('Repeated reviews must stay within the five-round limit.')
  })

  it('refuses to bind a repairer it cannot authenticate', () => {
    const shape = SHAPES.find((entry) => entry.name.startsWith('two rounds repaired'))!
    const steps = compileShape(shape).steps.slice(1)
    expect(() =>
      materializeSessionOutcomeSourceRepairs(chainFor(steps, defineShape(shape, steps)))
    ).toThrow('The original source agent could not be verified.')
  })
})

describe('the missing repairer keeps its four separate sentences', () => {
  const unrepaired: Shape = {
    ...SHAPES[0]!,
    name: 'two report-only rounds with no repairer at all',
    steps: [build('build'), review('review', [ASTRA], 2)]
  }

  it('refuses in the draft validator and the dialog compiler', () => {
    expect(nextStepOutcomeProblems([draftOutcome(unrepaired)])).toEqual([
      'Choose one report-only round, or enable repairs for additional rounds.'
    ])
    expect(compileShape(unrepaired)).toEqual({
      steps: [],
      problems: [{ kind: 'invalid-review-repair', key: 'review' }]
    })
  })

  it('cannot be authored by an agent-planned team at all', () => {
    // The team draft names a repairer for every repeated review: the seat after it, or the
    // producer. Losing that mapping would hand the shape above to the host.
    const drafts = nextOutcomeTeamDrafts(
      { outcomes: [{ outcomeId: OUTCOME_ID, steps: [teamBuild('build'), teamReview('r', [ASTRA], 2)] }] },
      [seedOutcome('complete')]
    )
    expect(drafts[0]!.steps[1]).toMatchObject({ kind: 'review', repairWithSource: true })
    expect(nextStepOutcomeProblems(drafts)).toEqual([])
  })

  it('refuses at the host executor, the canonical compiler and the round cap', async () => {
    const shape = SHAPES.find((entry) => entry.name.startsWith('two rounds with a repair seat on the producer'))!
    const steps = compileShape(shape).steps
    const definitions = defineShape(shape, steps)
    const withoutRepairer = steps.filter((step) => step.kind === 'handoff' || !step.reviewRepair)
    expect(await advanceAt(atFirstReview(withoutRepairer, definitions))).toEqual({
      blocked: EXECUTOR_REFUSAL,
      launched: 0
    })
    expect(() =>
      compileSessionOutcomeWorkflow(chainFor(withoutRepairer, definitions))
    ).toThrow(CANONICAL_REPAIR_REFUSAL)
    // The final round has no repairer by construction; findings there are terminal.
    expect(judgeRound(steps, 2, 'findings')).toMatchObject({
      next: 'block',
      reason: 'Review findings have no authorized repair owner or remain at the round cap.'
    })
    expect(judgeRound(steps, 1, 'crashed')).toMatchObject({
      next: 'block',
      reason: 'A selected reviewer did not return a valid verdict.'
    })
  })
})

describe('what the host executor does with a parallel implementer group', () => {
  // Was: "documents current behaviour: it launches the group one member at a time" (#339). WP-4a
  // made the host agree with the canonical graph — the group is a cohort and starts together — so
  // this row now pins the new behaviour, including the budget that holds the third seat back.
  it('launches the whole group together, within the budget', async () => {
    const shape = SHAPES.find((entry) => entry.name.startsWith('a parallel implementer pair'))!
    const steps = compileShape(shape).steps
    const definitions = defineShape(shape, steps)
    expect(await advanceAt(chainFor(steps, definitions), 3)).toEqual({ blocked: null, launched: 2 })
    // The integrator is NOT in the group, so the barrier still holds it until both seats finish.
    expect(await advanceAt(chainFor(steps, definitions), 1)).toEqual({ blocked: null, launched: 1 })
    const { stages } = compileSessionOutcomeWorkflow(chainFor(steps, definitions))
    expect(stages.slice(0, 2).map((stage) => stage.parallel_group)).toEqual([
      'parallel_ship_build',
      'parallel_ship_build'
    ])
    expect(stages[2]!.after).toEqual([stages[0]!.key, stages[1]!.key])
  })
})
