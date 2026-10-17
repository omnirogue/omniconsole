import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

// Why: an agent start can wait minutes in main's app-wide admission queue. If its pane goes away
// meanwhile (tab closed, workspace unmounted, pane remounted), destroying the transport must
// cancel exactly that queued start, or it would run later with no pane to show it.

describe('IPC transport agent start cancellation', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    vi.resetModules()
    installIpcPtyWindow(originalWindow, {})
    ;(window.api.pty as unknown as { cancelAgentLaunch: unknown }).cancelAgentLaunch = vi.fn(
      async () => true
    )
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  function spawnMock(): ReturnType<typeof vi.fn> {
    return window.api.pty.spawn as unknown as ReturnType<typeof vi.fn>
  }

  function cancelMock(): ReturnType<typeof vi.fn> {
    return (window.api.pty as unknown as { cancelAgentLaunch: ReturnType<typeof vi.fn> })
      .cancelAgentLaunch
  }

  it('cancels the queued start it spawned when destroyed before main answers', async () => {
    let answer: (reply: { id: string; coldRestore?: unknown }) => void = () => {}
    spawnMock().mockImplementation(
      () => new Promise((resolve) => (answer = resolve as typeof answer))
    )
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})
    const connecting = transport.connect({
      url: '',
      command: 'codex resume thread-1',
      launchAdmissionKey: 'tab-1:leaf-1',
      callbacks: {}
    })
    await Promise.resolve()
    await Promise.resolve()
    const token = (spawnMock().mock.calls[0][0] as { launchAdmissionToken?: string })
      .launchAdmissionToken
    expect(token).toEqual(expect.any(String))

    transport.destroy?.()
    expect(cancelMock()).toHaveBeenCalledTimes(1)
    expect(cancelMock()).toHaveBeenCalledWith(token)

    // A start admitted just before the cancel still resolves; the destroyed transport retires it.
    answer({ id: 'late-pty' })
    await connecting
    expect(window.api.pty.kill).toHaveBeenCalledWith('late-pty')
  })

  it('reports a start main dropped from its queue, so the pane that asked can be mounted again', async () => {
    spawnMock().mockImplementation(() => new Promise(() => {}))
    const { subscribeAgentStartAbandoned } = await import('@/lib/agent-start-in-flight')
    const abandoned: string[] = []
    const unsubscribe = subscribeAgentStartAbandoned((paneKey) => abandoned.push(paneKey))
    const { createIpcPtyTransport } = await import('./pty-transport')
    const queued = createIpcPtyTransport({})
    void queued.connect({
      url: '',
      command: 'codex resume thread-1',
      launchAdmissionKey: 'tab-1:leaf-1',
      callbacks: {}
    })
    await Promise.resolve()
    await Promise.resolve()
    queued.destroy?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(abandoned).toEqual(['tab-1:leaf-1'])

    // Main had already admitted it (no longer queued): nothing was dropped, nothing to report.
    cancelMock().mockResolvedValueOnce(false)
    const admitted = createIpcPtyTransport({})
    void admitted.connect({
      url: '',
      command: 'codex resume thread-2',
      launchAdmissionKey: 'tab-2:leaf-1',
      callbacks: {}
    })
    await Promise.resolve()
    await Promise.resolve()
    admitted.destroy?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(abandoned).toEqual(['tab-1:leaf-1'])
    unsubscribe()
  })

  it('gives every start its own token and never cancels a settled one', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const agentStart = { url: '', command: 'codex', launchAdmissionKey: 'tab-1:leaf-1' }
    const first = createIpcPtyTransport({})
    await first.connect({ ...agentStart, callbacks: {} })
    const second = createIpcPtyTransport({})
    await second.connect({ ...agentStart, callbacks: {} })
    const tokens = spawnMock().mock.calls.map(
      ([args]) => (args as { launchAdmissionToken?: string }).launchAdmissionToken
    )
    expect(new Set(tokens).size).toBe(2)

    // Its spawn already answered: destroying it has nothing to cancel.
    first.destroy?.()
    expect(cancelMock()).not.toHaveBeenCalled()
  })

  it('sends no token for a plain shell connect', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})
    await transport.connect({ url: '', callbacks: {} })
    expect(spawnMock()).toHaveBeenCalledWith(
      expect.not.objectContaining({ launchAdmissionToken: expect.anything() })
    )
    transport.destroy?.()
    expect(cancelMock()).not.toHaveBeenCalled()
  })

  it('swallows the cancelled error of its own destroyed start', async () => {
    let fail: (error: Error) => void = () => {}
    spawnMock().mockImplementation(
      () => new Promise((_resolve, reject) => (fail = reject as typeof fail))
    )
    const onError = vi.fn()
    const { createIpcPtyTransport } = await import('./pty-transport')
    const transport = createIpcPtyTransport({})
    const connecting = transport.connect({
      url: '',
      command: 'codex resume thread-1',
      launchAdmissionKey: 'tab-1:leaf-1',
      callbacks: { onError }
    })
    await Promise.resolve()
    transport.destroy?.()
    fail(new Error("Error invoking remote method 'pty:spawn': Error: agent_launch_cancelled"))
    await expect(connecting).resolves.toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
  })
})
