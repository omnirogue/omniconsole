import { describe, expect, it, vi } from 'vitest'
import { conversationPlanFixture } from '@/lib/conversation-plan-fixture'
import type { HumanAttentionRequest } from '../../../../shared/session-human-attention'
import type { AgentPaneSnapshot, AttentionPane } from './agent-pane-snapshot'
import { withRunAttention } from './run-attention-panes'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (message, [key, value]) => message.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const now = 1_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const SOURCE = `source:${LEAF}`
const WORKER = `worker-task1:${LEAF}`
const OTHER = `other:${LEAF}`

function pane(paneKey: string, stateChangedAt = 5): AttentionPane {
  return {
    paneKey,
    portalPaneKey: paneKey,
    worktreeId: 'folder:1',
    tabId: paneKey.split(':')[0]!,
    leafId: LEAF,
    agentType: 'claude',
    bucket: 'attention',
    dotState: 'waiting',
    cause: 'waiting',
    unseen: true,
    title: paneKey,
    stateChangedAt,
    repoName: 'W',
    worktreeName: 'main'
  }
}

function snapshot(panes: AttentionPane[]): AgentPaneSnapshot {
  return {
    cards: panes,
    cardsByPaneKey: new Map(panes.map((entry) => [entry.paneKey, entry])),
    cardsByTabId: new Map(),
    attention: panes,
    attentionByPaneKey: new Map(panes.map((entry) => [entry.paneKey, entry])),
    attentionWorktreeIds: new Set(panes.map((entry) => entry.worktreeId))
  }
}

function plan() {
  const chain = conversationPlanFixture()
  chain.sourcePaneKey = SOURCE
  chain.outcomeSet!.continuation.sourceReady = true
  return chain
}

function request(patch: Partial<HumanAttentionRequest> = {}): HumanAttentionRequest {
  return {
    id: 'att_agent-prompt_attempt1_1',
    kind: 'clarification',
    scope: { outcomeId: 'outcome', outcomeRevision: 1, attemptId: 'attempt1' },
    ask: "Answer claude's question: which branch?",
    why: 'claude cannot choose this for you and is waiting for your answer.',
    recipient: { type: 'owner' },
    action: { kind: 'open-conversation', label: 'Answer', paneKey: WORKER },
    source: { type: 'agent-prompt', ref: 'which branch?' },
    state: 'open',
    openedAt: 7,
    ...patch
  }
}

describe('withRunAttention', () => {
  it('returns the same snapshot when no run is pursued', () => {
    const before = snapshot([pane(OTHER)])
    expect(withRunAttention(before, [], new Set(), now)).toBe(before)
    const { outcomeSet: _none, ...queue } = plan()
    expect(withRunAttention(before, [queue], new Set(), now)).toBe(before)
  })

  it("drops a run's stopped, idle or stalled panes and keeps an ordinary pane's own prompt", () => {
    const chain = plan()
    chain.outcomeSet!.attempts.forEach((attempt) => {
      attempt.state = 'blocked'
      attempt.error = 'No activity was observed for 180s.'
    })
    chain.outcomeSet!.outcomes[0]!.status = 'blocked'
    chain.outcomeSet!.outcomes[0]!.blockedReason = 'No activity was observed for 180s.'
    const after = withRunAttention(
      snapshot([pane(SOURCE), pane(WORKER), pane(OTHER)]),
      [chain],
      new Set(),
      now
    )
    expect(after.attention.map((entry) => entry.paneKey)).toEqual([OTHER])
    expect([...after.attentionByPaneKey.keys()]).toEqual([OTHER])
    expect(after.cards).toHaveLength(3)
  })

  it("lists a run's open request once, as the ask, in place of the pane that carries it", () => {
    const chain = plan()
    chain.outcomeSet!.attention = [request()]
    const after = withRunAttention(snapshot([pane(WORKER), pane(OTHER)]), [chain], new Set(), now)
    expect(after.attention.map((entry) => entry.paneKey)).toEqual([OTHER, WORKER])
    const asked = after.attentionByPaneKey.get(WORKER)!
    expect(asked.run).toMatchObject({
      chainId: 'chain',
      sourceRowKey: 'source',
      headline: "Needs you: Answer claude's question: which branch?",
      why: 'claude cannot choose this for you and is waiting for your answer.'
    })
    expect(asked.stateChangedAt).toBe(7)
    // Why: a reconnect or a re-render reads the same record, so the count cannot move.
    chain.outcomeSet!.continuation.state = 'unverifiable'
    expect(
      withRunAttention(snapshot([pane(WORKER), pane(OTHER)]), [chain], new Set(), now + 60_000)
        .attention
    ).toHaveLength(2)
  })

  it('still lists a request whose conversation has no live pane', () => {
    const chain = plan()
    chain.outcomeSet!.attention = [
      request({
        scope: { outcomeId: 'outcome', outcomeRevision: 1 },
        action: { kind: 'open-up-next', label: 'Decide' }
      })
    ]
    const after = withRunAttention(snapshot([]), [chain], new Set(), now)
    expect(after.attention).toHaveLength(1)
    expect(after.attention[0]).toMatchObject({
      paneKey: SOURCE,
      tabId: 'source',
      worktreeId: 'folder:1',
      cause: 'blocked',
      portalPaneKey: SOURCE
    })
  })

  it("lists nothing for a snoozed run, another person's request, or a sealed run", () => {
    const snoozed = plan()
    snoozed.outcomeSet!.attention = [request()]
    expect(
      withRunAttention(snapshot([]), [snoozed], new Set([`pane:${SOURCE}`]), now).attention
    ).toEqual([])

    const theirs = plan()
    theirs.outcomeSet!.attention = [
      request({ recipient: { type: 'person', employeeId: 'emp_uma', name: 'Uma' } })
    ]
    expect(withRunAttention(snapshot([pane(WORKER)]), [theirs], new Set(), now).attention).toEqual(
      []
    )

    const sealed = plan()
    sealed.outcomeSet!.attention = [request()]
    sealed.outcomeSet!.completion = {
      at: 50,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
    sealed.outcomeSet!.continuation.state = 'unverifiable'
    // Why: a pane state older than the seal is the finished run's own; a newer one is the
    // conversation's again, and is an ordinary prompt like any other.
    const late = withRunAttention(snapshot([pane(WORKER, 40)]), [sealed], new Set(), now)
    expect(late.attention).toEqual([])
    const fresh = withRunAttention(snapshot([pane(SOURCE, 60)]), [sealed], new Set(), now)
    expect(fresh.attention.map((entry) => [entry.paneKey, entry.run])).toEqual([
      [SOURCE, undefined]
    ])
  })

  it("leaves the source conversation's own question alone until the run owns that source", () => {
    const chain = plan()
    chain.outcomeSet!.continuation.sourceReady = false
    const after = withRunAttention(snapshot([pane(SOURCE)]), [chain], new Set(), now)
    expect(after.attention.map((entry) => entry.paneKey)).toEqual([SOURCE])
  })
})
