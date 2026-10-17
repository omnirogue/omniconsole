import { describe, expect, it } from 'vitest'
import { openHumanAttention } from './session-human-attention'
import { reconcileSessionOutcomeSet, reviseSessionOutcomeSet } from './session-outcome-state'
import { sealSessionRunCompletion } from './session-run-completion'
import { readSessionRun } from './session-run-lifecycle'
import { SESSION_RUN_SEALED_ERROR } from './session-run-sealed-revision'
import { sessionOutcomeIdentity } from './session-outcome-identity'
import {
  sessionOutcomeActionKey,
  sessionOutcomeConditionKey,
  type SessionOutcomeAttempt,
  type SessionOutcomeDefinition,
  type SessionOutcomeEvidence,
  type SessionOutcomeSet
} from './session-outcome-types'

const owner = { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' } as const
const conditions = [
  { id: 'report', kind: 'file', target: 'report.md' },
  { id: 'my_review', kind: 'review', target: 'The report', recipientId: 'emp_sal' }
] as const

const action = (stepId: string, instruction: string) => ({
  id: `step_${stepId}`,
  instruction,
  conditionIds: ['report'],
  authority: 'existing-user-authority' as const,
  agent: 'claude' as const
})

const definition = (extra: Partial<SessionOutcomeDefinition> = {}): SessionOutcomeDefinition => ({
  id: 'report',
  title: 'The report',
  finish: 'my-review',
  dependsOn: [],
  stepIds: ['s1', 's2'],
  actions: [action('s1', 'write it'), action('s2', 'check it')],
  conditions: [...conditions],
  ...extra
})

const receipt = (conditionId: 'report' | 'my_review'): SessionOutcomeEvidence => {
  const condition = conditions.find((entry) => entry.id === conditionId)!
  return {
    id: `ev_${conditionId}`,
    outcomeId: 'report',
    conditionId,
    outcomeRevision: 1,
    conditionKey: sessionOutcomeConditionKey(condition),
    kind: condition.kind,
    target: condition.target,
    receipt: 'receipt',
    verifiedAt: 2,
    verifier: 'execution-host'
  }
}

const attempt = (
  stepId: string,
  state: SessionOutcomeAttempt['state'],
  extra: Partial<SessionOutcomeAttempt> = {}
): SessionOutcomeAttempt => ({
  id: `att_${stepId}`,
  outcomeId: 'report',
  actionId: `step_${stepId}`,
  actionKey: sessionOutcomeActionKey(action(stepId, stepId === 's1' ? 'write it' : 'check it')),
  outcomeRevision: 1,
  state,
  startedAt: 1,
  updatedAt: 1,
  ...extra
})

/** A committed outcome with both receipts in hand, as a first revision that ran has. */
function committed(overrides: Partial<SessionOutcomeSet> = {}): SessionOutcomeSet {
  const base = reviseSessionOutcomeSet(
    undefined,
    { expectedRevision: 0, source: 'user', outcomes: [definition()] },
    owner,
    1
  )
  return {
    ...base,
    outcomes: [{ ...base.outcomes[0]!, evidence: [receipt('report'), receipt('my_review')] }],
    ...overrides
  }
}

const revise = (
  previous: SessionOutcomeSet,
  next: SessionOutcomeDefinition,
  extra: Partial<Parameters<typeof reviseSessionOutcomeSet>[1]> = {}
) =>
  reviseSessionOutcomeSet(
    previous,
    { expectedRevision: previous.revision, source: 'user', outcomes: [next], ...extra },
    owner,
    3
  )

describe('filing an outcome under a card', () => {
  const taskRef = { taskId: 'btk_abcd1234', attachedAt: 7, attachedBy: 'emp_sal' }

  it('bumps no revision, spends no receipt and changes no status', () => {
    const previous = committed()
    const filed = revise(previous, definition(), { taskRef }).outcomes[0]!
    expect(filed.taskRef).toEqual(taskRef)
    expect(filed.revision).toBe(1)
    expect(filed.status).toBe(previous.outcomes[0]!.status)
    expect(filed.evidence).toEqual(previous.outcomes[0]!.evidence)
    // The definition is what a revision compares; the filing must not be part of it.
    expect(sessionOutcomeIdentity(filed)).toEqual(sessionOutcomeIdentity(previous.outcomes[0]!))
    expect('taskRef' in sessionOutcomeIdentity(filed)).toBe(false)
  })

  it('never writes the card into the continuation, which is how work is executed', () => {
    const set = revise(committed(), definition(), { taskRef })
    expect('taskRef' in set.continuation).toBe(false)
    expect(JSON.stringify(set.continuation)).not.toContain(taskRef.taskId)
    expect(set.continuation).toEqual(owner)
  })

  it('lets many outcomes name one card, and keeps the filing across later revisions', () => {
    const second = definition({ id: 'summary', title: 'The summary' })
    const many = reviseSessionOutcomeSet(
      undefined,
      {
        expectedRevision: 0,
        source: 'user',
        outcomes: [definition(), second],
        taskRef
      },
      owner,
      1
    )
    expect(many.outcomes.map((outcome) => outcome.taskRef?.taskId)).toEqual([
      'btk_abcd1234',
      'btk_abcd1234'
    ])
    const later = reviseSessionOutcomeSet(
      many,
      { expectedRevision: many.revision, source: 'user', outcomes: [definition(), second] },
      owner,
      3
    )
    expect(later.outcomes[0]!.taskRef).toEqual(taskRef)
  })

  it('refuses a card that disagrees with the card this work is executing', () => {
    expect(() =>
      reviseSessionOutcomeSet(
        committed(),
        {
          expectedRevision: 1,
          source: 'user',
          outcomes: [definition()],
          taskRef: { taskId: 'btk_other1234', attachedAt: 7 }
        },
        { ...owner, taskId: 'btk_abcd1234' },
        3
      )
    ).toThrow('already executing a different card')
    expect(() =>
      reviseSessionOutcomeSet(
        committed(),
        { expectedRevision: 1, source: 'user', outcomes: [definition()], taskRef },
        { ...owner, taskId: 'btk_abcd1234' },
        3
      )
    ).not.toThrow()
  })
})

describe('a new plan for the same outcome', () => {
  const replanned = definition({
    stepIds: ['s1', 's2', 's3'],
    actions: [action('s1', 'write it'), action('s2', 'check it'), action('s3', 'polish it')]
  })

  it('keeps the revision and every receipt when only the plan changed', () => {
    const previous = committed()
    const outcome = revise(previous, replanned).outcomes[0]!
    expect(outcome.revision).toBe(1)
    expect(outcome.status).toBe(previous.outcomes[0]!.status)
    // Why both: the review receipt is the one a revision spends, and neither is re-stamped.
    expect(outcome.evidence).toEqual(previous.outcomes[0]!.evidence)
    expect(outcome.evidence.map((entry) => entry.outcomeRevision)).toEqual([1, 1])
  })

  it('requires fresh evidence when the outcome itself changed', () => {
    const outcome = revise(committed(), replanned as SessionOutcomeDefinition).outcomes[0]!
    expect(outcome.revision).toBe(1)
    const renamed = revise(committed(), definition({ title: 'The other report' })).outcomes[0]!
    expect(renamed.revision).toBe(2)
    expect(renamed.evidence).toEqual([])
    expect(renamed.status).toBe('pending')
    const rekinded = revise(committed(), definition({ outputKind: 'plan' })).outcomes[0]!
    expect(rekinded.revision).toBe(2)
  })

  it('may be planned around running work, never through it', () => {
    const running = committed({ attempts: [attempt('s2', 'running')] })
    expect(() =>
      revise(running, definition({ stepIds: ['s1'], actions: [action('s1', 'write it')] }))
    ).toThrow('in-flight or unverifiable action')
    expect(() =>
      revise(
        running,
        definition({ actions: [action('s1', 'write it'), action('s2', 'check it differently')] })
      )
    ).toThrow('in-flight or unverifiable action')
    // Adding a seat beside the running one is exactly what re-planning is for.
    expect(() => revise(running, replanned)).not.toThrow()
    expect(() => revise(running, definition({ title: 'The other report' }))).toThrow(
      'in-flight or unverifiable action'
    )
  })
})

describe('who receives the work is not what the work is', () => {
  it('lists exactly the fields an outcome is identified by', () => {
    // The definition is id, title, finish, instructions?, outputKind?, dependsOn, stepIds?,
    // conditions, actions. Identity is that minus the plan (stepIds, actions) and minus the
    // strategy (finish).
    expect(
      Object.keys(
        sessionOutcomeIdentity(definition({ instructions: 'Ship it', outputKind: 'plan' }))
      )
    ).toEqual(['id', 'title', 'instructions', 'outputKind', 'dependsOn', 'conditions'])
    // An absent optional stays absent; identity is not a shape with holes in it.
    expect(Object.keys(sessionOutcomeIdentity(definition()))).toEqual([
      'id',
      'title',
      'dependsOn',
      'conditions'
    ])
    expect(sessionOutcomeIdentity(definition({ finish: 'complete' }))).toEqual(
      sessionOutcomeIdentity(definition({ finish: 'my-review' }))
    )
  })

  it('keeps the revision and every receipt when only the finish changed', () => {
    const previous = committed()
    // The review condition stays in the Done When list, so `complete` is a legal finish for it:
    // the same work, proven the same way, handed back to a different reader.
    const outcome = revise(previous, definition({ finish: 'complete' })).outcomes[0]!
    expect(outcome.finish).toBe('complete')
    expect(outcome.revision).toBe(1)
    expect(outcome.status).toBe(previous.outcomes[0]!.status)
    expect(outcome.evidence).toEqual(previous.outcomes[0]!.evidence)
    expect(outcome.evidence.map((entry) => entry.outcomeRevision)).toEqual([1, 1])
  })

  it('still bumps when the finish takes a Done When condition with it', () => {
    // Removing the human read: the review condition leaves the contract, so the outcome changed.
    const dropped = revise(
      committed(),
      definition({ finish: 'complete', conditions: [conditions[0]] })
    ).outcomes[0]!
    expect(dropped.revision).toBe(2)
    expect(dropped.evidence).toEqual([])
    // Adding one: the same move in reverse, from a contract that never had a human in it.
    const solo = definition({ finish: 'complete', conditions: [conditions[0]] })
    const before = reviseSessionOutcomeSet(
      undefined,
      { expectedRevision: 0, source: 'user', outcomes: [solo] },
      owner,
      1
    )
    const added = reviseSessionOutcomeSet(
      before,
      { expectedRevision: 1, source: 'user', outcomes: [definition()] },
      owner,
      3
    ).outcomes[0]!
    expect(added.finish).toBe('my-review')
    expect(added.revision).toBe(2)
  })
})

describe('superseding the plan', () => {
  const previous = () =>
    committed({
      completedSteps: ['s1'],
      attempts: [attempt('s1', 'completed'), attempt('s2', 'blocked', { error: 'quota wall' })],
      outcomes: [
        {
          ...committed().outcomes[0]!,
          status: 'blocked' as const,
          blockedReason: 'The reviewer never answered.'
        }
      ]
    })
  const next = definition({
    stepIds: ['s1', 's2', 's3'],
    actions: [action('s1', 'write it'), action('s2', 'check it'), action('s3', 'finish it')]
  })

  it('retires what the old plan never finished, and keeps what it did', () => {
    const set = revise(previous(), next, { supersede: { reason: 'The review route was wrong.' } })
    expect(set.completedSteps).toEqual(['s1', 's2'])
    expect(set.attempts.map((entry) => entry.state)).toEqual(['completed', 'superseded'])
    // A retired attempt is not a failure to report, and it is never erased.
    expect(set.attempts[1]).toMatchObject({ id: 'att_s2', actionId: 'step_s2' })
    expect(set.attempts[1]!.error).toBeUndefined()
  })

  it('unblocks the outcome without touching its identity or its receipts', () => {
    const outcome = revise(previous(), next, { supersede: { reason: 'wrong route' } }).outcomes[0]!
    expect(outcome.status).toBe('pending')
    expect(outcome.blockedReason).toBeUndefined()
    expect(outcome.revision).toBe(1)
    expect(outcome.evidence).toEqual(previous().outcomes[0]!.evidence)
  })

  it('retires nothing when the commit does not say it supersedes', () => {
    const set = revise(previous(), next)
    expect(set.completedSteps).toEqual(['s1'])
    expect(set.attempts.map((entry) => entry.state)).toEqual(['completed', 'blocked'])
    expect(set.outcomes[0]!.blockedReason).toBe('The reviewer never answered.')
  })
})

describe('what rides along on an ordinary revision', () => {
  const waiting = { class: 'waiting', code: 'person-review', since: 2, wake: 'Sal' } as const
  const held = () => {
    const base = committed()
    const opened = openHumanAttention(
      {
        ...base,
        outcomes: [
          {
            ...base.outcomes[0]!,
            status: 'blocked' as const,
            blockedReason: 'Waiting for the review reply.',
            block: waiting
          }
        ]
      },
      {
        kind: 'review',
        scope: { outcomeId: 'report', outcomeRevision: 1, conditionId: 'my_review' },
        ask: 'Review "The report" and reply with your decision.',
        why: 'The plan continues only with the reply of the person it was sent to.',
        recipient: { type: 'person', employeeId: 'emp_sal' },
        source: { type: 'review-condition', ref: 'emp_sal:my_review' }
      },
      2
    )
    return opened.set
  }
  const replanned = definition({
    stepIds: ['s1', 's2', 's3'],
    actions: [action('s1', 'write it'), action('s2', 'check it'), action('s3', 'polish it')]
  })

  it('carries the requests, and the class of a block it carries', () => {
    const previous = held()
    const next = revise(previous, replanned)
    expect(next.attention).toEqual(previous.attention)
    expect(next.outcomes[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'Waiting for the review reply.',
      block: waiting
    })
    // So a re-plan does not turn a run that is waiting on a person into an unclassified failure.
    expect(readSessionRun(next, { now: 3 }).phase).toBe('waiting')
  })

  it('drops the block with the reason when the plan is superseded or the outcome changed', () => {
    const superseded = revise(held(), replanned, { supersede: { reason: 'wrong route' } })
    expect(superseded.outcomes[0]!.status).toBe('pending')
    expect(superseded.outcomes[0]!.block).toBeUndefined()
    // The requests still ride along; the host's next pass withdraws what the new plan made stale.
    expect(superseded.attention).toHaveLength(1)
    const renamed = revise(held(), definition({ title: 'The other report' })).outcomes[0]!
    expect(renamed.status).toBe('pending')
    expect(renamed.block).toBeUndefined()
    expect(renamed.blockedReason).toBeUndefined()
  })
})

describe('a sealed run', () => {
  const taskRef = { taskId: 'btk_abcd1234', attachedAt: 7, attachedBy: 'emp_sal' }
  const sealed = (): SessionOutcomeSet =>
    sealSessionRunCompletion(
      reconcileSessionOutcomeSet(
        committed({
          sessionFinish: { action: 'save', folderId: 'folder_1' },
          completedSteps: ['s1', 's2'],
          attempts: [attempt('s1', 'completed'), attempt('s2', 'completed')]
        })
      ),
      { now: 5, operationId: 'op_seal' }
    )

  it('is proven before it is sealed', () => {
    const set = sealed()
    expect(set.outcomes[0]!.status).toBe('satisfied')
    expect(set.completion).toMatchObject({ at: 5, outcomes: [{ id: 'report', revision: 1 }] })
    expect(set.disposition).toMatchObject({ intent: 'save', folderId: 'folder_1' })
  })

  it.each([
    ['renames the outcome', { outcomes: [definition({ title: 'The other report' })] }],
    ['re-plans it', { outcomes: [definition({ stepIds: ['s1', 's2', 's3'] })] }],
    ['changes who receives it', { outcomes: [definition({ finish: 'complete' })] }],
    ['adds an outcome', { outcomes: [definition(), definition({ id: 'summary' })] }],
    [
      'removes an outcome',
      {
        outcomes: [definition({ id: 'summary' })],
        removals: [{ outcomeId: 'report', reason: 'Changed scope' }]
      }
    ],
    ['supersedes the plan', { supersede: { reason: 'wrong route' } }],
    ['takes Done back', { clearSessionFinish: true as const }],
    ['changes how the session finishes', { sessionFinish: { action: 'end' as const } }]
  ])('refuses a commit that %s: new work forks a new run', (_what, extra) => {
    const set = sealed()
    const snapshot = structuredClone(set)
    expect(() => revise(set, definition(), extra)).toThrow(SESSION_RUN_SEALED_ERROR)
    expect(set).toEqual(snapshot)
  })

  it('reports a stale revision as the conflict it is, before anything about the seal', () => {
    expect(() =>
      reviseSessionOutcomeSet(
        sealed(),
        { expectedRevision: 9, source: 'user', outcomes: [definition({ title: 'Other' })] },
        owner,
        9
      )
    ).toThrow('revision conflict')
  })

  it('still accepts being filed under a card, and keeps everything that proved it', () => {
    const set = sealed()
    const filed = revise(set, definition(), { taskRef })
    expect(filed.revision).toBe(set.revision + 1)
    expect(filed.updatedAt).toBe(3)
    expect(filed.outcomes[0]).toEqual({ ...set.outcomes[0]!, taskRef })
    const { revision: _revision, updatedAt: _updatedAt, outcomes: _outcomes, ...rest } = filed
    const { revision: _r, updatedAt: _u, outcomes: _o, ...before } = set
    expect(rest).toEqual(before)
    expect(filed.completion).toEqual(set.completion)
    expect(filed.disposition).toEqual(set.disposition)
    expect(readSessionRun(filed, { now: 9 }).phase).toBe('completed')
    // The host's commit path strips the card and files it afterwards: the same commit without one.
    const unchanged = revise(set, definition(), {
      sessionFinish: { action: 'save', folderId: 'folder_1' }
    })
    expect(unchanged.completion).toEqual(set.completion)
    expect(unchanged.outcomes).toEqual(set.outcomes)
  })

  it('compares what the commit says, not how its keys were ordered', () => {
    const reordered = {
      actions: [
        {
          agent: 'claude',
          authority: 'existing-user-authority',
          conditionIds: ['report'],
          instruction: 'write it',
          id: 'step_s1'
        },
        {
          agent: 'claude',
          authority: 'existing-user-authority',
          conditionIds: ['report'],
          instruction: 'check it',
          id: 'step_s2'
        }
      ],
      conditions: [
        { target: 'report.md', kind: 'file', id: 'report' },
        { recipientId: 'emp_sal', target: 'The report', kind: 'review', id: 'my_review' }
      ],
      stepIds: ['s1', 's2'],
      dependsOn: [],
      finish: 'my-review',
      title: 'The report',
      id: 'report'
    } as SessionOutcomeDefinition
    expect(() => revise(sealed(), reordered, { taskRef })).not.toThrow()
  })

  it('refuses a card that disagrees with the card the work executed', () => {
    expect(() =>
      reviseSessionOutcomeSet(
        sealed(),
        {
          expectedRevision: 1,
          source: 'user',
          outcomes: [definition()],
          taskRef: { taskId: 'btk_other1234', attachedAt: 7 }
        },
        { ...owner, taskId: 'btk_abcd1234' },
        3
      )
    ).toThrow('already executing a different card')
  })

  it('leaves the fork free: a commit with no previous set starts an unsealed run', () => {
    const forked = reviseSessionOutcomeSet(
      undefined,
      { expectedRevision: 0, source: 'user', outcomes: [definition({ id: 'summary' })] },
      owner,
      9
    )
    expect(forked.completion).toBeUndefined()
    expect(forked.disposition).toBeUndefined()
    expect(forked.attention).toBeUndefined()
    expect(forked.outcomes[0]).toMatchObject({ id: 'summary', revision: 1, status: 'pending' })
  })
})
