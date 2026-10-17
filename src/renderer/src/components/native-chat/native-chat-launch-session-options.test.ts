import { describe, expect, it } from 'vitest'
import { resolveInitialNativeChatSessionOptions } from './native-chat-launch-session-options'

const settings = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  nativeChatSessionOptions: {
    codex: {
      model: 'gpt-5.2-codex',
      valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
    }
  }
}

describe('resolveInitialNativeChatSessionOptions', () => {
  it('seeds only saved effort into terminal-default launches', () => {
    expect(
      resolveInitialNativeChatSessionOptions(
        { ...settings, openAgentTabsInChatByDefault: false },
        { agent: 'codex' }
      )
    ).toEqual({ effort: 'medium' })
  })

  it('applies native-chat preferences when the launch resolves to chat', () => {
    expect(resolveInitialNativeChatSessionOptions(settings, { agent: 'codex' })).toEqual({
      model: 'gpt-5.2-codex',
      effort: 'medium'
    })
  })

  it('keeps saved effort when a draft forces the initial view back to terminal', () => {
    expect(
      resolveInitialNativeChatSessionOptions(settings, {
        agent: 'codex',
        promptDelivery: 'draft',
        launchDraftText: 'one\u2028two'
      })
    ).toEqual({ effort: 'medium' })
  })

  it('omits preferences when a remote transcript forces the initial view to terminal', () => {
    const grokSettings = {
      ...settings,
      nativeChatSessionOptions: { grok: { model: 'grok-4.5' } }
    }
    expect(
      resolveInitialNativeChatSessionOptions(grokSettings, {
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: false
      })
    ).toBeUndefined()
  })
})

it('honors an explicit terminal view while the default is chat', () => {
  expect(
    resolveInitialNativeChatSessionOptions(settings, {
      agent: 'codex',
      preferredViewMode: 'terminal'
    })
  ).toEqual({ effort: 'medium' })
})

it.each([
  { agentArgs: '--profile work' },
  { agentArgs: '-c model_reasoning_effort=low' },
  { agentCommandOverride: 'custom-codex' },
  { agentEnv: { OPENAI_MODEL: 'custom-model' } }
])('preserves explicit terminal configuration %j', (overrides) => {
  expect(
    resolveInitialNativeChatSessionOptions(settings, {
      agent: 'codex',
      preferredViewMode: 'terminal',
      ...overrides
    })
  ).toBeUndefined()
})

it('preserves a Claude environment effort', () => {
  const claudeSettings = {
    ...settings,
    nativeChatSessionOptions: {
      claude: { model: 'opus', valuesByModel: { opus: { effort: 'medium' } } }
    }
  }
  expect(
    resolveInitialNativeChatSessionOptions(claudeSettings, {
      agent: 'claude',
      preferredViewMode: 'terminal',
      agentEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'low' }
    })
  ).toBeUndefined()
})

it('leaves untouched terminal effort unspecified', () => {
  expect(
    resolveInitialNativeChatSessionOptions(
      { ...settings, nativeChatSessionOptions: { codex: { model: 'gpt-5.2-codex' } } },
      { agent: 'codex', preferredViewMode: 'terminal' }
    )
  ).toBeUndefined()
})
