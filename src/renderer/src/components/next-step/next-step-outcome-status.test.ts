import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { HumanAttentionRequest } from '../../../../shared/session-human-attention'
import {
  SESSION_RECOVERING_MAX_MS,
  type SessionOutcomeBlock
} from '../../../../shared/session-outcome-block'
import { nextStepSessionPhase, outcomeVerification } from './next-step-outcome-status'
import { savedOutcomeSourceFixture } from '@/lib/sidebar-outcome-source-test-fixtures'

describe('the session phase', () => {
  it('reads current host progress for the same saved outcome while its draft stays dirty', () => {
    const { chain } = savedOutcomeSourceFixture()
    const saved = chain.outcomeSet!.outcomes[0]!
    saved.status = 'satisfied'
    const outcome = {
      id: saved.id,
      revision: saved.revision,
      status: 'needs-you' as const,
      needsYouReason: 'Old launch failure'
    }
    expect(nextStepSessionPhase({ agentState: null, returned: false, outcome, chain })).toEqual({
      phase: 'complete',
      reason: null
    })
    expect(outcome.status).toBe('needs-you')
  })

  it.each(['id', 'revision'] as const)(
    'does not borrow saved progress after the draft %s changes',
    (field) => {
      const { chain } = savedOutcomeSourceFixture()
      const saved = chain.outcomeSet!.outcomes[0]!
      saved.status = 'satisfied'
      const outcome = { id: saved.id, revision: saved.revision, status: 'needs-you' as const }
      if (field === 'id') {
        outcome.id = 'different'
      } else {
        outcome.revision += 1
      }
      expect(
        nextStepSessionPhase({ agentState: null, returned: false, outcome, chain }).phase
      ).toBe('needs-you')
    }
  )

  it('keeps an unsaved draft speaking for itself when the chain holds other outcomes', () => {
    const { chain } = savedOutcomeSourceFixture()
    chain.outcomeSet!.outcomes[0]!.status = 'satisfied'
    expect(
      nextStepSessionPhase({
        agentState: null,
        returned: false,
        outcome: { status: 'needs-you', needsYouReason: 'Approve the review' },
        chain
      })
    ).toEqual({ phase: 'needs-you', reason: 'Approve the review' })
  })

  it('lets a saved outcome speak first, then a returned plan, then the pane', () => {
    expect(
      nextStepSessionPhase({
        agentState: 'working',
        returned: true,
        outcome: { status: 'needs-you', needsYouReason: 'Review the diff' }
      })
    ).toEqual({ phase: 'needs-you', reason: 'Review the diff' })
    expect(
      nextStepSessionPhase({
        agentState: 'working',
        returned: true,
        outcome: { status: 'complete' }
      })
    ).toEqual({ phase: 'complete', reason: null })
    expect(
      nextStepSessionPhase({
        agentState: 'working',
        returned: true,
        outcome: { status: 'waiting' }
      })
    ).toEqual({ phase: 'returned', reason: null })
    expect(
      nextStepSessionPhase({
        agentState: 'working',
        returned: false,
        outcome: { status: 'waiting' }
      })
    ).toEqual({ phase: 'waiting', reason: null })
  })

  it('says failed or recovering for a draft that carries the status without its chain', () => {
    // Why: a draft hydrated from a host record can outlive the chain it was read from.
    for (const status of ['failed', 'recovering'] as const) {
      expect(
        nextStepSessionPhase({ agentState: 'blocked', returned: true, outcome: { status } })
      ).toEqual({ phase: status, reason: null })
    }
  })

  it('reads the pane state when nothing else is known', () => {
    const at = (agentState: 'working' | 'blocked' | 'waiting' | 'done' | null) =>
      nextStepSessionPhase({ agentState, returned: false, outcome: {} }).phase
    expect(at('working')).toBe('working')
    expect(at('blocked')).toBe('needs-you')
    expect(at('waiting')).toBe('needs-you')
    expect(at('done')).toBe('done')
    expect(at(null)).toBe('idle')
    expect(
      nextStepSessionPhase({ agentState: null, returned: false, outcome: { status: 'pending' } })
        .phase
    ).toBe('idle')
  })
})

/**
 * A blocked outcome is not "needs you". The stall sentence below used to be printed as
 * "Needs you · No activity was observed for 180s…": any blocked outcome with a reason was one.
 * The phase now comes from the block's CLASS, and needs-you only from an open request.
 */
describe('a blocked saved outcome', () => {
  const NOW = 1_700_000_000_000
  const STALL = "No activity was observed for 180s after this step's instruction was accepted."
  function blocked(block?: SessionOutcomeBlock, attention?: HumanAttentionRequest[]) {
    const { chain } = savedOutcomeSourceFixture()
    const saved = chain.outcomeSet!.outcomes[0]!
    saved.status = 'blocked'
    saved.blockedReason = STALL
    if (block) {
      saved.block = block
    }
    if (attention) {
      chain.outcomeSet!.attention = attention
    }
    return nextStepSessionPhase({
      agentState: null,
      returned: false,
      outcome: { id: saved.id, revision: saved.revision },
      chain,
      now: NOW
    })
  }
  const request = (over: Partial<HumanAttentionRequest> = {}): HumanAttentionRequest => ({
    id: 'att_1',
    kind: 'credential',
    scope: { outcomeId: 'result', outcomeRevision: 1 },
    ask: 'Sign Claude Code in again.',
    why: 'Its provider rejected the sign-in, and only you hold those credentials.',
    recipient: { type: 'owner' },
    action: { kind: 'open-conversation', label: 'Sign in' },
    source: { type: 'provider-authentication', ref: 'Claude Code' },
    state: 'open',
    openedAt: NOW,
    ...over
  })

  it('reads a legacy unclassified block as failed, with the sentence only as a diagnostic', () => {
    expect(blocked()).toEqual({ phase: 'failed', reason: null, diagnostic: STALL })
  })

  it('reads a stall the host will retry as recovering', () => {
    const block: SessionOutcomeBlock = {
      class: 'recovering',
      code: 'worker-stalled',
      since: NOW,
      until: NOW + 15_000
    }
    expect(blocked(block)).toEqual({ phase: 'recovering', reason: null, diagnostic: STALL })
    // A retry that has only just come due is still the host's to make …
    expect(
      blocked({ ...block, since: NOW - SESSION_RECOVERING_MAX_MS - 1, until: NOW - 1 })
    ).toEqual({ phase: 'recovering', reason: null, diagnostic: STALL })
    // … and it reads failed once nothing acted for the maximum after the scheduled time.
    expect(
      blocked({
        ...block,
        since: NOW - 2 * SESSION_RECOVERING_MAX_MS,
        until: NOW - SESSION_RECOVERING_MAX_MS - 1
      })
    ).toEqual({ phase: 'failed', reason: null, diagnostic: STALL })
  })

  it('reads a registered wake as waiting, naming it', () => {
    expect(
      blocked({ class: 'waiting', code: 'awaiting-review', since: NOW, wake: 'Jordan Taylor' })
    ).toEqual({ phase: 'waiting', reason: null, diagnostic: STALL, wake: 'Jordan Taylor' })
    const theirs = request({
      kind: 'review',
      recipient: { type: 'person', employeeId: 'emp_1', name: 'Uma' }
    })
    expect(
      blocked({ class: 'attention', code: 'awaiting-review', since: NOW }, [theirs])
    ).toMatchObject({ phase: 'waiting', wake: 'Uma' })
  })

  it('reads needs-you only from an open request to the owner, and says what it ASKS', () => {
    const block: SessionOutcomeBlock = {
      class: 'attention',
      code: 'provider-authentication',
      since: NOW,
      attentionIds: ['att_1']
    }
    expect(blocked(block, [request()])).toEqual({
      phase: 'needs-you',
      reason: 'Sign Claude Code in again.'
    })
    // A request that was met asks nobody: the host re-derives the block on its next pass.
    expect(blocked(block, [request({ state: 'resolved', resolvedAt: NOW })])).toMatchObject({
      phase: 'recovering'
    })
  })
})

describe('n/m verified', () => {
  const chain = {
    outcomeSet: {
      outcomes: [
        {
          id: 'o1',
          title: 'Ship the report',
          conditions: [
            { id: 'c1', kind: 'file', target: '/out/report.md' },
            { id: 'c2', kind: 'review', target: 'reviewer' }
          ],
          evidence: [{ conditionId: 'c1' }]
        },
        {
          id: 'o2',
          title: 'Tell Uma',
          conditions: [{ id: 'c3', kind: 'handoff', target: 'emp_uma' }],
          evidence: []
        }
      ]
    }
  } as unknown as SessionChain

  it('counts conditions with host evidence over every saved condition', () => {
    const verification = outcomeVerification(chain)!
    expect(verification.verified).toBe(1)
    expect(verification.total).toBe(3)
    expect(verification.items.map((item) => [item.outcomeTitle, item.kind, item.verified])).toEqual(
      [
        ['Ship the report', 'file', true],
        ['Ship the report', 'review', false],
        ['Tell Uma', 'handoff', false]
      ]
    )
  })

  it('has nothing to count before an outcome set is saved', () => {
    expect(outcomeVerification(null)).toBeNull()
    expect(outcomeVerification({} as SessionChain)).toBeNull()
  })
})
