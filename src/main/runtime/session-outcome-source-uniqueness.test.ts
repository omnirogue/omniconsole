import { describe, expect, it } from 'vitest'
import {
  assertUniqueSessionOutcomeSource,
  forkFinishedOutcomeSource,
  isFinishedOutcomeChain,
  restatesSealedOutcomeSource
} from './session-outcome-source-uniqueness'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCommit, SessionOutcomeSet } from '../../shared/session-outcome-types'
import { sealSessionRunCompletion } from '../../shared/session-run-completion'
import { SESSION_RUN_SEALED_ERROR } from '../../shared/session-run-sealed-revision'
import {
  blockRunOutcome,
  proveRun,
  runDefinition,
  runSet
} from '../../shared/session-run-lifecycle.test-fixture'

const bound = (id: string, overrides: Partial<SessionChain> = {}): SessionChain =>
  ({
    id,
    sourcePaneKey: 'pane',
    worktreeId: 'folder',
    placement: 'local',
    outcomeSet: { continuation: { principal: 'account-a' } },
    ...overrides
  }) as SessionChain

it('isolates different execution hosts and workspaces while allowing the existing chain revision', () => {
  const old = bound('owner')
  expect(() => assertUniqueSessionOutcomeSource([old], bound('owner'))).not.toThrow()
  expect(() =>
    assertUniqueSessionOutcomeSource([old], bound('second', { placement: 'runtime:other' }))
  ).not.toThrow()
  expect(() =>
    assertUniqueSessionOutcomeSource([old], bound('second', { worktreeId: 'other' }))
  ).not.toThrow()
  expect(() =>
    assertUniqueSessionOutcomeSource([old], bound('second', { sourcePaneKey: 'other' }))
  ).not.toThrow()
  expect(() =>
    assertUniqueSessionOutcomeSource(
      [old],
      bound('second', { placement: undefined, hostId: 'local' })
    )
  ).toThrow('already has a committed outcome set')
})

it('does not let another account clone the same physical source owner', () => {
  const next = bound('second')
  next.outcomeSet!.continuation.principal = 'account-b'
  expect(() => assertUniqueSessionOutcomeSource([bound('owner')], next)).toThrow(
    'already has a committed outcome set'
  )
})

it('does not exempt an existing unbound ID or a moved bound ID from new admission checks', () => {
  const owner = bound('owner')
  const unbound = bound('legacy', { outcomeSet: undefined, state: 'done' })
  expect(() => assertUniqueSessionOutcomeSource([owner, unbound], bound('legacy'))).toThrow(
    'already has a committed outcome set'
  )
  const moved = bound('existing', { sourcePaneKey: 'other' })
  expect(() => assertUniqueSessionOutcomeSource([owner, moved], bound('existing'))).toThrow(
    'already has a committed outcome set'
  )
})

describe('a sealed run and later commits', () => {
  const STALL = 'No activity was observed for 180s, so the agent was treated as stalled.'
  const step = (id: string) => ({
    id,
    agent: 'codex' as const,
    prompt: `Stage ${id}`,
    status: 'launched' as const
  })
  const definition = runDefinition('one', { stepIds: ['s1'] })
  const sealedSet = (): SessionOutcomeSet =>
    sealSessionRunCompletion(proveRun({ ...runSet([definition]), completedSteps: ['s1'] }, 'one'), {
      now: 50,
      operationId: 'op_seal'
    })
  const run = (outcomeSet: SessionOutcomeSet, extra: Partial<SessionChain> = {}): SessionChain => ({
    id: 'chn_1',
    workspacePath: '/w',
    worktreeId: 'folder:f1',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: 'row',
    auto: true,
    steps: [step('s1')],
    currentIndex: 1,
    state: 'done',
    outcomeSet,
    createdAt: 1,
    updatedAt: 2,
    ...extra
  })
  const commit = (extra: Partial<SessionOutcomeCommit>): SessionOutcomeCommit => ({
    source: 'user',
    expectedRevision: 1,
    outcomes: [definition],
    ...extra
  })

  it('stays finished when its host is lost or its record says otherwise', () => {
    const sealed = sealedSet()
    const drifted = run(
      {
        ...blockRunOutcome(sealed, 'one', STALL),
        continuation: { ...sealed.continuation, state: 'unverifiable' }
      },
      { state: 'waiting' }
    )
    expect(isFinishedOutcomeChain(drifted)).toBe(true)
  })

  it('forks a superseding plan and a reused outcome id instead of revising the sealed run', () => {
    const sealed = run(sealedSet())
    const changed = { ...definition, title: 'one, another way', stepIds: ['s1', 's2'] }
    const forked = forkFinishedOutcomeSource(
      [sealed],
      { ...sealed, planVersion: 2, steps: [step('s1'), { ...step('s2'), status: 'queued' }] },
      commit({
        outcomes: [changed],
        supersede: { reason: 'Another strategy' },
        drawsSteps: ['s1'],
        planVersion: 2
      })
    )
    expect(forked.base.id).toMatch(/^source_[a-f0-9]{40}$/)
    expect(forked.base).toMatchObject({ currentIndex: 0, state: 'waiting' })
    expect(forked.base.planVersion).toBeUndefined()
    // What the sealed run already ran stays with it; the new run carries only the new stage.
    expect(forked.base.steps.map((entry) => entry.id)).toEqual(['s2'])
    expect(forked.input).toMatchObject({
      expectedRevision: 0,
      outcomes: [{ id: 'one', title: 'one, another way', stepIds: ['s2'] }]
    })
    expect(forked.input.supersede).toBeUndefined()
    expect(forked.input.drawsSteps).toBeUndefined()
    expect(forked.input.planVersion).toBeUndefined()
  })

  it('still revises an unsealed finished (cancelled) chain in place for the same outcome id', () => {
    const cancelled = run(runSet([definition]), { state: 'cancelled' })
    const input = commit({ outcomes: [{ ...definition, title: 'one, edited' }] })
    expect(forkFinishedOutcomeSource([cancelled], cancelled, input)).toEqual({
      base: cancelled,
      input
    })
  })

  it('carries nothing that speaks about the sealed run into the new one', () => {
    const sealed = run(sealedSet())
    const forked = forkFinishedOutcomeSource(
      [sealed],
      sealed,
      commit({
        outcomes: [runDefinition('later')],
        removals: [{ outcomeId: 'one', reason: 'Replaced by later work' }]
      })
    )
    expect(forked.base.id).toMatch(/^source_[a-f0-9]{40}$/)
    expect(forked.base.steps).toEqual([])
    expect(forked.input.outcomes.map((outcome) => outcome.id)).toEqual(['later'])
    // A removal names an outcome of the SEALED run; the new run never had it.
    expect(forked.input.removals).toBeUndefined()
  })

  it('leaves proven work with the sealed run when a commit restates it beside new work', () => {
    const sealed = run(sealedSet())
    const withStage = {
      ...sealed,
      steps: [step('s1'), { ...step('s2'), status: 'queued' as const }]
    }
    const later = runDefinition('later', { dependsOn: ['one'], stepIds: ['s2'] })
    const forked = forkFinishedOutcomeSource(
      [sealed],
      withStage,
      commit({ outcomes: [definition, later] })
    )
    // Carried, `one` would be proven — and its stage run — a second time; what `later` needed of it
    // the sealed run already met.
    expect(forked.input.outcomes).toEqual([{ ...later, dependsOn: [] }])
    expect(forked.base.steps.map((entry) => entry.id)).toEqual(['s2'])

    // Alone, the restatement is the only owner the new stage has: new work under the same id.
    const alone = forkFinishedOutcomeSource([sealed], withStage, commit({}))
    expect(alone.input.outcomes.map((outcome) => outcome.id)).toEqual(['one'])
  })

  it.each([
    ['Done taken back', { clearSessionFinish: true as const, outcomes: [runDefinition('later')] }],
    ['the proven work restated with nothing added', {}],
    [
      'part of the proven work removed',
      { outcomes: [], removals: [{ outcomeId: 'one', reason: 'No longer wanted' }] }
    ]
  ])('refuses %s instead of forking: that edits the sealed run', (_name, extra) => {
    const sealed = run(sealedSet())
    expect(() => forkFinishedOutcomeSource([sealed], sealed, commit(extra))).toThrow(
      SESSION_RUN_SEALED_ERROR
    )
  })

  it('refuses a stale fork of a sealed run', () => {
    const sealed = run(sealedSet())
    expect(() =>
      forkFinishedOutcomeSource(
        [sealed],
        sealed,
        commit({ expectedRevision: 7, outcomes: [runDefinition('later')] })
      )
    ).toThrow('Outcome revision conflict')
  })

  it('reads a restatement of the proven work as a replay, whatever order its keys arrive in', () => {
    const sealed = run(sealedSet())
    const reordered = {
      actions: [],
      conditions: definition.conditions.map(({ id, ...rest }) => ({ ...rest, id })),
      stepIds: ['s1'],
      dependsOn: [],
      finish: definition.finish,
      title: definition.title,
      id: definition.id
    } as SessionOutcomeCommit['outcomes'][number]
    expect(restatesSealedOutcomeSource([sealed], sealed, commit({ outcomes: [reordered] }))).toBe(
      sealed
    )
    expect(
      restatesSealedOutcomeSource(
        [sealed],
        sealed,
        commit({ outcomes: [{ ...definition, title: 'one, another way' }] })
      )
    ).toBeNull()
    expect(
      restatesSealedOutcomeSource(
        [sealed],
        { ...sealed, steps: [step('s1'), step('s2')] },
        commit({})
      )
    ).toBeNull()
    expect(restatesSealedOutcomeSource([run(runSet([definition]))], sealed, commit({}))).toBeNull()
  })

  it('refuses a replay of the proven work read before the revision the sealed run holds', () => {
    const sealed = run(sealedSet())
    // The first commit sent again by a reconnecting client: a stale view, never a second run.
    expect(() =>
      restatesSealedOutcomeSource([sealed], sealed, commit({ expectedRevision: 0 }))
    ).toThrow('Outcome revision conflict')
    expect(restatesSealedOutcomeSource([sealed], sealed, commit({}))).toBe(sealed)
  })

  it.each([
    ['another finish', { sessionFinish: { action: 'end' } }],
    ['a withdrawn finish', { clearSessionFinish: true }],
    ['a new plan version', { supersede: { reason: 'Another strategy' } }]
  ] as const)('refuses the same work under %s: that would edit the seal', (_name, extra) => {
    const sealed = run(sealedSet())
    expect(() => restatesSealedOutcomeSource([sealed], sealed, commit(extra))).toThrow(
      SESSION_RUN_SEALED_ERROR
    )
  })
})
