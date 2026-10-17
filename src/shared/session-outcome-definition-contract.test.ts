import { describe, expect, it } from 'vitest'
import {
  SESSION_OUTCOME_MAX_SEATS,
  SESSION_OUTCOME_MAX_STAGES,
  normalizeSessionOutcomeSet,
  recordSessionOutcomeEvidence,
  reviseSessionOutcomeSet,
  sessionOutcomeSeatCount,
  sessionOutcomeStageCount,
  validateSessionOutcomeDefinitions
} from './session-outcome-state'
import {
  sessionOutcomeConditionKey,
  sessionOutcomeConditionSchema,
  type SessionOutcomeDefinition,
  type SessionOutcomeSet
} from './session-outcome-types'

const owner = {
  owner: 'execution-host',
  hostId: 'local',
  epoch: 'epoch',
  state: 'owned'
} as const
const conditions = [
  { id: 'report', kind: 'file', target: 'report.md' },
  { id: 'my_review', kind: 'review', target: 'The report', recipientId: 'emp_sal' }
] as const
const definition = (extra: Partial<SessionOutcomeDefinition> = {}): SessionOutcomeDefinition => ({
  id: 'report',
  title: 'The report',
  finish: 'my-review',
  dependsOn: [],
  actions: [],
  conditions: [...conditions],
  ...extra
})

/** A committed set with evidence for both conditions, as a finished first revision has. */
function committed(): SessionOutcomeSet {
  const base = reviseSessionOutcomeSet(
    undefined,
    { expectedRevision: 0, source: 'user', outcomes: [definition()] },
    owner,
    1
  )
  return conditions.reduce(
    (set, condition) =>
      recordSessionOutcomeEvidence(set, {
        id: `ev_${condition.id}`,
        outcomeId: 'report',
        conditionId: condition.id,
        outcomeRevision: 1,
        conditionKey: sessionOutcomeConditionKey(condition),
        kind: condition.kind,
        target: condition.target,
        receipt: 'receipt',
        verifiedAt: 2,
        verifier: 'execution-host'
      }),
    base
  )
}

const revise = (previous: SessionOutcomeSet, next: SessionOutcomeDefinition) =>
  reviseSessionOutcomeSet(
    previous,
    { expectedRevision: 1, source: 'user', outcomes: [next] },
    owner,
    3
  ).outcomes[0]!

describe('the outcome definition carries the output kind', () => {
  it('treats an output-kind edit exactly as any other definition change', () => {
    const previous = committed()
    expect(previous.outcomes[0]!.evidence).toHaveLength(2)
    const unchanged = revise(previous, definition())
    const renamed = revise(previous, definition({ title: 'The other report' }))
    const replanned = revise(previous, definition({ outputKind: 'plan' }))
    expect(unchanged).toMatchObject({ revision: 1 })
    expect(unchanged.evidence).toHaveLength(2)
    expect(replanned.revision).toBe(renamed.revision)
    expect(replanned.revision).toBe(2)
    expect(replanned.status).toBe(renamed.status)
    expect(replanned.evidence).toEqual(renamed.evidence)
    expect(replanned.evidence).toEqual([])
    expect(replanned.outputKind).toBe('plan')
  })

  it('carries the Done-when label through a revision and a save', () => {
    const previous = committed()
    const labelled = definition({
      conditions: conditions.map((condition) => ({
        ...condition,
        label: `Done when ${condition.target} is in`
      }))
    })
    const renamed = revise(previous, definition({ title: 'The other report' }))
    const relabelled = revise(previous, labelled)
    expect(relabelled.revision).toBe(renamed.revision)
    expect(relabelled.status).toBe(renamed.status)
    // A label can change the requirement while leaving its file path unchanged.
    expect(relabelled.evidence).toEqual(renamed.evidence)
    expect(relabelled.conditions[0]!.label).toBe('Done when report.md is in')
    const saved = reviseSessionOutcomeSet(
      previous,
      { expectedRevision: 1, source: 'user', outcomes: [labelled] },
      owner,
      3
    )
    const reloaded = normalizeSessionOutcomeSet(JSON.parse(JSON.stringify(saved)))
    expect(reloaded?.outcomes[0]!.conditions.map((condition) => condition.label)).toEqual([
      'Done when report.md is in',
      'Done when The report is in'
    ])
    expect(
      sessionOutcomeConditionSchema.safeParse({
        id: 'report',
        kind: 'file',
        target: 'report.md',
        label: 'x'.repeat(201)
      }).success
    ).toBe(false)
  })

  it('pins a file by version, by schema, or both, and refuses a pin that proves nothing', () => {
    const pin = (file: Record<string, unknown>) =>
      sessionOutcomeConditionSchema.safeParse({
        id: 'plan_file',
        kind: 'file',
        target: 'plan.json',
        fileVersions: [file]
      }).success
    expect(pin({ path: 'plan.json', schema: 'work-plan-v1' })).toBe(true)
    expect(pin({ path: 'plan.json', sha256: 'a'.repeat(64) })).toBe(true)
    expect(pin({ path: 'plan.json', sha256: 'a'.repeat(64), schema: 'work-plan-v1' })).toBe(true)
    expect(pin({ path: 'plan.json' })).toBe(false)
    expect(pin({ path: 'plan.json', schema: 'work-plan-v2' })).toBe(false)
  })
})

const step = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra })

describe('the stage and seat caps', () => {
  const outcome = (stepIds: string[]) => definition({ stepIds })

  it('counts one stage for seats that run together and one for each hand-off', () => {
    const steps = [
      step('a'),
      step('b1', { group: 'g1' }),
      step('b2', { group: 'g1' }),
      step('b3', { group: 'g1' }),
      step('c'),
      step('d', { kind: 'handoff' })
    ]
    const ids = steps.map((entry) => entry.id)
    expect(sessionOutcomeStageCount(outcome(ids), steps)).toBe(4)
    // The person hand-off is depth, not a seat.
    expect(sessionOutcomeSeatCount(outcome(ids), steps)).toBe(5)
  })

  it('counts a later review round as the same seat running again, not a new one', () => {
    const steps = [
      step('producer'),
      step('r1', { group: 'g1_round_1', review: { round: 1 } }),
      step('r2', { group: 'g1_round_1', review: { round: 1 } }),
      step('fix1', { reviewRepair: { afterRound: 1 } }),
      step('r3', { group: 'g1_round_2', review: { round: 2 } }),
      step('r4', { group: 'g1_round_2', review: { round: 2 } }),
      step('fix2', { reviewRepair: { afterRound: 2 } })
    ]
    const ids = steps.map((entry) => entry.id)
    expect(sessionOutcomeStageCount(outcome(ids), steps)).toBe(3)
    expect(sessionOutcomeSeatCount(outcome(ids), steps)).toBe(4)
  })

  it('refuses a plan over either cap, and refuses nothing when it cannot see the steps', () => {
    const deep = Array.from({ length: SESSION_OUTCOME_MAX_STAGES + 1 }, (_, index) =>
      step(`deep_${index}`)
    )
    const wide = Array.from({ length: SESSION_OUTCOME_MAX_SEATS + 1 }, (_, index) =>
      step(`wide_${index}`, { group: 'g1' })
    )
    const ids = (steps: { id: string }[]) => steps.map((entry) => entry.id)
    expect(() => validateSessionOutcomeDefinitions([outcome(ids(deep))], { steps: deep })).toThrow(
      `up to ${SESSION_OUTCOME_MAX_STAGES} stages`
    )
    expect(() => validateSessionOutcomeDefinitions([outcome(ids(wide))], { steps: wide })).toThrow(
      `up to ${SESSION_OUTCOME_MAX_SEATS} agents`
    )
    expect(() =>
      validateSessionOutcomeDefinitions([outcome(ids(deep).slice(0, SESSION_OUTCOME_MAX_STAGES))], {
        steps: deep
      })
    ).not.toThrow()
    // Why: without the steps a wide stage reads exactly like a deep plan, and reading a committed
    // plan back must never lose it.
    expect(() => validateSessionOutcomeDefinitions([outcome(ids(deep))])).not.toThrow()
    expect(() => validateSessionOutcomeDefinitions([outcome(ids(wide))])).not.toThrow()
  })
})
