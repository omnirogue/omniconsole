/**
 * The single terminal writer and work held behind a run's own person review: the last reply
 * never seals a run that still holds work, the stamp is re-derived on every write, the record of
 * each "needs changes" survives any writer's older snapshot, and a sealed run is never reopened.
 */
import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import { SESSION_RECOVERING_MAX_MS } from '../../shared/session-outcome-block'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import type { SessionRunReviewFix } from '../../shared/session-run-held-continuation'
import { proveRun, runSet } from '../../shared/session-run-lifecycle.test-fixture'
import { settleSessionOutcomeChain } from './session-outcome-completion'
import type { UpNextHeldContinuation } from './up-next-held-gates'

const NOW = 7_000_000
const HELD: UpNextHeldContinuation = { reviewStepIds: ['review'] }

const chain = (outcomeSet: SessionOutcomeSet): SessionChain => ({
  id: 'chn_1',
  workspacePath: '/w',
  worktreeId: 'folder:f1',
  hostId: 'local',
  sourcePaneKey: 'tab-1:leaf-1',
  sourceRowKey: 'row',
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  outcomeSet,
  createdAt: 1,
  updatedAt: 2
})

const fix = (receipt: string, over: Partial<SessionRunReviewFix> = {}): SessionRunReviewFix => ({
  receipt,
  stepId: 'review',
  employeeId: 'emp_uma',
  round: 1,
  at: 10,
  ...over
})

const settle = (
  next: SessionChain,
  held: UpNextHeldContinuation | null,
  current?: SessionChain,
  now = NOW
) => settleSessionOutcomeChain({ chain: next, current, now, held, operationId: () => 'op_seal' })

describe('a proven run that still holds work behind its review', () => {
  it('is not sealed, not done and has no disposition: it carries the stamp instead', () => {
    const settled = settle(chain(proveRun(runSet(), 'one')), HELD).chain
    expect(settled.state).toBe('waiting')
    expect(settled.outcomeSet!.completion).toBeUndefined()
    expect(settled.outcomeSet!.disposition).toBeUndefined()
    expect(settled.outcomeSet!.heldContinuation).toEqual({ reviewStepIds: ['review'], since: NOW })
    // The same proof with nothing held completes exactly as before.
    expect(settle(chain(proveRun(runSet(), 'one')), null).chain).toMatchObject({
      state: 'done',
      outcomeSet: { completion: { at: NOW } }
    })
  })

  it('keeps the moment it was first otherwise complete, so the stale rule has a start', () => {
    const first = settle(chain(proveRun(runSet(), 'one')), HELD).chain
    const again = settle(first, HELD, first, NOW + 5_000).chain
    expect(again.outcomeSet!.heldContinuation!.since).toBe(NOW)
  })

  it('records a refused release on the run, where every reader sees it', () => {
    const settled = settle(chain(proveRun(runSet(), 'one')), { ...HELD, refused: 'Refused.' })
    expect(settled.chain.outcomeSet!.heldContinuation!.refused).toBe('Refused.')
    expect(settled.chain.state).toBe('waiting')
    expect(settled.chain.error).toBe('Refused.')
  })

  it('stamps when the refusal first appeared, so a late refusal starts its own stale clock', () => {
    const first = settle(chain(proveRun(runSet(), 'one')), HELD).chain
    const late = NOW + 3 * SESSION_RECOVERING_MAX_MS
    const refused = settle(
      first,
      { ...HELD, refused: 'Pane not found.', refusedSince: late },
      first,
      late + 1
    )
    expect(refused.chain.outcomeSet!.heldContinuation).toMatchObject({
      since: NOW,
      refused: 'Pane not found.',
      refusedSince: late
    })
    // Recovering, not failed: the refusal is one second old, whatever the run's own age.
    expect(refused.chain.state).toBe('waiting')
    expect(refused.chain.outcomeSet!.completion).toBeUndefined()
  })

  it('keeps every answer a re-ask retired, whatever snapshot a writer offers', () => {
    const old = 'handoff-review:hth_a:hrv_1:approve'
    const recorded = chain({
      ...runSet(),
      heldContinuation: { reviewStepIds: ['review'], superseded: [old] }
    })
    const offered = chain({ ...runSet(), heldContinuation: { reviewStepIds: ['review'] } })
    expect(settle(offered, HELD, recorded).chain.outcomeSet!.heldContinuation!.superseded).toEqual([
      old
    ])
  })

  it('stamps an unfinished run too, without a stale clock, and drops the stamp once nothing is held', () => {
    const waiting = settle(chain(runSet()), HELD).chain
    expect(waiting.outcomeSet!.heldContinuation).toEqual({ reviewStepIds: ['review'] })
    const released = settle(waiting, null, waiting).chain
    expect(released.outcomeSet!.heldContinuation).toBeUndefined()
  })

  it('keeps every "needs changes" record a writer with an older snapshot did not carry', () => {
    const first = 'handoff-review:hth_a:hrv_1:request_changes'
    const second = 'handoff-review:hth_b:hrv_2:request_changes'
    const recorded = chain({
      ...runSet(),
      heldContinuation: {
        reviewStepIds: ['review'],
        fixes: [fix(first, { promptId: 'review-fix-1', deliveredAt: 20 })]
      }
    })
    // A writer that read the set before the notes were delivered, and one new reply beside it.
    const offered = chain({
      ...runSet(),
      heldContinuation: {
        reviewStepIds: ['review'],
        fixes: [fix(first), fix(second, { employeeId: 'emp_iris' })]
      }
    })
    const settled = settle(offered, HELD, recorded).chain
    expect(settled.outcomeSet!.heldContinuation!.fixes).toEqual([
      fix(first, { promptId: 'review-fix-1', deliveredAt: 20 }),
      fix(second, { employeeId: 'emp_iris' })
    ])
  })

  it('never reopens a sealed run, whatever is held behind its review', () => {
    const sealed = settle(chain(proveRun(runSet(), 'one')), null).chain
    const { error: _dropped, ...persisted } = sealed
    const later = settle(chain(runSet()), HELD, persisted, NOW + 1).chain
    expect(later.outcomeSet).toEqual(persisted.outcomeSet)
    expect(later.state).toBe('done')
  })
})
