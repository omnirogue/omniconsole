import { describe, expect, it } from 'vitest'
import { decideInitialAgentTabViewMode } from './native-chat-initial-view-mode'

describe('decideInitialAgentTabViewMode with a per-launch preference', () => {
  it('opens a chat-preferring launch in chat when the global default is terminal', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: false,
        preferredViewMode: 'chat',
        agent: 'codex'
      })
    ).toBe('chat')
  })

  it('keeps a terminal-preferring launch in the terminal when the default is chat', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        preferredViewMode: 'terminal',
        agent: 'codex'
      })
    ).toBeUndefined()
  })

  it('never opens chat while the Chat UI is off', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: false,
        preferredViewMode: 'chat',
        agent: 'claude'
      })
    ).toBeUndefined()
  })

  it('routes a Claude Agent Teams lead into chat', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        preferredViewMode: 'chat',
        agent: 'claude-agent-teams'
      })
    ).toBe('chat')
  })

  it('keeps Gemini in the terminal even when chat is preferred', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        preferredViewMode: 'chat',
        agent: 'gemini'
      })
    ).toBeUndefined()
  })
})
