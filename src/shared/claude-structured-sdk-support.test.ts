import { describe, expect, it } from 'vitest'
import {
  describeClaudeStructuredSdkSupport,
  isClaudeStructuredSdkEnabled,
  type ClaudeStructuredSdkSettings
} from './claude-structured-sdk-support'

const enabled: ClaudeStructuredSdkSettings = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true,
  agentUseAcp: {}
}

describe('claude structured SDK support', () => {
  it('admits a launch with the experiment on and no ACP opt-in', () => {
    expect(describeClaudeStructuredSdkSupport(enabled)).toEqual({ supported: true })
    expect(isClaudeStructuredSdkEnabled(enabled)).toBe(true)
  })

  it('refuses when structured chat is off, naming the setting', () => {
    expect(
      describeClaudeStructuredSdkSupport({ ...enabled, experimentalStructuredNativeChat: false })
    ).toEqual({ supported: false, reason: 'structured-off' })
    expect(
      isClaudeStructuredSdkEnabled({ ...enabled, experimentalStructuredNativeChat: false })
    ).toBe(false)
  })

  it('refuses when chat UI is off or the default view is the terminal', () => {
    expect(
      describeClaudeStructuredSdkSupport({ ...enabled, experimentalNativeChat: false })
    ).toEqual({ supported: false, reason: 'chat-ui-off' })
    expect(
      describeClaudeStructuredSdkSupport({ ...enabled, openAgentTabsInChatByDefault: false })
    ).toEqual({ supported: false, reason: 'default-view-terminal' })
  })

  it('yields to an explicit Claude ACP opt-in rather than taking the launch', () => {
    const acp = { ...enabled, agentUseAcp: { claude: true } }
    expect(describeClaudeStructuredSdkSupport(acp)).toEqual({ supported: false, reason: 'acp' })
    // The host must agree, or the launcher routes to ACP while the host admits the SDK.
    expect(isClaudeStructuredSdkEnabled(acp)).toBe(false)
  })

  it('refuses unreadable settings instead of assuming the experiment is on', () => {
    expect(isClaudeStructuredSdkEnabled(null)).toBe(false)
    expect(describeClaudeStructuredSdkSupport(null)).toEqual({
      supported: false,
      reason: 'default-view-terminal'
    })
  })

  it('does not treat another agent’s ACP opt-in as Claude’s', () => {
    const otherAcp = { ...enabled, agentUseAcp: { codex: true, grok: true } }
    expect(describeClaudeStructuredSdkSupport(otherAcp)).toEqual({ supported: true })
  })
})
