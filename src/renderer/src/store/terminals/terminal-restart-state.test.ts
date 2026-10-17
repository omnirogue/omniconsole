import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../index'

const PTY = 'wt1@@pty-1'
const OTHER = 'wt1@@pty-2'
const STARTUP = {
  command: "codex '-m' 'gpt-5.5' 'resume' 'thread-1'",
  startupCommandDelivery: 'shell-ready' as const,
  launchAgent: 'codex' as const
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('codex pane restart startup channel', () => {
  it('queueCodexPaneRestarts stores a per-pane startup that takeCodexPaneRestartStartup returns exactly once', () => {
    useAppStore.getState().queueCodexPaneRestarts([PTY, OTHER], STARTUP)

    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({
      [PTY]: true,
      [OTHER]: true
    })
    expect(useAppStore.getState().pendingCodexPaneRestartStartupByPtyId).toEqual({
      [PTY]: STARTUP,
      [OTHER]: STARTUP
    })
    expect(useAppStore.getState().takeCodexPaneRestartStartup(PTY)).toBe(STARTUP)
    expect(useAppStore.getState().takeCodexPaneRestartStartup(PTY)).toBeNull()
    expect(useAppStore.getState().pendingCodexPaneRestartStartupByPtyId).toEqual({
      [OTHER]: STARTUP
    })
  })

  it('consumePendingCodexPaneRestart leaves the startup for take()', () => {
    useAppStore.getState().queueCodexPaneRestarts([PTY], STARTUP)

    expect(useAppStore.getState().consumePendingCodexPaneRestart(PTY)).toBe(true)
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
    expect(useAppStore.getState().takeCodexPaneRestartStartup(PTY)).toBe(STARTUP)
  })

  it('queueing without a startup drops a stale one', () => {
    useAppStore.getState().queueCodexPaneRestarts([PTY], STARTUP)
    useAppStore.getState().queueCodexPaneRestarts([PTY])

    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ [PTY]: true })
    expect(useAppStore.getState().takeCodexPaneRestartStartup(PTY)).toBeNull()
  })

  it('clearCodexRestartNotice, dismissCodexRestartNotices and reopenCodexRestartPrompt drop the startup', () => {
    const notice = { ptyId: PTY, previousAccountLabel: 'a@x', nextAccountLabel: 'b@x' }

    useAppStore.getState().markCodexRestartNotices([notice])
    useAppStore.getState().queueCodexPaneRestarts([PTY], STARTUP)
    useAppStore.getState().clearCodexRestartNotice(PTY)
    expect(useAppStore.getState().pendingCodexPaneRestartStartupByPtyId).toEqual({})

    useAppStore.getState().markCodexRestartNotices([notice])
    useAppStore.getState().queueCodexPaneRestarts([PTY], STARTUP)
    useAppStore.getState().dismissCodexRestartNotices([PTY])
    expect(useAppStore.getState().pendingCodexPaneRestartStartupByPtyId).toEqual({})

    useAppStore.getState().markCodexRestartNotices([notice])
    useAppStore.getState().queueCodexPaneRestarts([PTY], STARTUP)
    useAppStore.getState().reopenCodexRestartPrompt(PTY)
    expect(useAppStore.getState().pendingCodexPaneRestartStartupByPtyId).toEqual({})
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
  })

  it('a same-account re-mark that cancels the restart drops the startup too', () => {
    useAppStore
      .getState()
      .markCodexRestartNotices([
        { ptyId: PTY, previousAccountLabel: 'a@x', nextAccountLabel: 'b@x' }
      ])
    useAppStore.getState().queueCodexPaneRestarts([PTY], STARTUP)
    useAppStore
      .getState()
      .markCodexRestartNotices([
        { ptyId: PTY, previousAccountLabel: 'b@x', nextAccountLabel: 'a@x' }
      ])

    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
    expect(useAppStore.getState().pendingCodexPaneRestartStartupByPtyId).toEqual({})
  })
})
