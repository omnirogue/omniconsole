import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteAgentSession, noteAgentTerminal, noteConnectorLaunch } from './agent-session-mark'

afterEach(() => vi.useRealTimers())

describe('noteAgentSession', () => {
  it('asks the window to note the pane, and asks again while it is still adding the row', async () => {
    vi.useFakeTimers()
    const requestSessionFolders = vi
      .fn()
      .mockRejectedValueOnce(new Error('No conversation in the sidebar matches pane tab:leaf.'))
      .mockResolvedValue({ marked: true })
    noteAgentSession({ requestSessionFolders }, 'tab:leaf')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(requestSessionFolders).toHaveBeenCalledTimes(2)
    expect(requestSessionFolders).toHaveBeenLastCalledWith({
      kind: 'markAgentSession',
      paneKey: 'tab:leaf'
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requestSessionFolders).toHaveBeenCalledTimes(2)
  })

  it('never fails the launch that asked: a runtime without a window relay is skipped', () => {
    expect(() => noteAgentSession({} as never, 'tab:leaf', 1)).not.toThrow()
  })

  it("waits for a new terminal's pane identity before asking", async () => {
    vi.useFakeTimers()
    const requestSessionFolders = vi.fn(async () => ({ marked: true }))
    const getTerminalPaneKey = vi.fn().mockReturnValueOnce(null).mockReturnValue('tab:leaf')
    noteAgentTerminal({ requestSessionFolders, getTerminalPaneKey }, 'term_new')
    expect(requestSessionFolders).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(requestSessionFolders).toHaveBeenCalledWith({
      kind: 'markAgentSession',
      paneKey: 'tab:leaf'
    })
  })

  it('notes a session prep launch only when it came through the OmniOS/MCP connector', () => {
    const requestSessionFolders = vi.fn(async () => ({ marked: true }))
    const surface = { tabId: 'tab', paneKey: 'tab:leaf' }
    expect(noteConnectorLaunch({ requestSessionFolders }, undefined, surface)).toBe(surface)
    expect(requestSessionFolders).not.toHaveBeenCalled()
    expect(noteConnectorLaunch({ requestSessionFolders }, { title: 'x' }, surface)).toBe(surface)
    expect(requestSessionFolders).toHaveBeenCalledWith({
      kind: 'markAgentSession',
      paneKey: 'tab:leaf'
    })
  })
})
