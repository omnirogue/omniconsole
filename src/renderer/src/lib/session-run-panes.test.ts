import { describe, expect, it } from 'vitest'
import { conversationPlanFixture } from './conversation-plan-fixture'
import { sessionRunAsksThroughPane, sessionRunPaneRole } from './session-run-panes'

const now = 1_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'

function asking() {
  const chain = conversationPlanFixture()
  chain.sourcePaneKey = `source:${LEAF}`
  chain.outcomeSet!.attention = [
    {
      id: 'att_agent-prompt_attempt1_1',
      kind: 'permission',
      scope: { outcomeId: 'outcome', outcomeRevision: 1, attemptId: 'attempt1' },
      ask: 'Allow or deny what claude is asking to do: edit package.json',
      why: 'claude stopped at a permission prompt that only you may answer.',
      recipient: { type: 'owner' },
      source: { type: 'agent-prompt', ref: 'edit package.json' },
      state: 'open',
      openedAt: 5
    }
  ]
  return chain
}

describe('sessionRunPaneRole', () => {
  it("knows a run's workers by their dispatch tab or launched pane, and its source", () => {
    const chain = asking()
    expect(sessionRunPaneRole(chain, { paneKey: `worker-task1:${LEAF}` })).toBe('worker')
    expect(sessionRunPaneRole(chain, { paneKey: 'x', tabId: 'worker-task2' })).toBe('worker')
    expect(sessionRunPaneRole(chain, { paneKey: `source:${LEAF}` })).toBe('source')
    expect(sessionRunPaneRole(chain, { paneKey: `other:${LEAF}` })).toBeNull()
    const { outcomeSet: _none, ...queue } = chain
    expect(sessionRunPaneRole(queue, { paneKey: `source:${LEAF}` })).toBeNull()
  })
})

describe('sessionRunAsksThroughPane', () => {
  it('is true only for a pane of a run that holds an open request for its owner', () => {
    const chain = asking()
    expect(sessionRunAsksThroughPane([chain], `worker-task1:${LEAF}`, now)).toBe(true)
    expect(sessionRunAsksThroughPane([chain], `other:${LEAF}`, now)).toBe(false)
    chain.outcomeSet!.attention![0]!.state = 'resolved'
    expect(sessionRunAsksThroughPane([chain], `worker-task1:${LEAF}`, now)).toBe(false)
  })
})
