// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { setNativeChatLeaf, useNativeChatLeafState } from './native-chat-leaf-state'
import { useNativeChatToggleShortcut } from './use-native-chat-toggle-shortcut'

const mocks = vi.hoisted(() => ({ state: {} as AppState, switchView: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('./switch-native-chat-view', () => ({ switchNativeChatView: mocks.switchView }))
const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

beforeEach(() => {
  mocks.state = {
    settings: { experimentalNativeChat: true },
    activeGroupIdByWorktree: { wt: 'group' },
    groupsByWorktree: { wt: [{ id: 'group', activeTabId: 'unified' }] },
    unifiedTabsByWorktree: {
      wt: [{ id: 'unified', entityId: 'terminal', contentType: 'terminal', viewMode: 'chat' }]
    },
    tabsByWorktree: { wt: [{ id: 'terminal', title: 'Terminal' }] },
    terminalLayoutsByTabId: {
      terminal: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: first },
          second: { type: 'leaf', leafId: second }
        },
        activeLeafId: second,
        expandedLeafId: null
      }
    },
    agentStatusByPaneKey: { [`terminal:${second}`]: { agentType: 'codex' } },
    sleepingAgentSessionsByPaneKey: {},
    repos: [],
    worktreesByRepo: {},
    sshConnectionStates: new Map()
  } as unknown as AppState
  setNativeChatLeaf('terminal', first)
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useNativeChatLeafState.setState({ nativeChatLeafByTabId: {} })
})
function chord() {
  const isMac = navigator.userAgent.includes('Mac')
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'j',
      shiftKey: true,
      metaKey: isMac,
      ctrlKey: !isMac,
      cancelable: true
    })
  )
}
it('moves chat to the focused supported sibling using the terminal entity id', () => {
  renderHook(() => useNativeChatToggleShortcut('wt', true))
  chord()
  expect(mocks.switchView).toHaveBeenCalledExactlyOnceWith('wt', 'unified', 'chat', {
    paneKey: `terminal:${second}`
  })
})
it('returns the focused owner to Terminal even after live evidence disappears', () => {
  setNativeChatLeaf('terminal', second)
  mocks.state.agentStatusByPaneKey = {}
  renderHook(() => useNativeChatToggleShortcut('wt', true))
  chord()
  expect(mocks.switchView).toHaveBeenCalledExactlyOnceWith('wt', 'unified', 'terminal', {
    paneKey: `terminal:${second}`
  })
})
it.each([undefined, 'gemini'])('does not switch a focused sibling with agent %s', (agentType) => {
  mocks.state.agentStatusByPaneKey = agentType
    ? ({ [`terminal:${second}`]: { agentType } } as unknown as AppState['agentStatusByPaneKey'])
    : {}
  renderHook(() => useNativeChatToggleShortcut('wt', true))
  chord()
  expect(mocks.switchView).not.toHaveBeenCalled()
})
it('uses the same persisted owner fallback as the header before mount', () => {
  useNativeChatLeafState.setState({ nativeChatLeafByTabId: {} })
  renderHook(() => useNativeChatToggleShortcut('wt', true))
  chord()
  expect(mocks.switchView).toHaveBeenCalledWith('wt', 'unified', 'terminal', {
    paneKey: `terminal:${second}`
  })
})
it('does not act for an inactive worktree', () => {
  renderHook(() => useNativeChatToggleShortcut('wt', false))
  chord()
  expect(mocks.switchView).not.toHaveBeenCalled()
})
