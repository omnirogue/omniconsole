import { describe, expect, it, vi } from 'vitest'
import {
  conversationPlanLabel,
  conversationPlanProgress,
  conversationState,
  conversationStateRank,
  fallbackConversationTitle,
  isPlaceholderConversationTitle
} from './conversation-state'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

describe('conversation state', () => {
  it('reads attention, work and waiting the way a person does', () => {
    expect(conversationState({ state: 'working', needsYou: false, waiting: false })).toBe('working')
    expect(conversationState({ state: 'blocked', needsYou: false, waiting: false })).toBe(
      'needs-you'
    )
    expect(conversationState({ state: 'working', needsYou: true, waiting: false })).toBe(
      'needs-you'
    )
    // Why: a waiting conversation is out of sight even when it needs someone; it returns later.
    expect(conversationState({ state: 'waiting', needsYou: true, waiting: true })).toBe('waiting')
    expect(conversationState({ state: 'idle', needsYou: false, waiting: false })).toBe('inactive')
    expect(conversationState({ state: 'done', needsYou: false, waiting: false })).toBe('done')
    // Why: a permission prompt is a question for the person, the same as blocked.
    expect(conversationState({ state: 'permission', needsYou: false, waiting: false })).toBe(
      'needs-you'
    )
    expect(conversationState({ state: null, needsYou: false, waiting: false })).toBe('none')
  })

  it('ranks needs-you above working above active, and waiting last', () => {
    const ranks = (
      ['needs-you', 'working', 'active', 'failed', 'done', 'none', 'waiting'] as const
    ).map(conversationStateRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
  })

  it('never lets "Terminal 3" be a name', () => {
    expect(isPlaceholderConversationTitle('Terminal 3')).toBe(true)
    expect(isPlaceholderConversationTitle('  ')).toBe(true)
    expect(isPlaceholderConversationTitle('Fix OmniConsole handoffs')).toBe(false)
    expect(fallbackConversationTitle('Claude')).toBe('Claude conversation')
  })
})

import { conversationPlanFixture } from './conversation-plan-fixture'
import { conversationPlanHistory } from './conversation-plan-history'

const now = 1_000_000_000

describe('pursuit rows', () => {
  it('pins attention, running, recovering, failed, ready and done rank order', () => {
    expect(
      (['done', 'plan-ready', 'failed', 'recovering', 'running', 'needs-you'] as const).toSorted(
        (a, b) => conversationStateRank(a) - conversationStateRank(b)
      )
    ).toMatchInlineSnapshot(`
        [
          "needs-you",
          "running",
          "recovering",
          "failed",
          "plan-ready",
          "done",
        ]
      `)
  })

  it('uses running attempts and compiled node ids, never authored groups', () => {
    const chain = conversationPlanFixture()
    const verify = chain.steps[2]!
    if (verify.kind === 'handoff') {
      throw new Error('Expected agent seat')
    }
    verify.planNodeId = 'verify'
    expect(conversationState({ chain, state: 'done', waiting: false, needsYou: false })).toBe(
      'running'
    )
    expect(conversationPlanProgress(chain)).toEqual({
      satisfied: 0,
      total: 1,
      stage: 1,
      stages: 2,
      running: 2
    })
    expect(conversationPlanLabel(chain)).toContain('0/1 done-when · stage 1/2')
  })

  it('counts only current revision receipts, never completed attempts', () => {
    const chain = conversationPlanFixture()
    const outcome = chain.outcomeSet!.outcomes[0]!
    outcome.evidence = [
      {
        id: 'receipt',
        outcomeId: outcome.id,
        conditionId: 'file',
        outcomeRevision: 1,
        conditionKey: 'file',
        kind: 'file',
        target: 'plan.json',
        receipt: 'sha256:proof',
        verifiedAt: 2,
        verifier: 'execution-host',
        planVersion: 1
      }
    ]
    expect(conversationPlanProgress(chain).satisfied).toBe(1)
    outcome.revision = 2
    chain.outcomeSet!.attempts.forEach((attempt) => {
      attempt.state = 'completed'
    })
    expect(conversationPlanProgress(chain).satisfied).toBe(0)
  })

  it('keeps superseded work as versioned history without requesting attention', () => {
    const chain = conversationPlanFixture()
    chain.planVersion = 2
    chain.planVersions = [{ version: 2, supersedes: 1, reason: 'Try independent research', at: 3 }]
    chain.outcomeSet!.attempts.forEach((attempt) => {
      attempt.state = 'superseded'
    })
    const first = chain.steps[0]!
    if (first.kind === 'handoff') {
      throw new Error('Expected agent seat')
    }
    chain.steps.push({ ...first, id: 'v2', planVersion: 2 })
    chain.outcomeSet!.attempts.push({
      ...chain.outcomeSet!.attempts[0]!,
      id: 'a2',
      actionId: 'step_v2',
      planVersion: undefined,
      state: 'running'
    })
    expect(conversationState({ chain, state: 'failed', waiting: false, needsYou: false })).toBe(
      'running'
    )
    expect(conversationPlanLabel(chain)).toContain(
      'Plan v2 · v1 superseded: Try independent research'
    )
    const history = conversationPlanHistory(
      chain,
      new Map([['s1', ['.omni/runs/chain/s1/plan.json']]])
    )
    expect(
      history.map((version) => [
        version.version,
        version.steps.length,
        version.attempts.length,
        version.files.length
      ])
    ).toEqual([
      [2, 1, 1, 0],
      [1, 3, 3, 1]
    ])
  })

  it('derives queued, failed, plan-ready and done from the authoritative chain', () => {
    const chain = conversationPlanFixture()
    const read = () =>
      conversationState({ chain, state: 'working' as const, waiting: false, needsYou: false, now })
    chain.outcomeSet!.attempts = []
    expect(read()).toBe('queued')
    // Why: a blocked outcome no writer classified is an honest failure, never a question.
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.outcomes[0]!.blockedReason = 'No activity was observed for 180s.'
    expect(read()).toBe('failed')
    chain.outcomeSet!.outcomes[0]!.status = 'pending'
    chain.outcomeSet!.outcomes[0]!.conditions = []
    expect(read()).toBe('plan-ready')
    chain.outcomeSet!.outcomes[0]!.outputKind = 'work'
    chain.state = 'done'
    expect(read()).toBe('done')
  })

  it("reads recovering and waiting blocks as what the host is doing, not as the person's move", () => {
    const chain = conversationPlanFixture()
    const read = () =>
      conversationState({ chain, state: 'waiting' as const, waiting: false, needsYou: true, now })
    chain.outcomeSet!.attempts = []
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.outcomes[0]!.block = {
      class: 'recovering',
      code: 'dispatch-stall',
      since: now - 1_000,
      until: now + 30_000
    }
    // Why: `needsYou` is a pane's own prompt; a plan row ignores it and reads its run.
    expect(read()).toBe('recovering')
    chain.outcomeSet!.outcomes[0]!.block = { class: 'waiting', code: 'evidence-poll', since: 1 }
    expect(read()).toBe('awaiting')
    chain.outcomeSet!.continuation.state = 'unverifiable'
    expect(read()).toBe('awaiting')
  })

  it('needs the person only for an open request addressed to them', () => {
    const chain = conversationPlanFixture()
    const read = () =>
      conversationState({ chain, state: 'working' as const, waiting: false, needsYou: false, now })
    chain.outcomeSet!.attention = [
      {
        id: 'att_review-condition_file_1',
        kind: 'review',
        scope: { outcomeId: 'outcome', outcomeRevision: 1, conditionId: 'file' },
        ask: 'Review the result of "Plan the work" and approve it or send it back.',
        why: 'This outcome is finished only by your own review; nobody else can give it.',
        recipient: { type: 'owner' },
        action: { kind: 'review-outcome', label: 'Review', conditionId: 'file' },
        source: { type: 'review-condition', ref: 'file' },
        state: 'open',
        openedAt: 5
      }
    ]
    expect(read()).toBe('needs-you')
    chain.outcomeSet!.attention[0]!.recipient = { type: 'person', employeeId: 'emp_uma' }
    expect(read()).toBe('running')
  })

  it('reads a finished plan as done, even one that ended Back to me', () => {
    const chain = conversationPlanFixture()
    chain.state = 'done'
    chain.end = 'me'
    expect(conversationState({ chain, state: 'done', waiting: false, needsYou: false, now })).toBe(
      'done'
    )
    // Why: a sealed run stays complete through a lost host and a stale blocked attempt.
    chain.state = 'waiting'
    chain.outcomeSet!.completion = {
      at: 50,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    chain.outcomeSet!.continuation.state = 'unverifiable'
    chain.outcomeSet!.attempts[0]!.state = 'blocked'
    expect(
      conversationState({ chain, state: 'blocked', waiting: false, needsYou: true, now })
    ).toBe('done')
  })

  it("gives a cancelled plan's conversation back to its own pane state", () => {
    const chain = conversationPlanFixture()
    chain.state = 'cancelled'
    expect(
      conversationState({ chain, state: 'working', waiting: false, needsYou: false, now })
    ).toBe('working')
  })
})
