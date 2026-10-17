import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupTerminalCreateSurfacing } from './ipc-events-terminal-create-test-harness'

type Request = {
  requestId: string
  expiresAt?: number
  worktreeId?: string
  command?: string
  url: string
}

async function terminalScenario() {
  const fixture = await setupTerminalCreateSurfacing(() => false)
  fixture.createTab.mockImplementation((worktreeId) => {
    const tab = { id: `tab-${fixture.createTab.mock.calls.length}` }
    ;(fixture.storeState.tabsByWorktree[worktreeId] ??= []).push(tab)
    return tab
  })
  return {
    deliver: (data: Request) => fixture.requestTerminalCreateListenerRef.current!(data),
    created: fixture.createTab,
    reply: fixture.replyTerminalCreate,
    startup: fixture.queueTabStartupCommand,
    removeFirst: () => {
      fixture.storeState.tabsByWorktree['wt-1'] = [{ id: 'sibling' }]
    }
  }
}

async function browserScenario() {
  vi.resetModules()
  const state = {
    activeWorktreeId: 'wt-1',
    activeBrowserTabIdByWorktree: {},
    unifiedTabsByWorktree: {},
    browserTabsByWorktree: { 'wt-1': [] as { id: string }[] },
    browserPagesByWorkspace: {} as Record<string, { id: string }[]>,
    createBrowserTab: vi.fn(() => {
      const n = state.createBrowserTab.mock.calls.length
      const workspace = { id: `workspace-${n}` }
      state.browserTabsByWorktree['wt-1'].push(workspace)
      state.browserPagesByWorkspace[workspace.id] = [{ id: `page-${n}` }]
      return workspace
    })
  }
  const reply = vi.fn()
  let deliver!: (data: Request) => void
  vi.doMock('../store', () => ({ useAppStore: { getState: () => state } }))
  vi.doMock('./ipc-events/browser-automation-bootstrap-lease', () => ({
    acquireBrowserAutomationBootstrapLease: vi.fn()
  }))
  vi.stubGlobal('window', {
    api: {
      ui: {
        onRequestTabCreate: (listener: typeof deliver) => {
          deliver = listener
          return () => {}
        },
        replyTabCreate: reply,
        onRequestTabSetProfile: () => () => {},
        onRequestTabClose: () => () => {}
      }
    }
  })
  const { registerBrowserRequestIpcBridge } =
    await import('./ipc-events/browser-request-ipc-bridge')
  registerBrowserRequestIpcBridge([], () => false)
  return {
    deliver,
    created: state.createBrowserTab,
    reply,
    startup: vi.fn(),
    removeFirst: () => {
      state.browserPagesByWorkspace['workspace-1'] = [{ id: 'sibling' }]
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

for (const [kind, setup] of [
  ['terminal', terminalScenario],
  ['browser', browserScenario]
] as const) {
  describe(`${kind} renderer create delivery`, () => {
    it('drops an 11-second delayed delivery and creates exactly one tab for a fresh retry', async () => {
      const fixture = await setup()
      let now = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      const request = { requestId: 'expired', expiresAt: now + 10_000, url: 'about:blank' }
      now += 11_000
      fixture.deliver(request)
      expect(fixture.created).toHaveBeenCalledTimes(0)
      expect(fixture.reply).toHaveBeenLastCalledWith({
        requestId: 'expired',
        error: expect.any(String)
      })
      fixture.deliver({ ...request, requestId: 'retry', expiresAt: now + 10_000 })
      expect(fixture.created).toHaveBeenCalledTimes(1)
    })

    it('replays the first success without creating or queuing startup a second time', async () => {
      const fixture = await setup()
      const request = { requestId: 'duplicate', command: 'echo hello', url: 'about:blank' }
      fixture.deliver(request)
      const first = fixture.reply.mock.calls[0][0]
      fixture.deliver(request)
      expect(fixture.created).toHaveBeenCalledTimes(1)
      expect(fixture.reply.mock.calls.map((call) => call[0])).toEqual([first, first])
      if (kind === 'terminal') {
        expect(fixture.startup).toHaveBeenCalledTimes(1)
      }
    })

    it('creates anew when the named tab or page is gone even if a sibling remains', async () => {
      const fixture = await setup()
      const request = { requestId: 'closed', url: 'about:blank' }
      fixture.deliver(request)
      fixture.removeFirst()
      fixture.deliver(request)
      expect(fixture.created).toHaveBeenCalledTimes(2)
      expect(fixture.reply.mock.calls[1][0]).not.toEqual(fixture.reply.mock.calls[0][0])
    })

    it('accepts legacy deliveries without an expiry and 100 distinct requests', async () => {
      const fixture = await setup()
      for (let i = 0; i < 100; i++) {
        fixture.deliver({ requestId: `legacy-${i}`, url: 'about:blank' })
      }
      expect(fixture.created).toHaveBeenCalledTimes(100)
      expect(fixture.reply.mock.calls.every(([reply]) => !reply.error)).toBe(true)
    })

    it('evicts oldest entries when full and expires settled successes after ten minutes', async () => {
      const fixture = await setup()
      let now = Date.now()
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      for (let i = 0; i < 257; i++) {
        fixture.deliver({ requestId: `bounded-${i}`, url: 'about:blank' })
      }
      fixture.deliver({ requestId: 'bounded-256', url: 'about:blank' })
      expect(fixture.created).toHaveBeenCalledTimes(257)
      fixture.deliver({ requestId: 'bounded-0', url: 'about:blank' })
      expect(fixture.created).toHaveBeenCalledTimes(258)
      now += 600_001
      fixture.deliver({ requestId: 'bounded-0', url: 'about:blank' })
      expect(fixture.created).toHaveBeenCalledTimes(259)
    })

    it('does not retain a failed create as a receipt', async () => {
      const fixture = await setup()
      fixture.created.mockImplementationOnce(() => {
        throw new Error('store unavailable')
      })
      const request = { requestId: 'failed', url: 'about:blank' }
      fixture.deliver(request)
      fixture.deliver(request)
      fixture.deliver(request)
      expect(fixture.created).toHaveBeenCalledTimes(2)
      expect(fixture.reply.mock.calls[0][0].error).toBe('store unavailable')
      expect(fixture.reply.mock.calls[2][0].error).toBeUndefined()
    })
  })
}
