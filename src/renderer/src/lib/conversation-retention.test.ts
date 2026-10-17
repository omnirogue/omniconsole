import {
  reviseSessionOutcomeSet,
  recordSessionOutcomeEvidence
} from '../../../shared/session-outcome-state'
import { sessionOutcomeConditionKey } from '../../../shared/session-outcome-types'
import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../../shared/session-chain-types'
import {
  classifyConversation,
  CONVERSATION_ARCHIVED_AFTER_MS,
  CONVERSATION_COMPLETED_AFTER_MS
} from './conversation-retention'
import { conversationPlanFixture } from './conversation-plan-fixture'

const now = 1_000_000_000
const fresh = {
  now,
  state: 'done' as const,
  waitingUntil: null,
  attention: false,
  unavailable: false
}

describe('a session the steward lists as Stalled', () => {
  it('shows beside Needs you until it works again or is put away', () => {
    expect(classifyConversation({ ...fresh, stateChangedAt: now, stalled: true }).group).toBe(
      'attention'
    )
    expect(
      classifyConversation({ ...fresh, state: 'working', stateChangedAt: now, stalled: true }).group
    ).toBe('conversations')
    expect(
      classifyConversation({ ...fresh, stateChangedAt: now, stalled: true, archived: true }).group
    ).toBe('archived')
    expect(classifyConversation({ ...fresh, stateChangedAt: now, stalled: false }).group).toBe(
      'completed'
    )
  })
})

describe('conversation retention', () => {
  it.each([
    0,
    9 * 60_000,
    CONVERSATION_COMPLETED_AFTER_MS,
    11 * 60_000,
    CONVERSATION_ARCHIVED_AFTER_MS,
    601 * 60_000
  ])('reads a finished turn as Done at age %s, never as a proven commitment', (age) => {
    // Why: age is not evidence of anything; the row is finished when its turn ended, and only
    // sessionArchiveProof (not this group) can let it leave the list by itself.
    expect(classifyConversation({ ...fresh, stateChangedAt: now - age })).toEqual({
      group: 'completed',
      completed: { reason: 'finished', at: now - age }
    })
  })
  it('treats missing and invalid timestamps as finished now', () => {
    for (const stateChangedAt of [undefined, 0, Number.NaN, Infinity]) {
      expect(classifyConversation({ ...fresh, stateChangedAt })).toEqual({
        group: 'completed',
        completed: { reason: 'finished', at: now }
      })
    }
    expect(classifyConversation({ ...fresh, stateChangedAt: now + 1 }).group).toBe('completed')
  })
  it('falls back to the retained start time, and a finished row on a lost host is still Done', () => {
    const input = {
      ...fresh,
      stateChangedAt: 0,
      retainedStartedAt: now - CONVERSATION_ARCHIVED_AFTER_MS
    }
    expect(classifyConversation(input)).toEqual({
      group: 'completed',
      completed: { reason: 'finished', at: now - CONVERSATION_ARCHIVED_AFTER_MS }
    })
    expect(classifyConversation({ ...input, unavailable: true }).group).toBe('completed')
  })
  it('keeps an unverifiable row in Waiting with a live plan on it', () => {
    const chain = { state: 'waiting', updatedAt: now, steps: [], currentIndex: 0 } as never
    expect(classifyConversation({ ...fresh, state: null, chain }).group).toBe('waiting')
    expect(classifyConversation({ ...fresh, state: null, chain, unavailable: true }).group).toBe(
      'waiting'
    )
  })
  it('never turns a legacy plan ending into a proven completion', () => {
    const input = { ...fresh, stateChangedAt: 0, firstSeenAt: now - 11 * 60_000 }
    expect(classifyConversation(input)).toEqual({
      group: 'completed',
      completed: { reason: 'finished', at: now - 11 * 60_000 }
    })
    expect(classifyConversation({ ...input, firstSeenAt: now - 60_000 }).completed?.at).toBe(
      now - 60_000
    )
    // Why: a legacy plan that ended is no seal; the row is finished, not "complete".
    const chain = { state: 'done', updatedAt: now - 11 * 60_000, steps: [], currentIndex: 0 }
    expect(classifyConversation({ ...input, firstSeenAt: now, chain: chain as never })).toEqual({
      group: 'completed',
      completed: { reason: 'finished', at: now }
    })
  })
  it('keeps missing observations unverified regardless of retained or first-seen age', () => {
    const retained = {
      ...fresh,
      state: null,
      stateChangedAt: 0,
      retainedStartedAt: now - 11 * 60_000
    }
    expect(classifyConversation(retained)).toEqual({
      group: 'waiting',
      completed: null
    })
    expect(classifyConversation({ ...retained, retainedStartedAt: undefined })).toEqual({
      group: 'waiting',
      completed: null
    })
    const done = { state: 'done', updatedAt: now - 11 * 60_000, steps: [], currentIndex: 0 }
    expect(
      classifyConversation({
        ...retained,
        retainedStartedAt: undefined,
        chain: done as never
      })
    ).toEqual({ group: 'waiting', completed: null })
  })
  it('prioritizes snooze, then attention, and keeps unfinished states active', () => {
    expect(classifyConversation({ ...fresh, waitingUntil: 'later', attention: true }).group).toBe(
      'waiting'
    )
    expect(classifyConversation({ ...fresh, attention: true }).group).toBe('attention')
    // Why: a plan waiting for a "Start next" click needs the person, so it never hides under Waiting.
    expect(
      classifyConversation({
        ...fresh,
        chain: { state: 'ready', steps: [], updatedAt: 1 } as unknown as SessionChain
      }).group
    ).toBe('attention')
    for (const [state, group] of [
      ['working', 'conversations'],
      ['idle', 'completed'],
      ['failed', 'stopped'],
      ['interrupted', 'stopped'],
      [null, 'waiting']
    ] as const) {
      expect(classifyConversation({ ...fresh, state, stateChangedAt: 1 }).group).toBe(group)
    }
  })
  it('keeps a lost host, a live monitor and a pending launch in Waiting: each has a wake', () => {
    expect(classifyConversation({ ...fresh, state: 'idle', unavailable: true }).group).toBe(
      'waiting'
    )
    expect(classifyConversation({ ...fresh, state: 'monitoring' }).group).toBe('waiting')
    expect(classifyConversation({ ...fresh, state: null, launchPending: true }).group).toBe(
      'waiting'
    )
  })
})

describe('plans that need the person', () => {
  const chain = (patch: object) =>
    ({ state: 'waiting', updatedAt: now, steps: [], currentIndex: 0, ...patch }) as never
  it('puts a plan parked on a question under Needs you, ahead of Waiting', () => {
    expect(
      classifyConversation({
        ...fresh,
        state: null,
        chain: chain({ blocked: { paneKey: 'p', reason: 'waiting' } })
      }).group
    ).toBe('attention')
    expect(classifyConversation({ ...fresh, state: null, chain: chain({}) }).group).toBe('waiting')
  })
  it('keeps a failed plan in plain sight and out of Needs you', () => {
    // Why: a plan that could not go on is an honest failure; nobody was asked anything.
    const failed = chain({ state: 'failed', updatedAt: now - 1_000 })
    expect(classifyConversation({ ...fresh, state: 'failed', chain: failed }).group).toBe('stopped')
    expect(
      classifyConversation({ ...fresh, state: 'failed', stateChangedAt: now, chain: failed }).group
    ).toBe('stopped')
    expect(
      classifyConversation({
        ...fresh,
        state: 'failed',
        stateChangedAt: now,
        working: true,
        chain: failed
      }).group
    ).toBe('conversations')
  })
  it('never lets a snooze be overruled by a parked plan', () => {
    expect(
      classifyConversation({
        ...fresh,
        waitingUntil: '2099-01-01T00:00:00.000Z',
        chain: chain({ blocked: { paneKey: 'p', reason: 'waiting' } })
      }).group
    ).toBe('waiting')
  })
})

it.each([
  [true, false, 'conversations'],
  [false, true, 'attention']
] as const)(
  'surfaces fresh work or a question after an outcome was completed (%s, %s)',
  (working, attention, group) => {
    const condition = {
      id: 'file',
      kind: 'file' as const,
      target: '/result.txt',
      version: 'a'.repeat(64)
    }
    const committed = reviseSessionOutcomeSet(
      undefined,
      {
        expectedRevision: 0,
        source: 'user',
        outcomes: [
          {
            id: 'result',
            title: 'Save report',
            finish: 'complete',
            dependsOn: [],
            conditions: [condition],
            actions: []
          }
        ]
      },
      { owner: 'execution-host', hostId: 'local', epoch: 'host1', state: 'owned' },
      now - 1000
    )
    const outcomeSet = recordSessionOutcomeEvidence(committed, {
      id: 'receipt',
      outcomeId: 'result',
      outcomeRevision: 1,
      conditionId: condition.id,
      conditionKey: sessionOutcomeConditionKey(condition),
      kind: condition.kind,
      target: condition.target,
      version: condition.version,
      receipt: `sha256:${condition.version}`,
      verifiedAt: now - 500,
      verifier: 'execution-host'
    })
    const chain = { outcomeSet } as SessionChain
    expect(
      classifyConversation({ ...fresh, chain, working, attention, stateChangedAt: now }).group
    ).toBe(group)
  }
)

describe('outcome plans read the one run policy', () => {
  const STALL = 'No activity was observed for 180s. The worker may have stalled.'
  const plan = { ...fresh, state: null, stateChangedAt: 1 }
  function stalled(): SessionChain {
    const chain = conversationPlanFixture()
    chain.outcomeSet!.attempts = []
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.outcomes[0]!.blockedReason = STALL
    return chain
  }
  function asking(): SessionChain {
    const chain = stalled()
    chain.outcomeSet!.attention = [
      {
        id: 'att_review-findings_outcome_1',
        kind: 'decision',
        scope: { outcomeId: 'outcome', outcomeRevision: 1 },
        ask: 'Decide what happens to 2 open review findings.',
        why: 'All 2 authorized review rounds are used; another one needs your say.',
        recipient: { type: 'owner' },
        action: { kind: 'open-up-next', label: 'Decide' },
        source: { type: 'review-findings', ref: 'rounds:2' },
        state: 'open',
        openedAt: 5
      }
    ]
    return chain
  }

  it('never puts a blocked, failed, unowned or silent run under Needs you', () => {
    expect(classifyConversation({ ...plan, chain: stalled() }).group).toBe('stopped')
    const unowned = conversationPlanFixture()
    unowned.outcomeSet!.continuation.state = 'unverifiable'
    expect(classifyConversation({ ...plan, chain: unowned }).group).toBe('waiting')
    // Why: a worker pane that merely stopped is part of the run, not a question for the person.
    const ready = stalled()
    ready.outcomeSet!.continuation.sourceReady = true
    expect(classifyConversation({ ...plan, attention: true, chain: ready }).group).toBe('stopped')
  })

  it('puts a run with an open request under Needs you, and a snooze still outranks it', () => {
    expect(classifyConversation({ ...plan, chain: asking() }).group).toBe('attention')
    expect(
      classifyConversation({ ...plan, waitingUntil: '2099-01-01T00:00:00.000Z', chain: asking() })
        .group
    ).toBe('waiting')
  })

  it('keeps an idle conversation in Waiting while its plan waits on an event', () => {
    // Why (conversational waits): the pane sits at its prompt for hours while the host polls
    // Slack; an unavailable follow-up is the honest "we cannot check this" state and still waits.
    for (const code of ['event-wait', 'event-wait-unavailable']) {
      const chain = stalled()
      chain.outcomeSet!.outcomes[0]!.blockedReason = undefined
      chain.outcomeSet!.outcomes[0]!.block = {
        class: 'waiting',
        code,
        since: 1,
        wake: code === 'event-wait' ? 'Sal Baker ○ on Slack' : 'Follow-up not scheduled: no Slack'
      }
      expect(classifyConversation({ ...plan, state: 'idle', chain }).group).toBe('waiting')
      expect(classifyConversation({ ...plan, state: 'done', chain }).group).toBe('waiting')
    }
  })

  it('reads an unproven legacy seal as finished through a lost host and a stale blocked attempt', () => {
    const chain = asking()
    chain.outcomeSet!.completion = {
      at: now - 5_000,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    chain.outcomeSet!.continuation.state = 'unverifiable'
    // Why: sealed success is final and this seal waits on nobody; without every receipt it is
    // "finished", never "complete", and it stays out of the automatic archive.
    expect(classifyConversation({ ...plan, chain })).toMatchObject({
      group: 'completed',
      completed: { reason: 'finished' }
    })
    // Why: a pane state older than the seal is the finished run's own late heartbeat.
    expect(
      classifyConversation({
        ...plan,
        chain,
        working: true,
        attention: true,
        stateChangedAt: now - 6_000
      }).group
    ).toBe('completed')
    expect(classifyConversation({ ...plan, chain, archived: true })).toMatchObject({
      group: 'archived',
      completed: { reason: 'finished' }
    })
  })

  function sealed(
    conditions: {
      id: string
      kind: 'pr' | 'handoff' | 'review'
      target: string
      version?: string
    }[],
    receipts: string[]
  ): SessionChain {
    const chain = conversationPlanFixture()
    chain.state = 'done'
    const set = chain.outcomeSet!
    set.attempts = []
    const outcome = set.outcomes[0]!
    outcome.conditions = conditions
    outcome.evidence = receipts.map((receipt, index) => {
      const condition = conditions[index]!
      return {
        id: `evidence_${index}`,
        outcomeId: outcome.id,
        outcomeRevision: outcome.revision,
        conditionId: condition.id,
        conditionKey: sessionOutcomeConditionKey(condition),
        kind: condition.kind,
        target: condition.target,
        receipt,
        verifiedAt: now - 600,
        verifier: 'execution-host'
      }
    })
    set.completion = {
      at: now - 500,
      outcomes: [{ id: outcome.id, revision: outcome.revision }],
      evidenceIds: []
    }
    return chain
  }

  it('keeps a sealed run in Waiting while its PR is open, its reviewer objects or a handoff is out', () => {
    expect(
      classifyConversation({
        ...plan,
        chain: sealed(
          [{ id: 'pr', kind: 'pr', target: 'https://github.com/x/y/pull/1' }],
          ['pr:1:open']
        )
      }).group
    ).toBe('waiting')
    expect(
      classifyConversation({
        ...plan,
        chain: sealed([{ id: 'handoff', kind: 'handoff', target: 'hth_12345678' }], [])
      }).group
    ).toBe('waiting')
  })

  it("reads the owner's own review receipt as finished, not as a wait or a question", () => {
    // Why (Sal, 2026-09-19): the owner's review is where finished work goes, not a question.
    expect(
      classifyConversation({
        ...plan,
        chain: sealed(
          [{ id: 'review', kind: 'review', target: 'review', version: 'v1' }],
          ['done-for-review:v1']
        )
      })
    ).toMatchObject({ group: 'completed', completed: { reason: 'finished' } })
  })

  it('reads an unproven Back to me ending as Done, finished, without asking about it', () => {
    // Why: "Me" means keep the session open in Done for the person; the ending waits on nobody.
    const chain = conversationPlanFixture()
    chain.state = 'done'
    chain.end = 'me'
    expect(classifyConversation({ ...plan, chain })).toMatchObject({
      group: 'completed',
      completed: { reason: 'finished' }
    })
  })

  it('gives a cancelled plan back to the conversation it started from', () => {
    const chain = asking()
    chain.state = 'cancelled'
    expect(classifyConversation({ ...plan, state: 'working', chain }).group).toBe('conversations')
    expect(classifyConversation({ ...plan, chain, archived: true }).group).toBe('archived')
  })
})
