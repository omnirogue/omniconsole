import { expect, it, vi } from 'vitest'
import { planReportChain } from '../../shared/__fixtures__/work-plan/plan-report-chain'
import { sessionOutcomeConditionKey } from '../../shared/session-outcome-types'
import { normalizeSessionChain } from '../../shared/session-chain-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import { SessionChainPersistence } from '../persistence/loading-store/session-chain-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { postWorkPlanToCard, type WorkPlanCardPosterDeps } from './work-plan-card-poster'

const access = { baseUrl: 'https://hub.invalid', bearer: 'fake' }
function fixture(standalone = false) {
  const chain = planReportChain()
  if (!standalone) {
    chain.outcomeSet!.outcomes[0]!.taskRef = { taskId: 'btk_launch01', attachedAt: 1 }
  }
  const outcome = chain.outcomeSet!.outcomes[0]!
  outcome.evidence[0]!.conditionKey = sessionOutcomeConditionKey(outcome.conditions[0]!)
  const normalized = normalizeSessionChain(chain)!
  const state = { sessionChains: [normalized] } as PersistedState
  const persistence = new SessionChainPersistence(
    { state, flushOrThrow: vi.fn() },
    {} as WriteSchedulingOperations
  )
  const write = vi.spyOn(persistence, 'replaceSessionChainOutcomesAndFlush')
  const deps: WorkPlanCardPosterDeps = {
    chain: normalized,
    persistence,
    loadChain: vi.fn(() => persistence.listSessionChains()[0]),
    postNote: vi.fn(async () => ({ ok: true as const, data: { id: 'note-1' } })),
    postEvidence: vi.fn(async () => ({ ok: true as const, data: {} })),
    attachSessionToTask: vi.fn(async () => ({ attached: true })),
    now: vi.fn(() => 1234)
  }
  const run = () => postWorkPlanToCard(access, normalized.id, 'launch', deps)
  return { deps, state, write, run }
}

it('posts once and refuses a duplicate after a fresh module and persistence restart', async () => {
  const f = fixture()
  expect(await f.run()).toEqual({ posted: true, noteId: 'note-1' })
  vi.resetModules()
  const { postWorkPlanToCard: restarted } = await import('./work-plan-card-poster')
  const persistence = new SessionChainPersistence(
    { state: structuredClone(f.state), flushOrThrow: vi.fn() },
    {} as WriteSchedulingOperations
  )
  const deps = { ...f.deps, persistence, loadChain: () => persistence.listSessionChains()[0] }
  expect(await restarted(access, deps.chain.id, 'launch', deps)).toEqual({
    posted: false,
    reason: 'already-posted'
  })
  expect(f.deps.postNote).toHaveBeenCalledTimes(1)
  expect(f.deps.postEvidence).toHaveBeenCalledTimes(1)
  expect(f.deps.attachSessionToTask).toHaveBeenCalledTimes(1)
})

it('surfaces evidence 409 reason as-is and durably records the accepted note', async () => {
  const f = fixture()
  const reason = '{"detail":"evidence_exists","evidence_id":"ev_1","task_id":"btk_other"}'
  vi.mocked(f.deps.postEvidence).mockResolvedValue({ ok: false, reason })
  expect(await f.run()).toEqual({ posted: false, reason })
  expect(f.state.sessionChains![0]!.outcomeSet!.outcomes[0]!.taskRef).toMatchObject({
    postedNoteId: 'note-1',
    postedAt: 1234,
    postedRevision: 1
  })
})

it('records nothing when the hub refuses the note', async () => {
  const f = fixture()
  const before = JSON.stringify(f.state)
  vi.mocked(f.deps.postNote).mockResolvedValue({ ok: false, reason: 'feedback_access_denied' })
  expect(await f.run()).toEqual({ posted: false, reason: 'feedback_access_denied' })
  expect(f.write).not.toHaveBeenCalled()
  expect(f.deps.postEvidence).not.toHaveBeenCalled()
  expect(JSON.stringify(f.state)).toBe(before)
})

it('standalone pursuit invokes no dependency at all', async () => {
  const f = fixture(true)
  expect(await f.run()).toEqual({ posted: false, reason: 'standalone' })
  for (const callback of [
    f.deps.loadChain,
    f.write,
    f.deps.postNote,
    f.deps.postEvidence,
    f.deps.attachSessionToTask,
    f.deps.now
  ]) {
    expect(callback).not.toHaveBeenCalled()
  }
})

it('changes only taskRef while preserving attempts evidence steps and continuation byte-for-byte', async () => {
  const f = fixture()
  const before = structuredClone(f.state.sessionChains![0]!)
  await f.run()
  const after = structuredClone(f.state.sessionChains![0]!)
  after.updatedAt = before.updatedAt
  after.outcomeSet!.outcomes[0]!.taskRef = before.outcomeSet!.outcomes[0]!.taskRef
  expect(JSON.stringify(after)).toBe(JSON.stringify(before))
})

it('serializes concurrent posts and reads the persisted marker', async () => {
  const f = fixture()
  expect(await Promise.all([f.run(), f.run()])).toEqual([
    { posted: true, noteId: 'note-1' },
    { posted: false, reason: 'already-posted' }
  ])
  expect(f.deps.postNote).toHaveBeenCalledTimes(1)
})

it('allows a new outcome revision to post', async () => {
  const f = fixture()
  await f.run()
  // Why a new array: writers replace it, and the read snapshot is keyed by its identity.
  const bumped = structuredClone(f.state.sessionChains![0]!)
  bumped.outcomeSet!.outcomes[0]!.revision++
  f.state.sessionChains = [bumped]
  expect(await f.run()).toEqual({ posted: true, noteId: 'note-1' })
  expect(f.deps.postNote).toHaveBeenCalledTimes(2)
})

it('does not post or persist when session attach is refused', async () => {
  const f = fixture()
  vi.mocked(f.deps.attachSessionToTask).mockResolvedValue({
    attached: false,
    errorMessage: 'session_not_found'
  })
  expect(await f.run()).toEqual({ posted: false, reason: 'session_not_found' })
  expect(f.deps.postNote).not.toHaveBeenCalled()
  expect(f.write).not.toHaveBeenCalled()
})
