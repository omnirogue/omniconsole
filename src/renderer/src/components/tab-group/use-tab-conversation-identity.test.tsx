// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'
import { shouldHideTabGroupStrip } from './tab-group-strip-visibility'
import { nativeChatEnabledByPreference } from '../../../../shared/native-chat-preference'
import {
  tabHasConversationIdentity,
  useTabConversationIdentity
} from './use-tab-conversation-identity'

const mocks = vi.hoisted(() => ({ state: {} as AppState }))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: AppState) => unknown) => select(mocks.state)
}))
afterEach(cleanup)
const tab = { id: 'unified', entityId: 'terminal', contentType: 'terminal' } as Tab
function state(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    ...overrides
  } as AppState
}

it('uses agent evidence from any leaf independently of the active leaf', () => {
  for (const activeLeafId of ['shell', 'agent']) {
    expect(
      tabHasConversationIdentity(
        state({
          terminalLayoutsByTabId: {
            terminal: { activeLeafId }
          } as unknown as AppState['terminalLayoutsByTabId'],
          agentStatusByPaneKey: {
            'terminal:agent': { agentType: 'claude' }
          } as unknown as AppState['agentStatusByPaneKey']
        }),
        'workspace',
        tab
      )
    ).toBe(true)
  }
})

it('retains a detected conversation through live status flicker and resets for another tab', () => {
  mocks.state = state({
    agentStatusByPaneKey: {
      'terminal:agent': { agentType: 'codex' }
    } as unknown as AppState['agentStatusByPaneKey']
  })
  const hook = renderHook(({ current }) => useTabConversationIdentity('workspace', current), {
    initialProps: { current: tab }
  })
  expect(hook.result.current).toBe(true)
  mocks.state = state()
  hook.rerender({ current: tab })
  expect(hook.result.current).toBe(true)
  hook.rerender({ current: { ...tab, id: 'other', entityId: 'other-terminal' } })
  expect(hook.result.current).toBe(false)
})

it('uses launch hints and sleeping checkpoints without live status', () => {
  expect(
    tabHasConversationIdentity(
      state({
        tabsByWorktree: {
          workspace: [{ id: 'terminal', launchAgent: 'codex' }]
        } as unknown as AppState['tabsByWorktree']
      }),
      'workspace',
      tab
    )
  ).toBe(true)
  expect(
    tabHasConversationIdentity(
      state({
        sleepingAgentSessionsByPaneKey: {
          'terminal:old': { tabId: 'terminal', agent: 'claude' }
        } as unknown as AppState['sleepingAgentSessionsByPaneKey']
      }),
      'workspace',
      tab
    )
  ).toBe(true)
  expect(tabHasConversationIdentity(state(), 'workspace', tab)).toBe(false)
})

it('does not retain unsupported launch, live or checkpoint identities', () => {
  mocks.state = state({
    tabsByWorktree: {
      workspace: [{ id: 'terminal', launchAgent: 'gemini' }]
    } as unknown as AppState['tabsByWorktree'],
    agentStatusByPaneKey: {
      'terminal:agent': { agentType: 'gemini' }
    } as unknown as AppState['agentStatusByPaneKey'],
    sleepingAgentSessionsByPaneKey: {
      'terminal:old': { tabId: 'terminal', agent: 'gemini' }
    } as unknown as AppState['sleepingAgentSessionsByPaneKey']
  })
  const hook = renderHook(() => useTabConversationIdentity('workspace', tab))
  expect(hook.result.current).toBe(false)
  mocks.state = state()
  hook.rerender()
  expect(hook.result.current).toBe(false)
})

it('keeps strip eligibility through switching and focus loss, but honors Chat UI off', () => {
  mocks.state = state({
    agentStatusByPaneKey: {
      'terminal:agent': { agentType: 'claude' }
    } as unknown as AppState['agentStatusByPaneKey']
  })
  const hook = renderHook(
    ({ mode, enabled }) =>
      shouldHideTabGroupStrip({
        tabCount: 1,
        activeTabContentType: 'terminal',
        activeTabViewMode: mode,
        hasAgent: useTabConversationIdentity('workspace', { ...tab, viewMode: mode }),
        nativeChatUiEnabled: nativeChatEnabledByPreference({ experimentalNativeChat: enabled })
      }),
    { initialProps: { mode: 'chat' as 'chat' | 'terminal', enabled: true } }
  )
  expect(hook.result.current).toBe(true)
  mocks.state = state()
  hook.rerender({ mode: 'terminal', enabled: true })
  expect(hook.result.current).toBe(true)
  hook.rerender({ mode: 'chat', enabled: false })
  expect(hook.result.current).toBe(false)
})
