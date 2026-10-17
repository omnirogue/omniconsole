// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../shared/structured-agent-session-projection'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { SessionRowHoverCardBody } from './SessionRowHoverCard'

const initialState = useAppStore.getInitialState()
const SESSION_ID = 'sess-live-1'
const TAB_ID = structuredAgentSessionTabId(SESSION_ID)
const CHAT_PANE = structuredAgentSessionPaneKey(TAB_ID, SESSION_ID)

function status(paneKey: string, extra: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    paneKey,
    stateHistory: [],
    ...extra
  }
}

/** A structured chat row: its live status lives under the structured pane key, not `paneKey`. */
const chatSession: SidebarSession = {
  rowKey: JSON.stringify(['local', TAB_ID]),
  sessionKey: 'structured:local:sess-live-1',
  worktreeId: 'repo::main',
  hostId: 'local',
  tabId: TAB_ID,
  paneKey: null,
  kind: 'structured',
  label: 'Ship the hover card',
  workspaceLabel: 'main',
  agent: 'claude',
  unavailable: false,
  folderKeyMigration: null
}

describe('SessionRowHoverCardBody', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('shows a live chat session its own agent, model and team', () => {
    useAppStore.setState({
      agentStatusByPaneKey: {
        [CHAT_PANE]: status(CHAT_PANE, {
          agentType: 'claude',
          model: 'opus-5',
          subagents: [
            {
              id: 'sa1',
              agentType: 'Explore',
              model: 'haiku',
              state: 'working',
              startedAt: 1,
              description: 'scan repo'
            }
          ]
        }),
        'tab-w:leaf-1': status('tab-w:leaf-1', {
          agentType: 'codex',
          orchestration: {
            taskId: 't',
            dispatchId: 'd',
            parentPaneKey: CHAT_PANE,
            displayName: 'Fix tests'
          }
        })
      }
    })

    const { container } = render(<SessionRowHoverCardBody session={chatSession} chainId={null} />)

    expect(container.textContent).toContain('opus-5')
    expect(container.textContent).toContain('Fix tests')
    expect(container.textContent).toContain('scan repo')
    expect(container.textContent).not.toContain('Working alone')
  })
})
