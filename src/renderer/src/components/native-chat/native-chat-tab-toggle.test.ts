import { tabHasConversationIdentity } from '../tab-group/use-tab-conversation-identity'
import { nativeChatEnabledByPreference } from '../../../../shared/native-chat-preference'
import { shouldHideTabGroupStrip } from '../tab-group/tab-group-strip-visibility'
import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  findUnifiedTabIdForTerminalTab,
  resolveNativeChatTabToggle
} from './native-chat-tab-toggle'

function state(overrides: {
  launchAgent?: string | null
  agentType?: string
  checkpointAgent?: string
  viewMode?: 'chat' | 'terminal'
  chatUi?: boolean
}): AppState {
  return {
    unifiedTabsByWorktree: {
      wt: [
        {
          id: 'u1',
          entityId: 't1',
          contentType: 'terminal',
          label: 'Terminal 1',
          viewMode: overrides.viewMode ?? 'terminal'
        }
      ]
    },
    tabsByWorktree: {
      wt: [{ id: 't1', title: 'Terminal 1', launchAgent: overrides.launchAgent ?? null }]
    },
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: overrides.agentType
      ? { 't1:leaf-1': { agentType: overrides.agentType } }
      : {},
    sleepingAgentSessionsByPaneKey: overrides.checkpointAgent
      ? {
          't1:leaf-1': {
            paneKey: 't1:leaf-1',
            tabId: 't1',
            worktreeId: 'wt',
            agent: overrides.checkpointAgent,
            providerSession: { key: 'session_id', id: 'thread-1' },
            prompt: '',
            state: 'done',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      : {},
    settings: { experimentalNativeChat: overrides.chatUi ?? true },
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {}
  } as unknown as AppState
}

describe('resolveNativeChatTabToggle', () => {
  it('maps an Attention pane (terminal tab id) to the unified tab the switch changes', () => {
    expect(findUnifiedTabIdForTerminalTab(state({}), 'wt', 't1')).toBe('u1')
    expect(findUnifiedTabIdForTerminalTab(state({}), 'wt', 'missing')).toBeNull()
  })

  it('lets a Claude session switch to chat', () => {
    expect(resolveNativeChatTabToggle(state({ launchAgent: 'claude' }), 'wt', 'u1')).toMatchObject({
      unifiedTabId: 'u1',
      eligible: true,
      hasAgent: true,
      isChat: false
    })
  })

  it('keeps Gemini visible but not switchable to chat', () => {
    expect(resolveNativeChatTabToggle(state({ launchAgent: 'gemini' }), 'wt', 'u1')).toMatchObject({
      eligible: false,
      hasAgent: true
    })
  })

  it('reports a plain shell as having no agent to show', () => {
    expect(resolveNativeChatTabToggle(state({}), 'wt', 'u1')).toMatchObject({
      eligible: false,
      hasAgent: false
    })
  })

  it('never offers chat while the Chat UI is off, but always lets a chat tab go back', () => {
    expect(
      resolveNativeChatTabToggle(state({ launchAgent: 'claude', chatUi: false }), 'wt', 'u1')
        ?.eligible
    ).toBe(false)
    expect(
      resolveNativeChatTabToggle(state({ launchAgent: 'claude', viewMode: 'chat' }), 'wt', 'u1')
    ).toMatchObject({ isChat: true, eligible: true })
  })

  it('keeps Chat reachable after the agent exits, from the resume checkpoint alone', () => {
    expect(
      resolveNativeChatTabToggle(state({ launchAgent: null, checkpointAgent: 'codex' }), 'wt', 'u1')
    ).toMatchObject({ hasAgent: true, eligible: true, isChat: false })
  })
})

it('keeps a lone unsupported Gemini terminal strip with Chat UI enabled', () => {
  const source = state({ launchAgent: 'gemini' })
  expect(
    shouldHideTabGroupStrip({
      tabCount: 1,
      activeTabContentType: 'terminal',
      hasAgent: tabHasConversationIdentity(source, 'wt', source.unifiedTabsByWorktree.wt[0]),
      nativeChatUiEnabled: nativeChatEnabledByPreference(source.settings)
    })
  ).toBe(false)
})
