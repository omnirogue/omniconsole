// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat-types'
import { useSessionWorkLogAvailable } from './use-session-work-log-available'

const PANE = 'term:tab-1:pane-1'
const session = {
  rowKey: 'row-1',
  worktreeId: 'repo:/w',
  hostId: 'local',
  tabId: 'term:tab-1',
  paneKey: PANE,
  kind: 'terminal',
  label: 'Build',
  agent: 'gemini'
} as SidebarSession

const turn: NativeChatMessage[] = [
  {
    id: 'u',
    role: 'user',
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'Go' }]
  }
]

afterEach(() => {
  useAppStore.setState({ agentStatusByPaneKey: {} } as never)
})

describe('useSessionWorkLogAvailable', () => {
  it('is false for a row known only from its launch, and with no session', () => {
    expect(renderHook(() => useSessionWorkLogAvailable(session, [])).result.current).toBe(false)
    expect(renderHook(() => useSessionWorkLogAvailable(null, turn)).result.current).toBe(false)
  })

  it('makes no Work log of an idle session start (a boundary report)', () => {
    useAppStore.setState({
      agentStatusByPaneKey: {
        [PANE]: {
          paneKey: PANE,
          state: 'done',
          prompt: '',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: [],
          sessionBoundary: true
        } as AgentStatusEntry
      }
    } as never)
    expect(renderHook(() => useSessionWorkLogAvailable(session, [])).result.current).toBe(false)
  })

  it('is true once the session has a turn or live hook activity', () => {
    expect(renderHook(() => useSessionWorkLogAvailable(session, turn)).result.current).toBe(true)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [PANE]: {
          paneKey: PANE,
          state: 'done',
          prompt: 'Go',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: []
        } as AgentStatusEntry
      }
    } as never)
    expect(renderHook(() => useSessionWorkLogAvailable(session, [])).result.current).toBe(true)
  })
})
