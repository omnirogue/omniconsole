import { describe, expect, it } from 'vitest'
import { deriveNativeChatAgentExit, type NativeChatAgentExitSlice } from './native-chat-agent-exit'

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

function slice(overrides: Partial<NativeChatAgentExitSlice> = {}): NativeChatAgentExitSlice {
  return {
    sleepingAgentSessionsByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    retainedAgentsByPaneKey: {},
    nativeChatLaunchPromptByTabId: {},
    tabsByWorktree: { wt: [{ id: 't1' }] } as unknown as NativeChatAgentExitSlice['tabsByWorktree'],
    ...overrides
  }
}

const args = { terminalTabId: 't1', paneKey: PANE, targetPtyId: 'pty-1', hasLiveEntry: false }

describe('deriveNativeChatAgentExit', () => {
  it('is quiet while a live status row exists', () => {
    const result = deriveNativeChatAgentExit(
      slice({
        sleepingAgentSessionsByPaneKey: { [PANE]: record },
        paneForegroundAgentByPaneKey: { [PANE]: { agent: null, shellForeground: true } }
      }),
      { ...args, hasLiveEntry: true }
    )
    expect(result.agentExit).toBeNull()
    expect(result.record).toEqual(record)
  })

  it('is quiet at startup: a bare shell with nothing recorded is not an exit', () => {
    const result = deriveNativeChatAgentExit(
      slice({ paneForegroundAgentByPaneKey: { [PANE]: { agent: null, shellForeground: true } } }),
      args
    )
    expect(result.agentExit).toBeNull()
  })

  it('reports an exit with a resumable checkpoint once the shell is back', () => {
    const result = deriveNativeChatAgentExit(
      slice({
        sleepingAgentSessionsByPaneKey: { [PANE]: record },
        paneForegroundAgentByPaneKey: { [PANE]: { agent: null, shellForeground: true } },
        nativeChatLaunchPromptByTabId: {
          t1: { tabId: 't1', agent: 'codex', text: 'Reply READY', createdAt: 5 }
        }
      }),
      args
    )
    expect(result.agentExit).toEqual({
      resumeRecord: record,
      worktreeId: 'wt',
      hasUndeliveredPrompt: true
    })
  })

  it('reports an exit without a checkpoint when the launch prompt failed to deliver', () => {
    const result = deriveNativeChatAgentExit(
      slice({
        paneForegroundAgentByPaneKey: { [PANE]: { agent: null, shellForeground: true } },
        nativeChatLaunchPromptByTabId: {
          t1: { tabId: 't1', agent: 'codex', text: 'Reply READY', createdAt: 5, failed: true }
        }
      }),
      args
    )
    expect(result.agentExit).toEqual({
      resumeRecord: null,
      worktreeId: 'wt',
      hasUndeliveredPrompt: true
    })
  })

  it('stays live while the agent still owns the foreground', () => {
    const result = deriveNativeChatAgentExit(
      slice({
        sleepingAgentSessionsByPaneKey: { [PANE]: record },
        paneForegroundAgentByPaneKey: { [PANE]: { agent: 'codex', shellForeground: false } }
      }),
      args
    )
    expect(result.agentExit).toBeNull()
  })

  // Why: remote/SSH panes never get an OSC 133 process confirmation; the title
  // reverting to a plain shell is the only exit evidence they will ever see.
  it('reports an exit on a shell-hosted pane whose title reverted with the pty alive', () => {
    const result = deriveNativeChatAgentExit(
      slice({
        sleepingAgentSessionsByPaneKey: { [PANE]: record },
        paneForegroundAgentByPaneKey: {
          [PANE]: { agent: null, shellForeground: false, shellTitleReverted: true }
        }
      }),
      args
    )
    expect(result.agentExit).toEqual({
      resumeRecord: record,
      worktreeId: 'wt',
      hasUndeliveredPrompt: false
    })
  })

  it('stays quiet on a title reversion while a live status row still exists', () => {
    const result = deriveNativeChatAgentExit(
      slice({
        retainedAgentsByPaneKey: { [PANE]: { agentType: 'codex' } } as never,
        paneForegroundAgentByPaneKey: {
          [PANE]: { agent: null, shellForeground: false, shellTitleReverted: true }
        }
      }),
      { ...args, hasLiveEntry: true }
    )
    expect(result.agentExit).toBeNull()
  })

  it('treats a closed pane with a checkpoint as exited', () => {
    const result = deriveNativeChatAgentExit(
      slice({ sleepingAgentSessionsByPaneKey: { [PANE]: record }, tabsByWorktree: {} }),
      { ...args, targetPtyId: null }
    )
    expect(result.agentExit?.worktreeId).toBe('wt')
    expect(result.agentExit?.resumeRecord).toEqual(record)
  })

  it('stays quiet while a checkpoint is waiting for its first reveal', () => {
    const pendingRecord = { ...record, resumeOnFirstReveal: true as const }
    const result = deriveNativeChatAgentExit(
      slice({ sleepingAgentSessionsByPaneKey: { [PANE]: pendingRecord } }),
      { ...args, targetPtyId: null }
    )
    expect(result.agentExit).toBeNull()
    expect(result.record).toEqual(pendingRecord)
  })

  it("does not borrow a sibling pane's shell foreground as exit evidence", () => {
    const result = deriveNativeChatAgentExit(
      slice({
        sleepingAgentSessionsByPaneKey: { [PANE]: record },
        paneForegroundAgentByPaneKey: { 't1:leaf-2': { agent: null, shellForeground: true } }
      }),
      args
    )
    expect(result.agentExit).toBeNull()
  })
})
