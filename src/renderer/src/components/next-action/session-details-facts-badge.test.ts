import { describe, expect, it } from 'vitest'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import { agentBadgeState } from './session-details-facts'

const pty = { paneKey: 'tab-1:pane-1', unavailable: false }
const structured = {
  paneKey: null,
  unavailable: false,
  kind: 'structured' as const,
  tabId: structuredAgentSessionTabId('chat-1')
}

describe('agentBadgeState', () => {
  it('reads a structured chat by its own status, never as closed for lacking a pane', () => {
    expect(agentBadgeState(structured, { state: 'working' })).toBe('running')
    expect(agentBadgeState(structured, undefined)).toBe('idle')
  })

  it('stays closed for an unavailable row or one with no live identity at all', () => {
    expect(agentBadgeState({ ...pty, unavailable: true }, { state: 'working' })).toBe('closed')
    expect(agentBadgeState({ paneKey: null, unavailable: false }, undefined)).toBe('closed')
    expect(agentBadgeState(pty, { state: 'working' })).toBe('running')
  })
})
