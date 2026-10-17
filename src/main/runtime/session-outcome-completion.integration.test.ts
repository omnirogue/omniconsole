import { afterEach, expect, it, vi } from 'vitest'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'
import {
  SESSION_DISPOSITION_BACKOFF_MS,
  SESSION_DISPOSITION_MAX_ATTEMPTS,
  dueSessionRunDisposition
} from '../../shared/session-run-completion'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import { SESSION_RUN_SEALED_ERROR } from '../../shared/session-run-sealed-revision'
import {
  T0,
  completionHarness,
  type CompletionHarness
} from './session-outcome-completion-test-harness'
import {
  SESSION_OUTCOME_ATTEMPT_STALE,
  mergeSessionOutcomeAttempt
} from './session-outcome-launch-detach'

const STALL = 'No activity was observed for 180s, so the agent was treated as stalled.'
const harnesses: CompletionHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0).toReversed()) {
    await h.service.suspend()
    await h.dispose()
  }
})
function harness(restoreFrom?: string): CompletionHarness {
  const h = completionHarness(restoreFrom)
  harnesses.push(h)
  return h
}

it('success without a terminal action is recorded done, sealed and Completed, with nothing to close', async () => {
  const h = harness()
  const done = await h.complete()
  expect(done.state).toBe('done')
  expect(done.outcomeSet!.completion).toMatchObject({
    at: T0,
    outcomes: [{ id: 'result', revision: 1 }],
    evidenceIds: done.outcomeSet!.outcomes[0]!.evidence.map((entry) => entry.id)
  })
  expect(done.outcomeSet!.disposition).toMatchObject({
    intent: 'completed',
    state: 'applied',
    appliedAt: T0
  })
  // No window is ever asked to do anything for a run that only completed.
  expect(dueSessionRunDisposition(done.outcomeSet!, T0 + 86_400_000)).toBeNull()
  expect(h.announce).not.toHaveBeenCalled()
})

it.each([
  [{ action: 'end' } as const, { intent: 'close' }],
  [{ action: 'save', folderId: 'folder-7' } as const, { intent: 'save', folderId: 'folder-7' }]
])(
  'an explicit %j waits as a pending disposition and is applied by one ok report',
  async (finish, expected) => {
    const h = harness()
    const sealed = await h.complete(finish)
    expect(sealed.state).toBe('done')
    expect(sealed.outcomeSet!.disposition).toMatchObject({
      ...expected,
      state: 'pending',
      attempts: 0
    })
    const operationId = sealed.outcomeSet!.disposition!.operationId
    expect(dueSessionRunDisposition(sealed.outcomeSet!, T0)?.operationId).toBe(operationId)
    h.clock.now = T0 + 1_000
    const applied = await h.service.reportDisposition('chain', { operationId, ok: true })
    expect(applied.outcomeSet!.disposition).toMatchObject({
      ...expected,
      state: 'applied',
      appliedAt: T0 + 1_000
    })
    // History is retained: what was proven, and how, is exactly what it was at the seal.
    expect(applied.state).toBe('done')
    expect(applied.outcomeSet!.completion).toEqual(sealed.outcomeSet!.completion)
    expect(applied.outcomeSet!.outcomes).toEqual(sealed.outcomeSet!.outcomes)
    expect(applied.outcomeSet!.attempts).toEqual(sealed.outcomeSet!.attempts)
    expect(dueSessionRunDisposition(applied.outcomeSet!, T0 + 2_000)).toBeNull()
  }
)

it('a failed close leaves the work completed, retries once per due window, applies once and can exhaust', async () => {
  const h = harness()
  const sealed = await h.complete({ action: 'end' })
  const seal = sealed.outcomeSet!.completion
  const operationId = sealed.outcomeSet!.disposition!.operationId

  const ignored = await h.service.reportDisposition('chain', { operationId: 'op_other', ok: true })
  expect(ignored.outcomeSet!.disposition).toEqual(sealed.outcomeSet!.disposition)

  h.clock.now = T0 + 100
  const first = await h.service.reportDisposition('chain', {
    operationId,
    ok: false,
    error: 'The session is pinned or declined to close.'
  })
  expect(first.state).toBe('done')
  expect(first.outcomeSet!.completion).toEqual(seal)
  expect(first.outcomeSet!.disposition).toMatchObject({
    state: 'pending',
    attempts: 1,
    lastError: 'The session is pinned or declined to close.',
    nextAttemptAt: T0 + 100 + SESSION_DISPOSITION_BACKOFF_MS[0]
  })
  // Not due yet: no window is asked again, and a second failure inside the window is not counted.
  h.clock.now = T0 + 200
  expect(dueSessionRunDisposition(first.outcomeSet!, h.clock.now)).toBeNull()
  const inside = await h.service.reportDisposition('chain', { operationId, ok: false })
  expect(inside.outcomeSet!.disposition).toEqual(first.outcomeSet!.disposition)

  h.clock.now = first.outcomeSet!.disposition!.nextAttemptAt!
  expect(dueSessionRunDisposition(first.outcomeSet!, h.clock.now)?.operationId).toBe(operationId)
  const applied = await h.service.reportDisposition('chain', { operationId, ok: true })
  expect(applied.outcomeSet!.disposition).toMatchObject({ state: 'applied', attempts: 1 })
  expect(applied.outcomeSet!.disposition!.lastError).toBeUndefined()

  h.clock.now += 50_000
  const duplicate = await h.service.reportDisposition('chain', { operationId, ok: true })
  expect(duplicate.outcomeSet!.disposition).toEqual(applied.outcomeSet!.disposition)
  const lateFailure = await h.service.reportDisposition('chain', { operationId, ok: false })
  expect(lateFailure.outcomeSet!.disposition).toEqual(applied.outcomeSet!.disposition)
  expect(lateFailure.outcomeSet!.completion).toEqual(seal)
})

it('exhausted retries fail the disposition only; the person may ask for one more bounded series', async () => {
  const h = harness()
  const sealed = await h.complete({ action: 'save', folderId: 'folder-7' })
  const operationId = sealed.outcomeSet!.disposition!.operationId
  let chain = sealed
  for (let attempt = 1; attempt <= SESSION_DISPOSITION_MAX_ATTEMPTS; attempt++) {
    h.clock.now = chain.outcomeSet!.disposition!.nextAttemptAt ?? h.clock.now + 1
    chain = await h.service.reportDisposition('chain', { operationId, ok: false, error: 'Disk.' })
    expect(chain.outcomeSet!.disposition!.attempts).toBe(attempt)
  }
  expect(chain.outcomeSet!.disposition).toMatchObject({ state: 'failed', lastError: 'Disk.' })
  expect(chain.outcomeSet!.disposition!.nextAttemptAt).toBeUndefined()
  expect(chain.state).toBe('done')
  expect(chain.outcomeSet!.completion).toEqual(sealed.outcomeSet!.completion)
  expect(readSessionRun(chain.outcomeSet!, { now: h.clock.now }).phase).toBe('completed')
  expect(dueSessionRunDisposition(chain.outcomeSet!, h.clock.now)).toBeNull()

  const retried = await h.service.retryDisposition('chain')
  expect(retried.outcomeSet!.disposition).toMatchObject({
    state: 'pending',
    attempts: 0,
    operationId,
    folderId: 'folder-7'
  })
  expect(retried.outcomeSet!.completion).toEqual(sealed.outcomeSet!.completion)
  // Asking again for a disposition that is not failed changes nothing.
  expect((await h.service.retryDisposition('chain')).outcomeSet!.disposition).toEqual(
    retried.outcomeSet!.disposition
  )
})

it('nothing observed after the seal changes it: ticks, inactivity, late events, verify, review, resume', async () => {
  const h = harness()
  const sealed = await h.complete()
  const flush = vi.mocked(h.runtime.replaceSessionChainOutcomesAndFlush)
  flush.mockClear()

  // Post-completion inactivity: hours pass, the host keeps ticking, nothing is about this run.
  for (let round = 0; round < 6; round++) {
    h.clock.now += 3_600_000
    await h.tick()
  }
  // A late timeout, a late heartbeat and a duplicate completion for a worker of the sealed run.
  const late: SessionOutcomeAttempt = {
    id: 'att_late',
    outcomeId: 'result',
    actionId: 'produce',
    actionKey: 'produce',
    outcomeRevision: 1,
    state: 'blocked',
    error: STALL,
    startedAt: T0 - 500_000,
    updatedAt: T0 - 300_000
  }
  for (const event of [
    late,
    { ...late, state: 'running' as const, error: undefined },
    { ...late, state: 'completed' as const, error: undefined }
  ]) {
    expect(() => mergeSessionOutcomeAttempt(h.service, 'chain', event)).toThrow(
      SESSION_OUTCOME_ATTEMPT_STALE
    )
  }
  // The same events through the launch's own door: the rejection is contained, nothing is written.
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
  h.service.launchedDetach('chain')('att_late', (persist) => persist(late))
  await h.service.launches.settled()
  expect(warned).toHaveBeenCalledWith(
    '[outcomes] detached launch failed',
    'att_late',
    expect.objectContaining({ message: SESSION_OUTCOME_ATTEMPT_STALE })
  )
  // The proof drifts after the seal, and everything a person or a client can ask is asked.
  h.write('result.txt', 'Edited long after the run finished')
  expect(await h.service.verify('chain', 1, 'result', 'file')).toEqual(sealed)
  expect(await h.service.review('chain', 1, 'result', 'file', 'version')).toEqual(sealed)
  expect(await h.service.resume('chain', 1)).toEqual(sealed)
  // A stale snapshot from before completion, saved by a writer that never saw the seal.
  const { completion: _seal, disposition: _disposition, ...unsealed } = sealed.outcomeSet!
  const stale = h.service.save(
    {
      ...sealed,
      state: 'waiting',
      error: STALL,
      outcomeSet: {
        ...unsealed,
        continuation: { ...unsealed.continuation, state: 'unverifiable' },
        outcomes: unsealed.outcomes.map((outcome) => ({
          ...outcome,
          status: 'blocked' as const,
          blockedReason: STALL,
          evidence: []
        }))
      }
    },
    1
  )
  expect(stale).toEqual(sealed)
  await h.tick()

  expect(h.service.get('chain')).toEqual(sealed)
  expect(flush).not.toHaveBeenCalled()
  expect(h.announce).not.toHaveBeenCalled()
  expect(h.service.pendingOutcomes()).toEqual([])
})

it('the durable store refuses a stale snapshot or a legacy upsert that would un-finish a sealed run', async () => {
  const h = harness()
  const sealed = await h.complete()
  const { completion: _seal, disposition: _disposition, ...unsealed } = sealed.outcomeSet!
  // Reconnect hydration replaying what a client last saw, straight at the durable door.
  expect(() =>
    h.runtime.replaceSessionChainOutcomesAndFlush(
      { ...sealed, state: 'waiting', outcomeSet: unsealed },
      1
    )
  ).toThrow('sealed as completed')
  expect(() =>
    h.runtime.replaceSessionChainOutcomesAndFlush({ ...sealed, state: 'waiting' }, 1)
  ).toThrow('sealed as completed')
  expect(() => h.persistence.upsertSessionChain({ ...sealed, state: 'waiting' })).toThrow(
    'atomic outcome API'
  )
  expect(h.service.get('chain')).toEqual(sealed)
})

it('crash between recording the proof and recording done: the restarted host seals it', async () => {
  const h = harness()
  const crashed = await h.seedProvenButWaiting(STALL)
  expect(crashed.state).toBe('waiting')
  expect(crashed.outcomeSet!.completion).toBeUndefined()
  await h.stop()

  const restarted = harness(h.workspace)
  restarted.clock.now = T0 + 5_000
  await restarted.tick()
  const repaired = restarted.service.get('chain')
  expect(repaired.state).toBe('done')
  expect(repaired.error ?? null).toBeNull()
  expect(repaired.outcomeSet!.completion).toMatchObject({
    at: T0 + 5_000,
    evidenceIds: crashed.outcomeSet!.outcomes[0]!.evidence.map((entry) => entry.id)
  })
  expect(repaired.outcomeSet!.outcomes[0]!.evidence).toEqual(
    crashed.outcomeSet!.outcomes[0]!.evidence
  )
  // A lost completion notification changes nothing: whoever reconnects reads completed.
  expect(readSessionRun(repaired.outcomeSet!, { now: T0 + 9_000 }).phase).toBe('completed')
  const flush = vi.mocked(restarted.runtime.replaceSessionChainOutcomesAndFlush)
  flush.mockClear()
  await restarted.tick()
  expect(flush).not.toHaveBeenCalled()
  expect(restarted.announce).not.toHaveBeenCalled()
})

it('a record left waiting beside complete proof is repaired by the ordinary tick, without a restart', async () => {
  const h = harness()
  const stranded = await h.seedProvenButWaiting(STALL)
  expect(stranded).toMatchObject({ state: 'waiting', error: STALL })
  h.clock.now = T0 + 7_000
  await h.tick()
  const repaired = h.service.get('chain')
  expect(repaired.state).toBe('done')
  expect(repaired.error ?? null).toBeNull()
  expect(repaired.outcomeSet!.completion).toMatchObject({ at: T0 + 7_000 })
  expect(repaired.outcomeSet!.disposition).toMatchObject({ intent: 'completed', state: 'applied' })
  expect(h.announce).not.toHaveBeenCalled()
})

it('a sealed run with a pending disposition survives a restart pending, and is applied once', async () => {
  const h = harness()
  const sealed = await h.complete({ action: 'end' })
  const operationId = sealed.outcomeSet!.disposition!.operationId
  await h.stop()

  const restarted = harness(h.workspace)
  restarted.clock.now = T0 + 60_000
  for (let round = 0; round < 3; round++) {
    await restarted.tick()
  }
  const pending = restarted.service.get('chain')
  expect(pending.outcomeSet!.completion).toEqual(sealed.outcomeSet!.completion)
  expect(pending.outcomeSet!.disposition).toEqual(sealed.outcomeSet!.disposition)
  expect(dueSessionRunDisposition(pending.outcomeSet!, T0 + 60_000)?.operationId).toBe(operationId)

  const applied = await restarted.service.reportDisposition('chain', { operationId, ok: true })
  restarted.clock.now = T0 + 90_000
  const again = await restarted.service.reportDisposition('chain', { operationId, ok: true })
  expect(again.outcomeSet!.disposition).toEqual(applied.outcomeSet!.disposition)
  expect(again.outcomeSet!.disposition).toMatchObject({ state: 'applied', appliedAt: T0 + 60_000 })
})

it('a reconcile racing two reports of the same close leaves one effective disposition', async () => {
  const h = harness()
  const sealed = await h.complete({ action: 'end' })
  const operationId = sealed.outcomeSet!.disposition!.operationId
  h.clock.now = T0 + 10
  h.start()
  const [, first, second] = await Promise.all([
    h.service.reconcile('refresh'),
    h.service.reportDisposition('chain', { operationId, ok: true }),
    h.service.reportDisposition('chain', { operationId, ok: true })
  ])
  await h.service.reconcile('refresh')
  h.service.dispose()
  expect(first.outcomeSet!.disposition).toMatchObject({ state: 'applied', appliedAt: T0 + 10 })
  expect(second.outcomeSet!.disposition).toEqual(first.outcomeSet!.disposition)
  const final = h.service.get('chain')
  expect(final.outcomeSet!.disposition).toEqual(first.outcomeSet!.disposition)
  expect(final.outcomeSet!.completion).toEqual(sealed.outcomeSet!.completion)
})

it('new work on a sealed run forks a new run; its failure leaves the original completed', async () => {
  const h = harness()
  const sealed = await h.complete()
  const next = await h.service.commit(sealed, {
    source: 'user',
    expectedRevision: 1,
    outcomes: [h.definition('later.txt', 'later')]
  })
  expect(next.id).toMatch(/^source_[a-f0-9]{40}$/)
  expect(next.outcomeSet!.completion).toBeUndefined()
  // The successor fails honestly; the run it came from is untouched.
  const fork = h.service.get(next.id)
  const failed = h.service.save(
    {
      ...fork,
      outcomeSet: {
        ...fork.outcomeSet!,
        outcomes: fork.outcomeSet!.outcomes.map((outcome) => ({
          ...outcome,
          status: 'blocked' as const,
          blockedReason: STALL,
          block: { class: 'failed' as const, code: 'worker-stalled', since: T0 }
        }))
      }
    },
    fork.outcomeSet!.revision
  )
  expect(failed.state).toBe('failed')
  expect(h.announce).not.toHaveBeenCalled()
  expect(h.service.get('chain')).toEqual(sealed)
  // A dead successor and a sealed original are no reason to keep a headless host alive.
  expect(h.service.pendingOutcomes()).toEqual([])
})

it('a supersede that reuses the sealed outcome id is new work too: it forks, and edits nothing', async () => {
  const h = harness()
  const sealed = await h.complete()
  const next = await h.service.commit(
    { ...sealed, planVersion: 2 },
    {
      source: 'user',
      expectedRevision: 1,
      planVersion: 2,
      supersede: { reason: 'Another strategy' },
      outcomes: [{ ...h.definition('other.txt'), title: 'Result, another way' }]
    }
  )
  expect(next.id).toMatch(/^source_[a-f0-9]{40}$/)
  expect(next.outcomeSet!.completion).toBeUndefined()
  expect(next.outcomeSet!.outcomes[0]).toMatchObject({ id: 'result', revision: 1, evidence: [] })
  // A new run generation starts at its own first plan version.
  expect(next.planVersion ?? 1).toBe(1)
  expect(h.service.get('chain')).toEqual(sealed)
})

it('restating the sealed work replays nothing; changing its finish is refused', async () => {
  const h = harness()
  const sealed = await h.complete()
  const replay = await h.service.commit(sealed, {
    source: 'user',
    expectedRevision: 1,
    outcomes: [h.definition()]
  })
  expect(replay).toEqual(sealed)
  await expect(
    h.service.commit(sealed, {
      source: 'user',
      expectedRevision: 1,
      outcomes: [h.definition()],
      sessionFinish: { action: 'end' }
    })
  ).rejects.toThrow(SESSION_RUN_SEALED_ERROR)
  expect(h.runtime.listSessionChains()).toHaveLength(1)
  expect(h.service.get('chain')).toEqual(sealed)
})

it('appending a stage to a sealed run forks a run of the new stage only; the original is untouched', async () => {
  const h = harness()
  const sealed = await h.complete()
  const stage = {
    id: 'polish',
    outcomeId: 'result',
    agent: 'codex' as const,
    prompt: 'Polish the result.',
    status: 'queued' as const
  }
  const next = await h.service.commit(
    { ...sealed, steps: [...sealed.steps, stage] },
    {
      source: 'user',
      expectedRevision: 1,
      // The same outcome id, now carrying one more stage: new work under a reused id.
      outcomes: [{ ...h.definition(), stepIds: ['polish'] }]
    }
  )
  expect(next.id).toMatch(/^source_[a-f0-9]{40}$/)
  expect(next.steps.map((step) => step.id)).toEqual(['polish'])
  expect(next.outcomeSet).toMatchObject({ revision: 1, outcomes: [{ id: 'result', revision: 1 }] })
  expect(next.outcomeSet!.completion).toBeUndefined()
  expect(next.outcomeSet!.outcomes[0]!.evidence).toEqual([])
  expect(h.service.get('chain')).toEqual(sealed)
})

it('a commit that only edits a sealed run is refused in its own words, and forks nothing', async () => {
  const h = harness()
  const sealed = await h.complete({ action: 'end' })
  const proven = sealed.outcomeSet!.outcomes.map(({ id, title, finish, dependsOn, actions }) => ({
    id,
    title,
    finish,
    dependsOn,
    actions,
    // Done taken back: the finish's own source criterion goes with it.
    conditions: h.definition().conditions
  }))
  await expect(
    h.service.commit(sealed, {
      source: 'user',
      expectedRevision: sealed.outcomeSet!.revision,
      outcomes: proven,
      clearSessionFinish: true
    })
  ).rejects.toThrow(SESSION_RUN_SEALED_ERROR)
  expect(h.runtime.listSessionChains()).toHaveLength(1)
  expect(h.service.get('chain')).toEqual(sealed)
})

it.each([
  ['finished into Done for the owner’s review', 'done'],
  ['waiting for its source to finish a turn', 'working']
] as const)(
  'an unchanged run %s costs no durable write, pass after pass',
  async (_name, source) => {
    const h = harness()
    vi.mocked(h.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: source,
      lastAssistantMessage: null,
      interactivePrompt: null,
      stateStartedAt: T0 - 60_000,
      updatedAt: T0 - 60_000
    })
    await h.service.commit(h.chain(), {
      source: 'user',
      expectedRevision: 0,
      outcomes: [
        {
          ...h.definition(),
          finish: 'my-review',
          conditions: [
            ...h.definition().conditions,
            { id: 'my-review', kind: 'review', target: 'result' }
          ]
        }
      ]
    })
    h.write('result.txt', 'Verified result')
    // The passes that have something to record: the receipt, the request, the block.
    for (let pass = 0; pass < 3; pass++) {
      h.clock.now += 2_000
      await h.tick()
    }
    const settled = h.service.get('chain')
    expect(readSessionRun(settled.outcomeSet!, { now: h.clock.now }).phase).toBe(
      source === 'done' ? 'completed' : 'waiting'
    )
    const flush = vi.mocked(h.runtime.replaceSessionChainOutcomesAndFlush)
    flush.mockClear()

    // The 2 s cadence over an idle run: the whole profile used to be flushed on every one.
    for (let pass = 0; pass < 10; pass++) {
      h.clock.now += 2_000
      await h.tick()
    }
    expect(flush).not.toHaveBeenCalled()
    expect(h.service.get('chain')).toEqual(settled)
  }
)

it('a cancelled run and an unrelated live run are not the reconciler’s to repair', async () => {
  const h = harness()
  await h.service.commit(h.chain('stopped', 'source-stopped'), {
    source: 'user',
    expectedRevision: 0,
    outcomes: [h.definition('stopped.txt')]
  })
  const stopped = h.runtime.replaceSessionChainOutcomesAndFlush(
    { ...h.service.get('stopped'), state: 'cancelled' },
    1
  )
  await h.service.commit(h.chain('live', 'source-live'), {
    source: 'user',
    expectedRevision: 0,
    outcomes: [h.definition('live.txt')]
  })
  // The cancelled run's proof appears afterwards: it was stopped on purpose and stays stopped.
  h.write('stopped.txt', 'Produced after the run was cancelled')
  h.start()
  await h.service.reconcile('refresh')
  h.service.dispose()
  expect(h.service.get('stopped')).toEqual(stopped)
  // The live run is advanced like any other and is neither finished nor sealed by the pass.
  const live = h.service.get('live')
  expect(live.state).not.toBe('done')
  expect(live.outcomeSet!.completion).toBeUndefined()
  expect(h.service.pendingOutcomes().map((chain) => chain.id)).not.toContain('stopped')
})
