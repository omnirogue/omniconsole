import { describe, expect, it, vi } from 'vitest'
import type { HumanAttentionRequest } from '../../../shared/session-human-attention'
import { SESSION_RECOVERING_MAX_MS } from '../../../shared/session-outcome-block'
import type { SessionChain } from '../../../shared/session-chain-types'
import { conversationPlanFixture } from './conversation-plan-fixture'
import { sessionRunRequests, sessionRunRowState } from './session-run-row-state'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const now = 1_000_000_000
const STALL = 'No activity was observed for 180s. The worker may have stalled.'

function request(patch: Partial<HumanAttentionRequest> = {}): HumanAttentionRequest {
  return {
    id: 'att_review-findings_outcome_1',
    kind: 'decision',
    scope: { outcomeId: 'outcome', outcomeRevision: 1 },
    ask: 'Decide what happens to 2 open review findings.',
    why: 'All 2 authorized review rounds are used; another one needs your say.',
    recipient: { type: 'owner' },
    action: { kind: 'open-up-next', label: 'Decide' },
    source: { type: 'review-findings', ref: 'rounds:2' },
    state: 'open',
    openedAt: 5,
    ...patch
  }
}

/** A plan whose only outcome stopped with the stall watchdog's text and no class from any writer. */
function stalled(): SessionChain {
  const chain = conversationPlanFixture()
  chain.outcomeSet!.attempts = []
  chain.outcomeSet!.outcomes[0]!.status = 'blocked'
  chain.outcomeSet!.outcomes[0]!.blockedReason = STALL
  return chain
}

function sealed(): SessionChain {
  const chain = stalled()
  chain.outcomeSet!.completion = {
    at: 50,
    outcomes: [{ id: 'outcome', revision: 1 }],
    evidenceIds: []
  }
  return chain
}

describe('a blocked reason is a diagnostic, never a request', () => {
  it('reads the 180 s stall as an honest failure outside Needs you', () => {
    const run = sessionRunRowState(stalled(), { now })
    expect(run).toMatchObject({
      phase: 'failed',
      group: 'stopped',
      countsAsAttention: false,
      requests: [],
      settled: true,
      headline: 'Failed · No activity was observed for 180s.'
    })
    // Why: the full diagnostic is for the expandable details only.
    expect(run.detail).toBe(`Plan the work: ${STALL}`)
  })

  it('reads a block the host is recovering as Recovering, and a stale one as Failed', () => {
    const chain = stalled()
    chain.outcomeSet!.outcomes[0]!.block = {
      class: 'recovering',
      code: 'dispatch-stall',
      since: now - 1_000,
      until: now + 30_000
    }
    expect(sessionRunRowState(chain, { now })).toMatchObject({
      phase: 'recovering',
      group: 'waiting',
      countsAsAttention: false,
      requests: [],
      settled: false,
      headline: 'Recovering · retrying automatically'
    })
    chain.outcomeSet!.outcomes[0]!.block = {
      class: 'recovering',
      code: 'dispatch-stall',
      since: now - SESSION_RECOVERING_MAX_MS - 1
    }
    expect(sessionRunRowState(chain, { now }).phase).toBe('failed')
  })

  it('reads a failed queue without outcomes as Failed too', () => {
    const { outcomeSet: _none, ...legacy } = conversationPlanFixture()
    const run = sessionRunRowState(
      { ...legacy, state: 'failed', error: 'The pane is gone. Reopen it.' },
      { now }
    )
    expect(run).toMatchObject({
      phase: 'failed',
      group: 'stopped',
      countsAsAttention: false,
      headline: 'Failed · The pane is gone.',
      detail: 'The pane is gone. Reopen it.'
    })
  })
})

describe('an open request addressed to the owner is the whole of Needs you', () => {
  it('puts the row under Needs you, counted once, with the ask as its headline', () => {
    const chain = stalled()
    chain.outcomeSet!.attention = [request()]
    const run = sessionRunRowState(chain, { now })
    expect(run).toMatchObject({
      phase: 'needs-you',
      group: 'attention',
      countsAsAttention: true,
      settled: false,
      headline: 'Needs you: Decide what happens to 2 open review findings.',
      detail: 'All 2 authorized review rounds are used; another one needs your say.'
    })
    expect(run.requests.map((entry) => entry.action?.kind)).toEqual(['open-up-next'])
    expect(sessionRunRequests([chain, conversationPlanFixture()], now)).toHaveLength(1)
  })

  it('says how many more asks wait behind the first', () => {
    const chain = stalled()
    chain.outcomeSet!.attention = [
      request(),
      request({ id: 'att_principal_outcome_2', ask: 'Sign back in.', openedAt: 6 })
    ]
    expect(sessionRunRowState(chain, { now }).headline).toBe(
      'Needs you: Decide what happens to 2 open review findings. · +1 more'
    )
  })

  it('ignores a request that was met, or that is about an earlier revision', () => {
    const chain = stalled()
    chain.outcomeSet!.attention = [
      request({ state: 'resolved', resolvedAt: 9 }),
      request({ id: 'att_old', scope: { outcomeId: 'outcome', outcomeRevision: 7 } })
    ]
    expect(sessionRunRowState(chain, { now })).toMatchObject({
      phase: 'failed',
      countsAsAttention: false,
      requests: []
    })
  })

  it('waits on a named person without counting for the owner', () => {
    const chain = stalled()
    chain.outcomeSet!.outcomes[0]!.block = { class: 'waiting', code: 'person-review', since: 1 }
    chain.outcomeSet!.attention = [
      request({ recipient: { type: 'person', employeeId: 'emp_uma', name: 'Uma' } })
    ]
    expect(sessionRunRowState(chain, { now })).toMatchObject({
      phase: 'waiting',
      group: 'waiting',
      countsAsAttention: false,
      requests: [],
      headline: 'Waiting for Uma'
    })
    expect(sessionRunRequests([chain], now)).toEqual([])
  })

  function eventWait(wake: string): SessionChain {
    const chain = stalled()
    const outcome = chain.outcomeSet!.outcomes[0]!
    outcome.conditions = [
      ...outcome.conditions,
      { id: 'uma', kind: 'event', target: 'uma' },
      { id: 'iris', kind: 'event', target: 'iris' }
    ]
    outcome.block = { class: 'waiting', code: 'event-wait', since: 1, wake }
    outcome.waits = [
      { conditionId: 'uma', status: 'met', checkedAt: now - 3_600_000 },
      { conditionId: 'iris', status: 'pending', checkedAt: now - 20_000 }
    ]
    outcome.evidence = [
      {
        id: 'ev_uma',
        outcomeId: 'outcome',
        conditionId: 'uma',
        outcomeRevision: outcome.revision,
        conditionKey: 'k',
        kind: 'event',
        target: 'uma',
        receipt: 'slack:approved',
        verifiedAt: 1,
        verifier: 'execution-host'
      }
    ]
    return chain
  }

  it('reads an event wait with who it is on and when it was last checked', () => {
    const chain = eventWait('Uma ✓, Iris ○ on Slack')
    expect(sessionRunRowState(chain, { now })).toMatchObject({
      phase: 'waiting',
      countsAsAttention: false,
      headline: 'Waiting · Uma ✓, Iris ○ on Slack · checked 20 s ago'
    })
    expect(sessionRunRowState(chain, { now: now - 18_000 }).headline).toContain('checked just now')
    expect(sessionRunRowState(chain, { now: now + 280_000 }).headline).toContain(
      'checked 5 min ago'
    )
  })

  it('says so plainly when nobody can check the wait', () => {
    const wake = 'Follow-up not scheduled: omnios is unreachable.'
    expect(sessionRunRowState(eventWait(wake), { now }).headline).toBe(wake)
  })

  it('keeps the plain waiting line once every event wait is proven', () => {
    const chain = eventWait('Uma ✓ on Slack')
    chain.outcomeSet!.outcomes[0]!.waits = chain.outcomeSet!.outcomes[0]!.waits!.slice(0, 1)
    expect(sessionRunRowState(chain, { now }).headline).toBe('Waiting for Uma ✓ on Slack')
  })

  it('keeps the same count across a reconnect and a later re-render', () => {
    const chain = stalled()
    chain.outcomeSet!.attention = [request({ notifiedAt: 6 })]
    const counts = [now, now + 60_000].map((at) => sessionRunRequests([chain], at).length)
    chain.outcomeSet!.continuation.state = 'unverifiable'
    counts.push(sessionRunRequests([chain], now + 120_000).length)
    chain.outcomeSet!.continuation.state = 'owned'
    counts.push(sessionRunRequests([chain], now + 180_000).length)
    expect(counts).toEqual([1, 1, 1, 1])
  })

  it('does not count a row the person snoozed, archived or saved', () => {
    const chain = stalled()
    chain.outcomeSet!.attention = [request()]
    expect(sessionRunRowState(chain, { now, snoozed: true })).toMatchObject({
      group: 'waiting',
      countsAsAttention: false
    })
    expect(sessionRunRowState(chain, { now, archived: true })).toMatchObject({
      group: 'archived',
      countsAsAttention: false
    })
    expect(sessionRunRowState(chain, { now, saved: true })).toMatchObject({
      group: 'saved',
      countsAsAttention: false
    })
  })
})

describe('a finished run stays finished', () => {
  it('never reads a sealed run as active, failed or needing anyone', () => {
    const chain = sealed()
    // Why: everything below arrived after the seal and is about the world, not this run.
    chain.outcomeSet!.continuation.state = 'unverifiable'
    chain.outcomeSet!.attention = [request()]
    chain.outcomeSet!.attempts = [
      {
        ...conversationPlanFixture().outcomeSet!.attempts[0]!,
        state: 'blocked',
        error: STALL
      }
    ]
    expect(sessionRunRowState(chain, { now })).toMatchObject({
      phase: 'completed',
      group: 'completed',
      countsAsAttention: false,
      requests: [],
      settled: true,
      running: false,
      completedAt: 50,
      headline: 'Plan finished · complete'
    })
    expect(sessionRunRequests([chain], now)).toEqual([])
  })

  it('reads a plan that ended Back to me as Completed, not as a question', () => {
    const chain = conversationPlanFixture()
    chain.end = 'me'
    chain.state = 'done'
    expect(sessionRunRowState(chain, { now })).toMatchObject({
      phase: 'completed',
      group: 'completed',
      countsAsAttention: false,
      requests: []
    })
  })

  it('reads a cancelled run as cancelled whatever its outcomes last said', () => {
    const chain = stalled()
    chain.state = 'cancelled'
    chain.outcomeSet!.attention = [request()]
    expect(sessionRunRowState(chain, { now })).toMatchObject({
      phase: 'cancelled',
      settled: true,
      countsAsAttention: false,
      requests: []
    })
  })

  it('exposes no attention on an archived sealed, failed or cancelled run', () => {
    const cancelled = stalled()
    cancelled.state = 'cancelled'
    for (const chain of [sealed(), stalled(), cancelled]) {
      chain.outcomeSet!.attention = chain.outcomeSet!.completion ? [request()] : []
      expect(sessionRunRowState(chain, { now, archived: true })).toMatchObject({
        group: 'archived',
        settled: true,
        countsAsAttention: false,
        requests: []
      })
    }
  })
})

describe('a run in progress', () => {
  it('reads running attempts of the current plan as active and running', () => {
    expect(sessionRunRowState(conversationPlanFixture(), { now })).toMatchObject({
      phase: 'active',
      group: 'conversations',
      running: true,
      settled: false,
      countsAsAttention: false
    })
  })

  it('waits for the execution host instead of failing when contact is lost', () => {
    const chain = conversationPlanFixture()
    chain.outcomeSet!.continuation.state = 'unverifiable'
    expect(sessionRunRowState(chain, { now })).toMatchObject({
      phase: 'waiting',
      countsAsAttention: false,
      headline: 'Waiting for the execution host to reconnect'
    })
  })
})

it('keeps a running sibling Active while preserving an open owner request', () => {
  const chain = conversationPlanFixture()
  chain.outcomeSet!.attention = [request()]
  expect(sessionRunRowState(chain, { now })).toMatchObject({
    phase: 'needs-you',
    group: 'conversations',
    running: true,
    countsAsAttention: true
  })
  chain.outcomeSet!.continuation.state = 'unverifiable'
  expect(sessionRunRowState(chain, { now }).running).toBe(false)
})

it('does not count the asking worker itself as executing', () => {
  const chain = conversationPlanFixture()
  chain.outcomeSet!.attempts = [chain.outcomeSet!.attempts[0]!]
  chain.outcomeSet!.attention = [
    request({
      scope: { outcomeId: 'outcome', outcomeRevision: 1, attemptId: 'attempt1' }
    })
  ]
  expect(sessionRunRowState(chain, { now })).toMatchObject({
    phase: 'needs-you',
    group: 'attention',
    running: false,
    countsAsAttention: true
  })
})
