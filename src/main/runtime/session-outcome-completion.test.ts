import { describe, expect, it } from 'vitest'
import { ownReviewAttention, personReviewAttention } from '../../shared/session-attention-drafts'
import type { SessionChain } from '../../shared/session-chain-types'
import { openHumanAttention } from '../../shared/session-human-attention'
import { normalizeSessionOutcomeSet } from '../../shared/session-outcome-state'
import type { SessionOutcomeSet } from '../../shared/session-outcome-types'
import { recordSessionRunDisposition } from '../../shared/session-run-completion'
import {
  blockRunOutcome,
  proveRun,
  runDefinition,
  runScope,
  runSet
} from '../../shared/session-run-lifecycle.test-fixture'
import { sameDurableSessionChain, settleSessionOutcomeChain } from './session-outcome-completion'

const NOW = 5_000_000
const STALL = 'No activity was observed for 180s, so the agent was treated as stalled.'

const chain = (outcomeSet: SessionOutcomeSet, extra: Partial<SessionChain> = {}): SessionChain => ({
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
  error: null,
  outcomeSet,
  createdAt: 1,
  updatedAt: 2,
  ...extra
})

const settle = (next: SessionChain, current?: SessionChain, now = NOW) =>
  settleSessionOutcomeChain({ chain: next, current, now, operationId: () => 'op_seal' })

/** The store drops a null error on write, so that is how a persisted record reads back. */
const persisted = ({ error: _dropped, ...record }: SessionChain): SessionChain => record

const sealedChain = (finish?: SessionOutcomeSet['sessionFinish']): SessionChain =>
  persisted(
    settle(chain({ ...proveRun(runSet(), 'one'), ...(finish ? { sessionFinish: finish } : {}) }))
      .chain
  )

describe('sealing a proven run', () => {
  it('seals in the write that records done, and without a terminal action nothing is left to do', () => {
    const settled = settle(chain(proveRun(runSet(), 'one')))
    expect(settled.chain.state).toBe('done')
    expect(settled.chain.error).toBeNull()
    expect(settled.chain.outcomeSet!.completion).toMatchObject({
      at: NOW,
      outcomes: [{ id: 'one', revision: 1 }],
      evidenceIds: ['receipt_one']
    })
    expect(settled.chain.outcomeSet!.disposition).toMatchObject({
      intent: 'completed',
      state: 'applied',
      operationId: 'op_seal',
      appliedAt: NOW
    })
    expect(settled.announce).toEqual([])
  })

  it.each([
    [{ action: 'end' } as const, { intent: 'close', state: 'pending' }],
    [
      { action: 'save', folderId: 'folder-1' } as const,
      { intent: 'save', folderId: 'folder-1', state: 'pending' }
    ],
    [{ action: 'me' } as const, { intent: 'completed', state: 'applied' }]
  ])('records the explicit terminal action %j as the disposition', (finish, disposition) => {
    expect(sealedChain(finish).outcomeSet!.disposition).toMatchObject(disposition)
  })

  it('seals the status its receipts prove, never a stale one a writer left on the outcome', () => {
    const proven = proveRun(runSet(), 'one')
    // The status recompute writes `pending` for a finished outcome whose proof was already in.
    const stale = {
      ...proven,
      outcomes: proven.outcomes.map((outcome) => ({ ...outcome, status: 'pending' as const }))
    }
    const sealed = settle(chain(stale)).chain.outcomeSet!
    expect(sealed.completion).toBeDefined()
    // A sealed set is never reconciled again, so this is the status every reader keeps seeing.
    expect(normalizeSessionOutcomeSet(sealed)!.outcomes[0]!.status).toBe('satisfied')
  })

  it('stamps the plan version the run was proven under', () => {
    const settled = settle(chain(proveRun(runSet(), 'one'), { planVersion: 2 }))
    expect(settled.chain.outcomeSet!.completion!.planVersion).toBe(2)
  })

  it('does not seal a proven stage while required stages remain', () => {
    const steps = [
      { id: 's1', agent: 'codex' as const, prompt: 'One', status: 'launched' as const },
      { id: 's2', agent: 'codex' as const, prompt: 'Two', status: 'queued' as const }
    ]
    const settled = settle(chain(proveRun(runSet(), 'one'), { steps, currentIndex: 1 }))
    expect(settled.chain.state).toBe('waiting')
    expect(settled.chain.outcomeSet!.completion).toBeUndefined()
    expect(settled.chain.outcomeSet!.disposition).toBeUndefined()
  })

  it('does not seal while another outcome is unproven', () => {
    const set = proveRun(runSet([runDefinition('one'), runDefinition('two')]), 'one')
    const settled = settle(chain(set))
    expect(settled.chain.state).toBe('waiting')
    expect(settled.chain.outcomeSet!.completion).toBeUndefined()
  })

  it('does not seal proof held by a host that no longer owns the run', () => {
    const proven = proveRun(runSet(), 'one')
    const settled = settle(
      chain({ ...proven, continuation: { ...proven.continuation, state: 'unverifiable' } })
    )
    expect(settled.chain.state).toBe('waiting')
    expect(settled.chain.outcomeSet!.completion).toBeUndefined()
  })
})

describe('a sealed run is final', () => {
  it('ignores a stale snapshot, drifted evidence, an unowned host and a late block', () => {
    const current = sealedChain()
    const stale = chain(
      blockRunOutcome(
        { ...runSet(), continuation: { ...runSet().continuation, state: 'unverifiable' } },
        'one',
        STALL
      ),
      { state: 'waiting', error: STALL }
    )
    const settled = settle(stale, current, NOW + 60_000)
    expect(settled.chain).toEqual(current)
    expect(settled.announce).toEqual([])
  })

  it('repairs a sealed record persisted under another state without touching the seal', () => {
    const sealed = sealedChain()
    const contradictory: SessionChain = { ...sealed, state: 'waiting', error: STALL }
    const settled = settle(contradictory, contradictory, NOW + 1)
    expect(settled.chain.state).toBe('done')
    expect(settled.chain.error).toBeUndefined()
    expect(settled.chain.outcomeSet).toEqual(sealed.outcomeSet)
  })

  it('moves the disposition of the same seal forward and never backward', () => {
    const current = sealedChain({ action: 'end' })
    const operationId = current.outcomeSet!.disposition!.operationId
    const failedOnce = recordSessionRunDisposition(
      current.outcomeSet!,
      { operationId, ok: false, error: 'Pinned.' },
      NOW + 10
    )
    const afterFailure = settle({ ...current, outcomeSet: failedOnce }, current, NOW + 10).chain
    expect(afterFailure.outcomeSet!.disposition).toMatchObject({ state: 'pending', attempts: 1 })
    // The snapshot from before the failure is older, so it cannot rewind the retry count.
    expect(settle(current, afterFailure, NOW + 20).chain).toEqual(afterFailure)
    const applied = recordSessionRunDisposition(
      afterFailure.outcomeSet!,
      { operationId, ok: true },
      NOW + 30
    )
    const afterApply = settle(
      { ...afterFailure, outcomeSet: applied },
      afterFailure,
      NOW + 30
    ).chain
    expect(afterApply.outcomeSet!.disposition).toMatchObject({ state: 'applied', attempts: 1 })
    expect(settle(afterFailure, afterApply, NOW + 40).chain).toEqual(afterApply)
    expect(afterApply.outcomeSet!.completion).toEqual(current.outcomeSet!.completion)
  })

  it('still records the delivery of a prompt queued for a stage, so it is never sent twice', () => {
    const prompt = {
      id: 'stage-1',
      text: 'One more thing',
      createdAt: NOW,
      state: 'queued' as const
    }
    const seat = { id: 's1', agent: 'codex' as const, prompt: 'One', status: 'launched' as const }
    const staged = runSet([runDefinition('one', { stepIds: ['s1'] })])
    const current = persisted(
      settle(
        chain(proveRun({ ...staged, completedSteps: ['s1'] }, 'one'), {
          steps: [{ ...seat, prompts: [prompt] }],
          currentIndex: 1
        })
      ).chain
    )
    expect(current.outcomeSet!.completion).toBeDefined()
    const sending = { ...prompt, state: 'sending' as const, deliveryEpoch: 'host1' }
    const marked = settle(
      { ...current, steps: [{ ...seat, prompts: [sending] }] },
      current,
      NOW + 5
    ).chain
    expect(marked.steps).toEqual([{ ...seat, prompts: [sending] }])
    expect(marked.outcomeSet).toEqual(current.outcomeSet)
    expect(marked.state).toBe('done')
    // A snapshot from before the seal carries no authority over the record, prompts included.
    const { completion: _seal, disposition: _disposition, ...unsealed } = current.outcomeSet!
    const stale = settle(
      { ...current, outcomeSet: unsealed, steps: [{ ...seat, prompts: [] }] },
      marked,
      NOW + 9
    ).chain
    expect(stale).toEqual(marked)
  })

  it('ignores a disposition offered under another seal or another operation', () => {
    const current = sealedChain({ action: 'end' })
    const foreign = {
      ...current.outcomeSet!,
      disposition: {
        ...current.outcomeSet!.disposition!,
        operationId: 'op_other',
        state: 'applied' as const,
        updatedAt: NOW + 5
      }
    }
    expect(settle({ ...current, outcomeSet: foreign }, current, NOW + 5).chain).toEqual(current)
    const otherSeal = {
      ...current.outcomeSet!,
      completion: { ...current.outcomeSet!.completion!, at: NOW + 1 },
      disposition: {
        ...current.outcomeSet!.disposition!,
        state: 'applied' as const,
        updatedAt: NOW + 5
      }
    }
    expect(settle({ ...current, outcomeSet: otherSeal }, current, NOW + 5).chain).toEqual(current)
  })
})

describe('a write that would change nothing durable', () => {
  // `reports/handoff-diagnosis.md` D9: an unsealed save wrote `error: null`, the store dropped the
  // key, and the byte comparison therefore never matched — the profile was flushed on every pass.
  it('leaves `error` out when the run has nothing to say, and takes a stale one away', () => {
    const quiet = settle(chain(runSet(), { error: STALL }))
    expect(quiet.chain.state).toBe('waiting')
    expect('error' in quiet.chain).toBe(false)
  })

  it('reads a settled record as the record the store already holds', () => {
    const recorded = persisted(settle(chain(runSet())).chain)
    const again = settle({ ...recorded, error: null }, recorded, NOW + 2_000).chain
    expect(sameDurableSessionChain(recorded, again)).toBe(true)
    // In memory the two differ by key order and by an empty key; durably they are one record.
    const { id, ...rest } = again
    expect(sameDurableSessionChain(recorded, { ...rest, id, error: null })).toBe(true)
  })

  it('never calls a real change, a first write or an unreadable record unchanged', () => {
    const recorded = persisted(settle(chain(runSet())).chain)
    const failed = settle(
      chain(
        blockRunOutcome(runSet(), 'one', STALL, {
          class: 'failed',
          code: 'worker-stalled',
          since: NOW
        })
      )
    ).chain
    expect(sameDurableSessionChain(recorded, failed)).toBe(false)
    expect(sameDurableSessionChain(undefined, recorded)).toBe(false)
    expect(sameDurableSessionChain(recorded, { ...recorded, id: '' })).toBe(false)
  })
})

describe('state and announcements come from the policy', () => {
  it('records an honest operational failure as failed and announces nothing', () => {
    const failed = blockRunOutcome(runSet(), 'one', STALL, {
      class: 'failed',
      code: 'worker-stalled',
      since: NOW
    })
    const settled = settle(chain(failed))
    expect(settled.chain.state).toBe('failed')
    expect(settled.chain.error).toBe(`one: ${STALL}`)
    expect(settled.announce).toEqual([])
  })

  it('reads a legacy unclassified block as failed, never as a request', () => {
    const settled = settle(chain(blockRunOutcome(runSet(), 'one', STALL)))
    expect(settled.chain.state).toBe('failed')
    expect(settled.announce).toEqual([])
  })

  it('announces an open request to the owner once, stamped in the same record', () => {
    const asked = openHumanAttention(
      runSet(),
      ownReviewAttention({ scope: { ...runScope(), conditionId: 'file' }, title: 'one' }),
      NOW - 10
    )
    const first = settle(chain(asked.set))
    expect(first.announce.map((entry) => entry.id)).toEqual([asked.id])
    expect(first.chain.state).toBe('waiting')
    expect(first.chain.outcomeSet!.attention![0]).toMatchObject({
      id: asked.id,
      state: 'open',
      notifiedAt: NOW
    })
    const again = settle(first.chain, first.chain, NOW + 50)
    expect(again.announce).toEqual([])
    expect(again.chain.outcomeSet!.attention![0]!.notifiedAt).toBe(NOW)
  })

  it('does not announce again for a writer still holding the set from before the stamp', () => {
    const asked = openHumanAttention(
      runSet(),
      ownReviewAttention({ scope: { ...runScope(), conditionId: 'file' }, title: 'one' }),
      NOW - 10
    )
    const first = settle(chain(asked.set))
    const stale = settle(chain(asked.set), first.chain, NOW + 50)
    expect(stale.announce).toEqual([])
    expect(stale.chain.outcomeSet!.attention![0]!.notifiedAt).toBe(NOW)
    // The same requirement unmet AGAIN is a new request, with its own announcement.
    const reopened = {
      ...asked.set,
      attention: [{ ...asked.set.attention![0]!, openedAt: NOW + 100 }]
    }
    expect(settle(chain(reopened), first.chain, NOW + 100).announce.map((e) => e.id)).toEqual([
      asked.id
    ])
  })

  it('never announces a request addressed to another person', () => {
    const asked = openHumanAttention(
      runSet(),
      personReviewAttention({
        scope: { ...runScope(), conditionId: 'file' },
        title: 'one',
        employeeId: 'emp_2',
        name: 'Eve'
      }),
      NOW - 10
    )
    const settled = settle(chain(asked.set))
    expect(settled.announce).toEqual([])
    expect(settled.chain.outcomeSet!.attention![0]!.notifiedAt).toBeUndefined()
  })
})
