// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { conversationViewKey } from '@/lib/conversation-view'
import { buildSidebarSessions, type SidebarSession } from '@/lib/sidebar-sessions'
import {
  selectOnScreenSessionLeafId,
  selectOnScreenSessionTabId
} from '@/lib/sidebar-session-on-screen'
import { onScreenTestWorkspace } from '@/lib/sidebar-session-on-screen-test-fixtures'
import { useSessionSelection } from '@/store/session-selection'
import { useSelectionFollowsScreen } from './use-selection-follows-screen'

function screenFor(front: string) {
  const state = onScreenTestWorkspace(front)
  return {
    sessions: buildSidebarSessions(state),
    screen: {
      worktreeId: state.activeWorktreeId ?? null,
      tabId: selectOnScreenSessionTabId(state),
      leafId: selectOnScreenSessionLeafId(state)
    }
  }
}

function keyOf(sessions: readonly SidebarSession[], tabId: string): string {
  return conversationViewKey(sessions.find((session) => session.tabId === tabId)!)
}

function renderFollow(front: string) {
  const initial = screenFor(front)
  const hook = renderHook(({ sessions, screen }) => useSelectionFollowsScreen(sessions, screen), {
    initialProps: initial
  })
  return { ...hook, sessions: initial.sessions }
}

beforeEach(() => {
  useSessionSelection.getState().set([])
})

afterEach(cleanup)

describe('the checkmark follows the main screen', () => {
  it('checks only the on-screen row, and moves with the next activation', () => {
    const { rerender, sessions, result } = renderFollow('unified-a')
    expect(result.current).toBe(keyOf(sessions, 'tab-a'))
    expect(useSessionSelection.getState().keys).toEqual([keyOf(sessions, 'tab-a')])
    expect(useSessionSelection.getState().explicit).toBe(false)

    rerender(screenFor('chat-1'))

    const selection = useSessionSelection.getState()
    expect(selection.keys).toEqual([keyOf(sessions, 'chat-1')])
    expect(selection.anchor).toBe(keyOf(sessions, 'chat-1'))
    expect(selection.focus).toBe(keyOf(sessions, 'chat-1'))
    expect(selection.explicit).toBe(false)
  })

  it('leaves a deliberate multi-select alone when the screen changes', () => {
    const { rerender, sessions } = renderFollow('unified-a')
    const batch = [keyOf(sessions, 'tab-a'), keyOf(sessions, 'tab-b')]
    useSessionSelection.getState().set(batch)

    rerender(screenFor('chat-1'))

    expect(useSessionSelection.getState().keys).toEqual(batch)
    expect(useSessionSelection.getState().explicit).toBe(true)
  })

  it('keeps the selection when nothing conversational is on screen', () => {
    const { rerender, sessions } = renderFollow('unified-b')
    rerender(screenFor('/repo/readme.md'))
    expect(useSessionSelection.getState().keys).toEqual([keyOf(sessions, 'tab-b')])
  })
})
