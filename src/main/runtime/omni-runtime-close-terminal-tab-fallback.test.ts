import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

/**
 * closeTerminalTab on a tab the mobile session snapshot no longer lists.
 *
 * closeMobileSessionTab throws tab_not_found there; the terminal behind the handle must still close
 * through closeTerminal, while every other failure keeps propagating.
 */
describe('closeTerminalTab fallback', () => {
  async function setup(closeMobileSessionTab: () => Promise<unknown>) {
    const { OrcaRuntimeService } = await import('./omni-runtime')
    const closed = { handle: 'h1', tabId: 'tab-1', ptyKilled: true }
    const self = {
      getLivePtyForHandle: () => ({ pty: { worktreeId: 'wt-1', tabId: 'tab-1' } }),
      closeMobileSessionTab: vi.fn(closeMobileSessionTab),
      closeTerminal: vi.fn(async () => closed),
      claudeAgentTeams: { removeTeamForLeaderHandle: vi.fn() }
    }
    const proto = OrcaRuntimeService.prototype as unknown as Record<string, unknown>
    const run = () =>
      (proto.closeTerminalTab as (h: string) => Promise<unknown>).call(
        Object.assign(Object.create(proto), self),
        'h1'
      )
    return { self, closed, run }
  }

  it('falls back to closeTerminal on tab_not_found', async () => {
    const { self, closed, run } = await setup(async () => {
      throw new Error('tab_not_found')
    })

    await expect(run()).resolves.toBe(closed)
    expect(self.closeTerminal).toHaveBeenCalledWith('h1')
  })

  it('still throws other errors', async () => {
    const { self, run } = await setup(async () => {
      throw new Error('workspace_session_unavailable')
    })

    await expect(run()).rejects.toThrow('workspace_session_unavailable')
    expect(self.closeTerminal).not.toHaveBeenCalled()
  })
})
