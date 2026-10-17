import { afterEach, expect, it, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { attachOutcomeToTask, type OutcomeTaskAttachmentAccess } from './session-outcome-task-ref'
import { sessionOutcomeChainConcurrency } from './session-outcome-concurrency'
import { launchSessionOutcomeAction } from './session-outcome-executor'
import {
  sessionOutcomeDefinition,
  type SessionOutcomeAttempt
} from '../../shared/session-outcome-types'
import type { SessionChain } from '../../shared/session-chain-types'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.dispose()
  }
})

function fixture() {
  const f = outcomeRuntimeFixture(() => ({ body: 'Worked' }))
  fixtures.push(f)
  f.service.dispose()
  vi.spyOn(f.service, 'start').mockImplementation(() => {})
  const chain: SessionChain = {
    id: 'chain',
    workspacePath: f.workspace,
    worktreeId: 'folder:outcome',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'row',
    auto: true,
    steps: [
      { id: 'v1', agent: 'codex', prompt: 'Write a result.', status: 'queued', planVersion: 1 }
    ],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
  const definition = {
    id: 'outcome',
    title: 'Write result',
    finish: 'complete' as const,
    dependsOn: [],
    actions: [],
    stepIds: ['v1'],
    conditions: [{ id: 'file', kind: 'file' as const, target: `${f.workspace}/result.txt` }]
  }
  const access: OutcomeTaskAttachmentAccess = {
    source: 'user',
    cardAccess: { baseUrl: 'https://hub.invalid', bearer: 'test' },
    loadChain: (id) => f.runtime.listSessionChains().find((entry) => entry.id === id),
    persistence: f.runtime,
    poster: {
      now: () => 20,
      attachSessionToTask: vi.fn(async () => ({ attached: true })),
      postNote: vi.fn(async () => ({ ok: true as const, data: { id: 'note-1' } })),
      postEvidence: vi.fn(async () => ({ ok: true as const, data: {} }))
    }
  }
  return {
    ...f,
    chain,
    definition,
    access,
    commit: () =>
      f.service.commit(chain, { source: 'user', expectedRevision: 0, outcomes: [definition] })
  }
}

it('(m)/(l) filing preserves execution records, personal run origin and concurrency', async () => {
  const f = fixture()
  const before = await f.commit()
  const limit = sessionOutcomeChainConcurrency(f.runtime, before)
  const after = await attachOutcomeToTask(f.access, before.id, 'outcome', 'btk_card1234')
  expect(after.outcomeSet!.outcomes[0]!.taskRef).toMatchObject({
    taskId: 'btk_card1234',
    postedNoteId: 'note-1'
  })
  const withoutFiling = (chain: SessionChain) => {
    const copy = structuredClone(chain)
    delete copy.outcomeSet!.outcomes[0]!.taskRef
    copy.updatedAt = 0
    return copy
  }
  expect(withoutFiling(after)).toEqual(withoutFiling(before))
  expect(sessionOutcomeChainConcurrency(f.runtime, after)).toBe(limit)
  expect(after.outcomeSet!.continuation.taskId).toBeUndefined()
  for (const chain of [before, after]) {
    const attempt = await launchSessionOutcomeAction(
      f.runtime,
      chain,
      'outcome',
      {
        id: 'write',
        instruction: 'Write the result.',
        agent: 'codex',
        conditionIds: ['file'],
        authority: 'existing-user-authority'
      },
      () => {}
    )
    expect(attempt.runId).toBeTruthy()
    expect(f.db.getRun(attempt.runId!)?.origin).toBe('personal')
  }
  expect(f.access.poster.postNote).toHaveBeenCalledTimes(1)
  await attachOutcomeToTask(f.access, before.id, 'outcome', 'btk_card1234')
  expect(f.access.poster.postNote).toHaveBeenCalledTimes(1)
})

it('(m)/(u) returns hub refusal and rolls back only taskRef', async () => {
  const f = fixture()
  const before = await f.commit()
  vi.mocked(f.access.poster.attachSessionToTask).mockResolvedValue({
    attached: false,
    errorMessage: 'Card is closed'
  })
  await expect(attachOutcomeToTask(f.access, before.id, 'outcome', 'btk_card1234')).rejects.toThrow(
    'Card is closed'
  )
  const after = f.service.get(before.id)
  expect(after.outcomeSet).toEqual(before.outcomeSet)
  expect(after.steps).toEqual(before.steps)
  expect(f.access.poster.postNote).not.toHaveBeenCalled()
})

it('(m) refuses AI filing, invalid card ids and conflicting admitted execution', async () => {
  const f = fixture()
  const saved = await f.commit()
  await expect(
    attachOutcomeToTask({ ...f.access, source: 'ai' }, saved.id, 'outcome', 'btk_card1234')
  ).rejects.toThrow('source user')
  await expect(attachOutcomeToTask(f.access, saved.id, 'outcome', 'task_worker')).rejects.toThrow(
    'board card'
  )
  saved.outcomeSet!.continuation.taskId = 'btk_other1234'
  f.runtime.replaceSessionChainOutcomesAndFlush(saved, 1)
  await expect(attachOutcomeToTask(f.access, saved.id, 'outcome', 'btk_card1234')).rejects.toThrow(
    'different card'
  )
})

it('(n)/Q supersede retains v1 steps and attempts and keeps Outcome identity', async () => {
  const f = fixture()
  let before = await f.commit()
  before.steps.push({
    id: 'failed',
    agent: 'codex',
    prompt: 'A failed seat.',
    status: 'failed',
    planVersion: 1
  })
  before.outcomeSet!.outcomes[0]!.stepIds!.push('failed')
  before.outcomeSet!.attempts.push({
    id: 'attempt',
    outcomeId: 'outcome',
    outcomeRevision: 1,
    actionId: 'step_v1',
    actionKey: 'key',
    state: 'prepared',
    planVersion: 1,
    startedAt: 1,
    updatedAt: 1
  })
  before = f.runtime.replaceSessionChainOutcomesAndFlush(before, 1)
  const after = await f.service.commit(
    {
      ...before,
      planVersion: 2,
      steps: [{ id: 'v2', agent: 'codex', prompt: 'Try another strategy.', status: 'queued' }]
    },
    {
      source: 'user',
      expectedRevision: 1,
      planVersion: 2,
      supersede: { reason: 'Try another strategy' },
      outcomes: [{ ...f.definition, stepIds: ['v2'] }]
    }
  )
  expect(after.planVersion).toBe(2)
  expect(after.planVersions).toMatchObject([
    { version: 1 },
    { version: 2, supersedes: 1, reason: 'Try another strategy' }
  ])
  expect(after.steps).toMatchObject([
    { id: 'v1', status: 'skipped', supersededBy: 2, planVersion: 1 },
    before.steps[1],
    { id: 'v2', planVersion: 2 }
  ])
  expect(after.outcomeSet!.outcomes[0]).toMatchObject({
    revision: 1,
    stepIds: ['v1', 'failed', 'v2']
  })
  expect(after.outcomeSet!.attempts[0]).toMatchObject({ state: 'superseded', planVersion: 1 })
  expect(after.outcomeSet!.completedSteps).toEqual(['v1', 'failed'])
  expect(f.service.get(after.id).steps[0]).toMatchObject({ supersededBy: 2 })
})

it.each(['launching', 'running', 'unverifiable'] as const)(
  '(n) refuses to supersede a %s attempt without altering history',
  async (state) => {
    const f = fixture()
    const before = await f.commit()
    before.outcomeSet!.attempts.push({
      id: 'attempt',
      outcomeId: 'outcome',
      outcomeRevision: 1,
      actionId: 'step_v1',
      actionKey: 'key',
      state,
      startedAt: 1,
      updatedAt: 1
    } satisfies SessionOutcomeAttempt)
    const saved = f.runtime.replaceSessionChainOutcomesAndFlush(before, 1)
    await expect(
      f.service.commit(
        {
          ...before,
          planVersion: 2,
          steps: [{ id: 'v2', agent: 'codex', prompt: 'New strategy.', status: 'queued' }]
        },
        {
          source: 'user',
          expectedRevision: 1,
          supersede: { reason: 'New strategy' },
          outcomes: [{ ...f.definition, stepIds: ['v2'] }]
        }
      )
    ).rejects.toThrow('before superseding')
    expect(f.service.get(before.id)).toEqual(saved)
  }
)

it('(p)/O refuses executable verification and task filing from every non-user source', async () => {
  const f = fixture()
  for (const source of ['ai', 'proposer', 'library'] as const) {
    for (const extra of [{ taskRef: { taskId: 'btk_card1234', attachedAt: 1 } }, {}]) {
      const definition = extra.taskRef
        ? f.definition
        : {
            ...f.definition,
            conditions: [
              {
                id: 'file',
                kind: 'command' as const,
                target: 'test',
                verification: { program: 'node', args: ['--version'] }
              }
            ]
          }
      await expect(
        f.service.commit(f.chain, {
          source: source as 'ai',
          expectedRevision: 0,
          outcomes: [definition],
          ...extra
        })
      ).rejects.toThrow('source user')
    }
  }
  expect(f.runtime.listSessionChains()).toEqual([])
})

it('(p) refuses AI manufacture when the attested prompt requests no pursuit', async () => {
  const f = fixture()
  const prompt = 'What does this function do?'
  await expect(
    f.service.commit(
      f.chain,
      { source: 'ai', expectedRevision: 0, expectedSourcePrompt: prompt, outcomes: [f.definition] },
      prompt
    )
  ).rejects.toThrow(/no pursuit was requested/i)
  expect(f.runtime.listSessionChains()).toEqual([])
})

it('(n) ordinary edits retain omitted failed steps as addressable history', async () => {
  const f = fixture()
  const saved = await f.commit()
  saved.steps[0]!.status = 'failed'
  f.runtime.replaceSessionChainOutcomesAndFlush(saved, 1)
  const after = await f.service.commit(
    { ...saved, steps: [] },
    {
      source: 'user',
      expectedRevision: 1,
      outcomes: [{ ...sessionOutcomeDefinition(saved.outcomeSet!.outcomes[0]!), stepIds: [] }]
    }
  )
  expect(after.steps).toEqual(saved.steps)
  expect(after.outcomeSet!.outcomes[0]!.stepIds).toEqual(['v1'])
})

it('(o) a user commit targeting a finished chain starts a fresh lineage for a new Outcome', async () => {
  const f = fixture()
  const first = await f.commit()
  const history = f.runtime.replaceSessionChainOutcomesAndFlush({ ...first, state: 'cancelled' }, 1)
  const next = await f.service.commit(
    {
      ...first,
      steps: [{ id: 'new-step', agent: 'codex', prompt: 'A later pursuit.', status: 'queued' }]
    },
    {
      source: 'user',
      expectedRevision: 1,
      outcomes: [{ ...f.definition, id: 'later', stepIds: ['new-step'] }]
    }
  )
  expect(next.id).toMatch(/^source_[a-f0-9]{40}$/)
  expect(f.service.get(first.id)).toEqual(history)
  expect(next.outcomeSet!.revision).toBe(1)
  expect(f.runtime.listSessionChains()).toHaveLength(2)
})

it('(n) each valid six-stage plan stays admissible with retained history', async () => {
  const f = fixture()
  const steps = Array.from({ length: 6 }, (_, i) => ({
    id: `old_${i}`,
    agent: 'codex' as const,
    prompt: `Stage ${i}`,
    status: 'queued' as const
  }))
  const first = await f.service.commit(
    { ...f.chain, steps },
    {
      source: 'user',
      expectedRevision: 0,
      outcomes: [{ ...f.definition, stepIds: steps.map((step) => step.id) }]
    }
  )
  const newSteps = steps.map((step, i) => ({ ...step, id: `new_${i}` }))
  const next = await f.service.commit(
    { ...first, planVersion: 2, steps: newSteps },
    {
      source: 'user',
      expectedRevision: 1,
      supersede: { reason: 'Six new stages' },
      outcomes: [{ ...f.definition, stepIds: newSteps.map((step) => step.id) }]
    }
  )
  expect(next.steps).toHaveLength(12)
  expect(next.outcomeSet!.outcomes[0]!.revision).toBe(1)
  expect(next.outcomeSet!.outcomes[0]!.stepIds).toHaveLength(12)
})

it('P: attaches a finished standalone outcome and posts its final report and evidence exactly once', async () => {
  const f = fixture()
  const initial = await f.commit()
  initial.currentIndex = initial.steps.length
  initial.outcomeSet!.completedSteps = ['v1']
  initial.steps[0]!.status = 'launched'
  f.runtime.replaceSessionChainOutcomesAndFlush(initial, 1)
  f.write('result.txt', 'Verified final result')
  const finished = await f.service.verify(initial.id, 1, 'outcome', 'file')
  expect(finished.state).toBe('done')
  const attached = await attachOutcomeToTask(f.access, finished.id, 'outcome', 'btk_card1234')
  expect(attached.state).toBe('done')
  const { taskRef: _ref, ...outcome } = attached.outcomeSet!.outcomes[0]!
  expect(outcome).toEqual(finished.outcomeSet!.outcomes[0])
  expect(attached.outcomeSet!.attempts).toEqual(finished.outcomeSet!.attempts)
  expect(attached.outcomeSet!.continuation).toEqual(finished.outcomeSet!.continuation)
  expect(f.access.poster.postNote).toHaveBeenCalledWith(
    f.access.cardAccess,
    'btk_card1234',
    expect.objectContaining({ note_kind: 'final_report' })
  )
  expect(f.access.poster.postEvidence).toHaveBeenCalledWith(
    f.access.cardAccess,
    'btk_card1234',
    expect.objectContaining({
      kind: 'doc',
      ref: finished.outcomeSet!.outcomes[0]!.evidence[0]!.receipt
    })
  )
  await attachOutcomeToTask(f.access, finished.id, 'outcome', 'btk_card1234')
  expect(f.access.poster.postNote).toHaveBeenCalledTimes(1)
  expect(f.access.poster.postEvidence).toHaveBeenCalledTimes(1)
})

it.todo(
  'Q: v2 advances after superseding an unfinished attempt once WP-4a retires it in tick/observer'
)

it('(u) preserves an accepted note receipt when a later evidence post is refused', async () => {
  const f = fixture()
  const initial = await f.commit()
  initial.currentIndex = initial.steps.length
  initial.outcomeSet!.completedSteps = ['v1']
  f.runtime.replaceSessionChainOutcomesAndFlush(initial, 1)
  f.write('result.txt', 'Verified result')
  await f.service.verify(initial.id, 1, 'outcome', 'file')
  vi.mocked(f.access.poster.postEvidence).mockResolvedValue({
    ok: false,
    reason: 'HTTP 409: evidence belongs to another card'
  })
  await expect(
    attachOutcomeToTask(f.access, initial.id, 'outcome', 'btk_card1234')
  ).rejects.toThrow('HTTP 409')
  expect(f.service.get(initial.id).outcomeSet!.outcomes[0]!.taskRef).toMatchObject({
    postedNoteId: 'note-1',
    taskId: 'btk_card1234'
  })
  await attachOutcomeToTask(f.access, initial.id, 'outcome', 'btk_card1234')
  expect(f.access.poster.postNote).toHaveBeenCalledTimes(1)
})

/**
 * Queueing MORE work is not a new strategy. A commit that only adds steps carries no
 * supersede, so the step the old plan had not run yet keeps its status and its place — and
 * the same commit is admissible while that step is in flight, because nothing is re-planned
 * through it (frozen model, rule 7: work in flight can only be followed by more).
 */
it('(n) an append commit keeps v1 pending work and adds behind it', async () => {
  const f = fixture()
  const before = await f.commit()
  const after = await f.service.commit(
    {
      ...before,
      steps: [
        ...before.steps,
        { id: 'v2', agent: 'codex', prompt: 'And then this.', status: 'queued', planVersion: 1 }
      ]
    },
    {
      source: 'user',
      expectedRevision: 1,
      outcomes: [{ ...f.definition, stepIds: ['v1', 'v2'] }]
    }
  )
  expect(after.planVersion ?? 1).toBe(1)
  expect(after.steps).toMatchObject([
    { id: 'v1', status: 'queued', planVersion: 1 },
    { id: 'v2', status: 'queued', planVersion: 1 }
  ])
  expect(after.steps.some((step) => step.kind !== 'handoff' && step.supersededBy)).toBe(false)
  expect(after.outcomeSet!.completedSteps ?? []).toEqual([])
})

it.each(['launching', 'running'] as const)(
  '(n) an append commit is admitted while a %s attempt holds the step it queues behind',
  async (state) => {
    const f = fixture()
    const before = await f.commit()
    before.outcomeSet!.attempts.push({
      id: 'attempt',
      outcomeId: 'outcome',
      outcomeRevision: 1,
      actionId: 'step_v1',
      actionKey: 'key',
      state,
      startedAt: 1,
      updatedAt: 1
    } satisfies SessionOutcomeAttempt)
    const saved = f.runtime.replaceSessionChainOutcomesAndFlush(before, 1)
    const after = await f.service.commit(
      {
        ...saved,
        steps: [
          ...saved.steps,
          { id: 'v2', agent: 'codex', prompt: 'And then this.', status: 'queued', planVersion: 1 }
        ]
      },
      {
        source: 'user',
        expectedRevision: 1,
        outcomes: [{ ...f.definition, stepIds: ['v1', 'v2'] }]
      }
    )
    // The running attempt is untouched: it was not superseded, and its step still owns it.
    expect(after.outcomeSet!.attempts).toMatchObject([{ id: 'attempt', state }])
    expect(after.steps.map((step) => step.id)).toEqual(['v1', 'v2'])
  }
)
