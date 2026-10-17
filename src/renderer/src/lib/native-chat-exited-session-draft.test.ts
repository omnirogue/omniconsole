import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import {
  resumeExitedNativeChatSession,
  restartExitedNativeChatAgent
} from './native-chat-exited-session-relaunch'

const mocks = vi.hoisted(() => ({ resume: vi.fn(), restart: vi.fn() }))
vi.mock('./sleeping-agent-session-launch', () => ({ launchSleepingAgentSession: mocks.resume }))
vi.mock('./launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.restart }))

const initialState = useAppStore.getState()
beforeEach(() => {
  vi.resetAllMocks()
  useAppStore.getState().seedNativeChatLaunchPrompt({
    tabId: 'old',
    agent: 'codex',
    text: 'Keep this important instruction',
    createdAt: 1
  })
})
afterEach(() => useAppStore.setState(initialState, true))

it.each(['resume', 'restart'] as const)(
  'keeps the undelivered prompt if %s cannot launch',
  (action) => {
    mocks.resume.mockReturnValue(false)
    mocks.restart.mockReturnValue(null)
    const result =
      action === 'restart'
        ? restartExitedNativeChatAgent({ terminalTabId: 'old', agent: 'codex', worktreeId: 'wt' })
        : resumeExitedNativeChatSession({
            terminalTabId: 'old',
            record: { agent: 'codex' } as SleepingAgentSessionRecord
          })
    expect(result).toBe(false)
    expect(useAppStore.getState().nativeChatLaunchPromptByTabId.old?.text).toBe(
      'Keep this important instruction'
    )
  }
)

it('clears the source only after a restart accepts the prompt as a draft', () => {
  mocks.restart.mockReturnValue({ tabId: 'new' })
  expect(
    restartExitedNativeChatAgent({ terminalTabId: 'old', agent: 'codex', worktreeId: 'wt' })
  ).toBe(true)
  expect(mocks.restart).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: 'Keep this important instruction',
      promptDelivery: 'draft',
      viewModePreference: 'chat'
    })
  )
  expect(useAppStore.getState().nativeChatLaunchPromptByTabId.old).toBeUndefined()
})
