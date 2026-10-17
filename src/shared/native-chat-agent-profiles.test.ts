import { describe, expect, it } from 'vitest'
import {
  getNativeChatAgentProfile,
  getVerifiedNativeChatCommands
} from './native-chat-agent-profiles'

describe('native chat agent picker profiles', () => {
  it('keeps Codex dollar skills separate from slash commands', () => {
    expect(getNativeChatAgentProfile('codex')).toMatchObject({
      skillPrefix: '$',
      groupedSlash: false,
      skillSourceOwner: 'codex'
    })
  })

  it('groups Claude-family and Grok skills under slash', () => {
    expect(getNativeChatAgentProfile('claude')).toMatchObject({
      skillPrefix: '/',
      groupedSlash: true,
      skillSourceOwner: 'claude'
    })
    expect(getNativeChatAgentProfile('openclaude')).toMatchObject({ skillSourceOwner: 'claude' })
    expect(getNativeChatAgentProfile('grok')).toMatchObject({
      skillPrefix: '/',
      groupedSlash: true,
      skillSourceOwner: 'grok'
    })
  })

  it('does not grant custom or unverified agents a skill grammar', () => {
    expect(getNativeChatAgentProfile('custom-agent')).toBeNull()
  })
})

it.each(['pi', 'prime-agent'] as const)('%s exposes only its owned/shared skills', (agent) => {
  expect(getNativeChatAgentProfile(agent)).toEqual({
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: agent
  })
  expect(getVerifiedNativeChatCommands(agent)).toEqual([])
})
