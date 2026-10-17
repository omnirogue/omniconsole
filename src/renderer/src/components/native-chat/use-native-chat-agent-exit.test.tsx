// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  advanceCodexResumeRelaunch,
  beginCodexResumeRelaunch,
  resetCodexResumeRelaunchForTests
} from './codex-resume-relaunch-state'
import type { NativeChatAgentExitSlice } from './native-chat-agent-exit'
import { useNativeChatAgentExit } from './use-native-chat-agent-exit'

const mocks = vi.hoisted(() => ({ state: {} as NativeChatAgentExitSlice }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: NativeChatAgentExitSlice) => unknown) => selector(mocks.state)
}))

const PANE = 't1:leaf-1'
const record = {
  paneKey: PANE,
  tabId: 't1',
  worktreeId: 'wt',
  agent: 'codex' as const,
  providerSession: { key: 'session_id' as const, id: 'thread-1' },
  prompt: 'finish it',
  state: 'done' as const,
  capturedAt: 1,
  updatedAt: 1
}
const args = { terminalTabId: 't1', paneKey: PANE, targetPtyId: 'pty-1', hasLiveEntry: false }

beforeEach(() => {
  resetCodexResumeRelaunchForTests()
  mocks.state = {
    sleepingAgentSessionsByPaneKey: { [PANE]: record },
    paneForegroundAgentByPaneKey: { [PANE]: { agent: null, shellForeground: true } },
    retainedAgentsByPaneKey: {},
    nativeChatLaunchPromptByTabId: {},
    tabsByWorktree: {}
  }
})
afterEach(() => {
  cleanup()
  resetCodexResumeRelaunchForTests()
})

it.each(['restarting', 'verifying'] as const)(
  'hides the exit notice while %s and restores it when the relaunch settles',
  (phase) => {
    const { result } = renderHook(() => useNativeChatAgentExit(args))
    expect(result.current.agentExit?.resumeRecord).toEqual(record)

    act(() => {
      beginCodexResumeRelaunch(PANE, {
        phase,
        requested: { model: 'gpt-5' },
        selectedOption: 'model',
        threadId: 'thread-1',
        previousPtyId: 'pty-1',
        startedAt: Date.now()
      })
    })
    expect(result.current.agentExit).toBeNull()
    expect(result.current.record).toEqual(record)

    act(() => advanceCodexResumeRelaunch(PANE, { phase: 'confirmed' }))
    expect(result.current.agentExit).toEqual({
      resumeRecord: record,
      worktreeId: 'wt',
      hasUndeliveredPrompt: false
    })
  }
)
