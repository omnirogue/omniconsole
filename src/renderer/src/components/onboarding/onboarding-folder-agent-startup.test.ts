import { describe, expect, it } from 'vitest'
import { getDefaultOnboardingState, getDefaultSettings } from '../../../../shared/constants'
import {
  buildDismissedOnboardingFolderAgentStartup,
  buildOnboardingFolderAgentStartup,
  shouldSeedFolderAgentAfterDismissedOnboarding
} from '@/lib/onboarding-folder-agent-startup'

describe('buildOnboardingFolderAgentStartup', () => {
  it('queues the persisted default agent with onboarding telemetry', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/omni-workspaces'),
      defaultTuiAgent: 'codex'
    })

    expect(startup).toEqual({
      command: "codex '--dangerously-bypass-approvals-and-sandbox'",
      env: {},
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      sessionOptions: undefined,
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'onboarding',
        request_kind: 'new'
      }
    })
  })

  it('respects the blank terminal preference', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/omni-workspaces'),
      defaultTuiAgent: 'blank'
    })

    expect(startup).toBeUndefined()
  })

  it('applies saved terminal effort without substituting the chat model', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/omni-workspaces'),
      defaultTuiAgent: 'codex',
      agentDefaultArgs: { codex: '-m terminal-model' },
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: false,
      nativeChatSessionOptions: {
        codex: {
          model: 'gpt-5.2-codex',
          valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
        }
      }
    })

    expect(startup?.command).toContain("'-m' 'terminal-model'")
    expect(startup?.command).not.toContain('gpt-5.2-codex')
    expect(startup?.command).toContain('model_reasoning_effort=medium')
    expect(startup?.sessionOptions).toEqual({ effort: 'medium' })
  })

  it('applies native-chat preferences to chat-default folder launches', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/omni-workspaces'),
      defaultTuiAgent: 'codex',
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      nativeChatSessionOptions: {
        codex: {
          model: 'gpt-5.2-codex',
          valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
        }
      }
    })

    expect(startup?.command).toContain("'-m' 'gpt-5.2-codex'")
    expect(startup?.sessionOptions).toEqual({
      model: 'gpt-5.2-codex',
      effort: 'medium'
    })
  })

  it('does not infer an agent from auto mode', () => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/omni-workspaces'),
      defaultTuiAgent: null
    })

    expect(startup).toBeUndefined()
  })

  it('seeds after a dismissed onboarding run before any project was added', () => {
    expect(
      shouldSeedFolderAgentAfterDismissedOnboarding(
        {
          ...getDefaultOnboardingState(),
          outcome: 'dismissed'
        },
        false
      )
    ).toBe(true)
  })

  it('does not seed after another project was already added outside onboarding', () => {
    expect(
      shouldSeedFolderAgentAfterDismissedOnboarding(
        {
          ...getDefaultOnboardingState(),
          outcome: 'dismissed'
        },
        true
      )
    ).toBe(false)
  })

  it('does not seed after onboarding already added a project', () => {
    expect(
      shouldSeedFolderAgentAfterDismissedOnboarding(
        {
          ...getDefaultOnboardingState(),
          outcome: 'dismissed',
          checklist: { ...getDefaultOnboardingState().checklist, addedFolder: true }
        },
        false
      )
    ).toBe(false)
  })

  it('builds the skipped-onboarding folder startup from the persisted default agent', () => {
    expect(
      buildDismissedOnboardingFolderAgentStartup(
        {
          ...getDefaultSettings('/tmp/omni-workspaces'),
          defaultTuiAgent: 'codex',
          agentCmdOverrides: { codex: 'echo onboarding-folder-agent' }
        },
        { ...getDefaultOnboardingState(), outcome: 'dismissed' },
        false
      )
    ).toEqual({
      command: "echo onboarding-folder-agent '--dangerously-bypass-approvals-and-sandbox'",
      env: {},
      launchAgent: 'codex',
      launchConfig: {
        agentCommand: "echo onboarding-folder-agent '--dangerously-bypass-approvals-and-sandbox'",
        agentArgs: '--dangerously-bypass-approvals-and-sandbox',
        agentEnv: {}
      },
      sessionOptions: undefined,
      telemetry: {
        agent_kind: 'codex',
        launch_source: 'onboarding',
        request_kind: 'new'
      }
    })
  })
})

it.each(['-c model_reasoning_effort=low', '--profile work'])(
  'preserves explicit Codex terminal choices during onboarding: %s',
  (agentArgs) => {
    const startup = buildOnboardingFolderAgentStartup({
      ...getDefaultSettings('/tmp/omni-workspaces'),
      defaultTuiAgent: 'codex',
      openAgentTabsInChatByDefault: false,
      agentDefaultArgs: { codex: agentArgs },
      nativeChatSessionOptions: {
        codex: { model: 'gpt-5.2-codex', valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } } }
      }
    })
    expect(startup?.command).not.toContain('model_reasoning_effort=medium')
    expect(startup?.command).not.toContain('gpt-5.2-codex')
    expect(startup?.sessionOptions).toBeUndefined()
  }
)

it('preserves explicit Claude effort environment during onboarding', () => {
  const startup = buildOnboardingFolderAgentStartup({
    ...getDefaultSettings('/tmp/omni-workspaces'),
    defaultTuiAgent: 'claude',
    openAgentTabsInChatByDefault: false,
    agentDefaultEnv: { claude: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } },
    nativeChatSessionOptions: {
      claude: { model: 'opus', valuesByModel: { opus: { effort: 'medium' } } }
    }
  })
  expect(startup?.env).toMatchObject({ CLAUDE_CODE_EFFORT_LEVEL: 'low' })
  expect(startup?.command).not.toContain('--effort')
  expect(startup?.sessionOptions).toBeUndefined()
})

it('preserves a custom terminal command despite saved onboarding effort', () => {
  const startup = buildOnboardingFolderAgentStartup({
    ...getDefaultSettings('/tmp/omni-workspaces'),
    defaultTuiAgent: 'codex',
    openAgentTabsInChatByDefault: false,
    agentCmdOverrides: { codex: 'custom-codex' },
    nativeChatSessionOptions: {
      codex: { model: 'gpt-5.2-codex', valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } } }
    }
  })
  expect(startup?.command).toContain('custom-codex')
  expect(startup?.command).not.toContain('model_reasoning_effort')
  expect(startup?.sessionOptions).toBeUndefined()
})
