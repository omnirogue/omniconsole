import { describe, expect, it } from 'vitest'
import type { ConversationSource } from '../../shared/conversation-source'
import type { SessionChain } from '../../shared/session-chain-types'
import { conversationPlanWaits } from './conversation-chain-ownership'

const source = { kind: 'pty', paneKey: 'tab:leaf', worktreeId: 'wt' } as ConversationSource
const checkedAt = Date.parse('2026-09-24T21:00:00Z')

function chain(overrides: Partial<SessionChain> = {}): SessionChain {
  return {
    id: 'c',
    state: 'waiting',
    sourcePaneKey: 'tab:leaf',
    worktreeId: 'wt',
    steps: [],
    currentIndex: 0,
    outcomeSet: {
      continuation: { state: 'owned' },
      outcomes: [
        {
          id: 'wait',
          revision: 1,
          status: 'blocked',
          blocked: { class: 'waiting', code: 'event-wait', since: checkedAt },
          dependsOn: [],
          actions: [],
          conditions: [
            {
              id: 'sal',
              kind: 'event',
              label: 'Sal approves on Slack',
              target: 'Sal approves on Slack',
              event: { source: 'slack', match: 'approve', personId: 'emp_sal' }
            },
            {
              id: 'pr',
              kind: 'event',
              label: 'PR 12 merges',
              target: 'PR 12 merges',
              event: { source: 'github', match: 'merged', ref: 'https://github.com/o/r/pull/12' }
            }
          ],
          evidence: [{ conditionId: 'pr', outcomeRevision: 1 }],
          waits: [{ conditionId: 'sal', status: 'unavailable', checkedAt }]
        }
      ]
    },
    ...overrides
  } as unknown as SessionChain
}

describe('conversationPlanWaits', () => {
  it("lists only the unmet waits of this conversation's live plan", () => {
    expect(conversationPlanWaits([chain()], source)).toEqual([
      'Sal approves on Slack (follow-up not scheduled, checked 2026-09-24T21:00:00.000Z)'
    ])
  })

  it('reads nothing from another conversation or a plan that ended', () => {
    expect(conversationPlanWaits([chain({ sourcePaneKey: 'other:leaf' })], source)).toEqual([])
    expect(conversationPlanWaits([chain({ state: 'cancelled' })], source)).toEqual([])
  })
})
