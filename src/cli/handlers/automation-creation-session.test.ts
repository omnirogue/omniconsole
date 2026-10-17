import { expect, it } from 'vitest'
import { automationCreationSession } from './automation-creation-session'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'

it('uses the creating structured session without binding a routine conversation', () => {
  expect(
    automationCreationSession({
      ORCA_AGENT_SESSION_ID: 'session',
      ORCA_PANE_KEY: structuredAgentSessionPaneKey(
        structuredAgentSessionTabId('session'),
        'session'
      ),
      ORCA_TAB_ID: 'inherited-terminal'
    })
  ).toEqual({
    tabId: structuredAgentSessionTabId('session'),
    paneKey: null
  })
})
it('retains ordinary terminal context and leaves standalone creates without provenance', () => {
  expect(automationCreationSession({ ORCA_TAB_ID: 'tab' })).toEqual({ tabId: 'tab', paneKey: null })
  expect(automationCreationSession({})).toBeUndefined()
})
