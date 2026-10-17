import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  launchClaudeStructuredChat: vi.fn(),
  explain: vi.fn(),
  hostSupport: vi.fn()
}))

vi.mock('./launch-claude-structured-chat', () => ({
  launchClaudeStructuredChat: mocks.launchClaudeStructuredChat,
  explainClaudeStructuredFallback: mocks.explain
}))
vi.mock('@/lib/structured-native-chat-availability', () => ({
  describeStructuredNativeChatHostSupport: mocks.hostSupport
}))

import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { useAppStore } from '@/store'
import {
  attemptClaudeStructuredChatLaunch,
  shouldAttemptClaudeStructuredLaunch
} from './launch-agent-claude-structured-attempt'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab-types'

const STRUCTURED_ON = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  experimentalStructuredNativeChat: true,
  agentUseAcp: {}
}

function storeWith(settings: Record<string, unknown> = STRUCTURED_ON) {
  return { settings } as unknown as ReturnType<typeof useAppStore.getState>
}

const PLAN = { agent: 'claude' } as unknown as AgentStartupPlan

function attempt(
  args: Partial<LaunchAgentInNewTabArgs> = {},
  store = storeWith(),
  overrides: { claudeChatLaunch?: boolean; hasPrompt?: boolean; promptDelivery?: string } = {}
) {
  return attemptClaudeStructuredChatLaunch({
    args: { agent: 'claude', worktreeId: 'wt-1', ...args } as LaunchAgentInNewTabArgs,
    store,
    claudeChatLaunch: overrides.claudeChatLaunch ?? true,
    startupPlan: PLAN,
    sessionOptions: { model: 'sonnet' },
    hasPrompt: overrides.hasPrompt ?? false,
    promptDelivery: overrides.promptDelivery ?? 'submit-after-ready',
    trimmedPrompt: 'ship it',
    relaunch: () => null
  })
}

/** The reason the attempt explained before declining, or null when it explained nothing. */
function explainedReason(): string | null {
  return (mocks.explain.mock.calls[0]?.[0] as string | undefined) ?? null
}

describe('shouldAttemptClaudeStructuredLaunch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('claims a Claude chat launch once the experiment is on', () => {
    expect(shouldAttemptClaudeStructuredLaunch(storeWith(), 'claude', undefined)).toBe(true)
    expect(shouldAttemptClaudeStructuredLaunch(storeWith(), 'claude', 'chat')).toBe(true)
  })

  it('never claims another agent, a terminal choice, or a disabled experiment', () => {
    expect(shouldAttemptClaudeStructuredLaunch(storeWith(), 'codex', 'chat')).toBe(false)
    expect(shouldAttemptClaudeStructuredLaunch(storeWith(), 'claude', 'terminal')).toBe(false)
    expect(
      shouldAttemptClaudeStructuredLaunch(
        storeWith({ ...STRUCTURED_ON, experimentalStructuredNativeChat: false }),
        'claude',
        'chat'
      )
    ).toBe(false)
  })

  it('leaves Claude to ACP when the person opted that agent into it', () => {
    expect(
      shouldAttemptClaudeStructuredLaunch(
        storeWith({ ...STRUCTURED_ON, agentUseAcp: { claude: true } }),
        'claude',
        'chat'
      )
    ).toBe(false)
  })
})

describe('attemptClaudeStructuredChatLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hostSupport.mockReturnValue({ supported: true })
    mocks.launchClaudeStructuredChat.mockResolvedValue({ delivered: true, failureNotified: false })
  })

  it('takes the launch when nothing on this side is in the way', () => {
    const result = attempt()
    expect(result).toMatchObject({ tabId: null, focusAfterMenuClose: 'structured-session' })
    expect(mocks.launchClaudeStructuredChat).toHaveBeenCalledOnce()
    expect(mocks.explain).not.toHaveBeenCalled()
  })

  it.each([
    ['agentArgs', { agentArgs: '--dangerously-skip-permissions' }],
    ['launchEnv', { launchEnv: { CLAUDE_CONFIG_DIR: '/accounts/other' } }],
    ['initialCwd', { initialCwd: '/elsewhere' }]
  ])('declines a launch that pins %s, and says why', (_case, args) => {
    // Silently ignoring any of these would run the session under different
    // arguments, a different account, or in a different directory than asked.
    expect(attempt(args as Partial<LaunchAgentInNewTabArgs>)).toBeNull()
    expect(explainedReason()).toBe('custom-launch')
    // Declining, not deferring: the ordinary terminal path must still run this
    // launch synchronously, which is what creates and seeds its tab.
    expect(mocks.launchClaudeStructuredChat).not.toHaveBeenCalled()
  })

  it('declines a configured command override for this agent', () => {
    expect(
      attempt({}, storeWith({ ...STRUCTURED_ON, agentCmdOverrides: { claude: 'my-claude' } }))
    ).toBeNull()
    expect(explainedReason()).toBe('custom-launch')
  })

  it('declines a draft prompt quietly, since drafting is a deliberate choice', () => {
    expect(attempt({}, storeWith(), { hasPrompt: true, promptDelivery: 'draft' })).toBeNull()
    expect(mocks.explain).not.toHaveBeenCalled()
    expect(mocks.launchClaudeStructuredChat).not.toHaveBeenCalled()
  })

  it.each(['remote', 'wsl', 'windows', 'repair-required'] as const)(
    'declines on the host gate reason %s, and names it',
    (reason) => {
      mocks.hostSupport.mockReturnValue({ supported: false, reason })
      expect(attempt()).toBeNull()
      expect(explainedReason()).toBe(reason)
    }
  )

  it('declines the launch entirely for another agent, a terminal launch, or an ACP retry', () => {
    expect(attempt({ agent: 'codex' } as Partial<LaunchAgentInNewTabArgs>)).toBeNull()
    expect(attempt({}, storeWith(), { claudeChatLaunch: false })).toBeNull()
    // Re-entering after a structured lane already refused would loop the fallback.
    expect(attempt({ acpFallback: true })).toBeNull()
    expect(mocks.launchClaudeStructuredChat).not.toHaveBeenCalled()
  })

  it('carries the opening prompt when it is meant to be sent, not drafted', () => {
    attempt({}, storeWith(), { hasPrompt: true, promptDelivery: 'submit-after-ready' })
    expect(mocks.launchClaudeStructuredChat.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'ship it',
      options: { model: 'sonnet' }
    })
  })
})
