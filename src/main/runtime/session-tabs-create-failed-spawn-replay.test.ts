import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from './rpc/core'
import { SESSION_TAB_METHODS } from './rpc/methods/session-tabs'
import { OrcaRuntimeService } from './omni-runtime'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'

const method = SESSION_TAB_METHODS.find(
  (candidate) => candidate.name === 'session.tabs.createTerminal'
)!

function scenario(connectionId: string | null = null) {
  const runtime = new OrcaRuntimeService()
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope(selector: string): Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockImplementation(async (selector) => ({
    id: selector.replace(/^id:/, ''),
    path: '/tmp/mobile-failed-create',
    connectionId,
    repo: null,
    folderWorkspace: null
  }))
  vi.spyOn(
    runtime as unknown as { resolveMobileSessionTerminalCommand(): Promise<unknown> },
    'resolveMobileSessionTerminalCommand'
  ).mockResolvedValue({ command: 'echo worker' })
  const live = new Set<string>()
  const spawn = vi.fn(async () => {
    const id = `worktree-1@@${randomUUID()}`
    live.add(id)
    return { id, incarnationId: randomUUID() }
  })
  runtime.setPtyController({ spawn } as never)
  const registration = vi.spyOn(
    runtime as unknown as {
      assertPtyDidNotExitBeforeRegistration(id: string, incarnationId?: string): void
    },
    'assertPtyDidNotExitBeforeRegistration'
  )
  registration.mockImplementationOnce(() => {
    throw new Error('registration unavailable after spawn')
  })
  const mutation = randomUUID()
  const create = (
    overrides: Record<string, unknown> = {},
    pairedDeviceId = 'device-a',
    signal?: AbortSignal
  ) =>
    method.handler(
      {
        worktree: 'id:worktree-1',
        clientMutationId: mutation,
        activate: false,
        select: false,
        navigation: 'caller',
        ...overrides
      },
      { runtime, pairedDeviceId, signal } as RpcContext,
      vi.fn()
    ) as Promise<unknown>
  return { runtime, create, spawn, registration, live }
}

afterEach(() => {
  setRuntimeDesktopSurface(null)
  vi.restoreAllMocks()
})

describe('session.tabs.createTerminal failed process receipts', () => {
  it('keeps same-ID retries from creating a second worker after registration failed', async () => {
    const { create, spawn, live } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    for (let retry = 0; retry < 3; retry++) {
      await expect(create()).rejects.toThrow('registration unavailable after spawn')
    }
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(1)
  })

  it('keeps the rejection fenced after the normal successful receipt window', async () => {
    const { create, spawn } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 60_001)
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('allows same-ID startup retry after a provider failure before process creation', async () => {
    const { create, spawn, registration, live } = scenario()
    registration.mockReset()
    spawn.mockRejectedValueOnce(new Error('provider unavailable before spawn'))
    await expect(create()).rejects.toThrow('provider unavailable before spawn')
    await create()
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(live.size).toBe(1)
  })

  it('holds a lost SSH reply even when the controller never received process birth', async () => {
    const { create, spawn, registration, live } = scenario('ssh-owner')
    registration.mockReset()
    const physicalSpawn = spawn.getMockImplementation()!
    spawn.mockImplementationOnce(async () => {
      await physicalSpawn()
      throw new Error('relay reply lost')
    })
    await expect(create()).rejects.toThrow('relay reply lost')
    await expect(create()).rejects.toThrow('relay reply lost')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(1)
  })

  it('keeps another paired person separate from a failed mutation with the same ID', async () => {
    const { create, spawn, live } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    await create({}, 'device-b')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(live.size).toBe(2)
  })

  it('keeps an intentional new mutation separate from the failed one', async () => {
    const { create, spawn, live } = scenario()
    await expect(create()).rejects.toThrow('registration unavailable after spawn')
    await create({ clientMutationId: randomUUID() })
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(live.size).toBe(2)
  })

  it('does not dispatch another renderer worker after a client loses its tab reply', async () => {
    const { create, runtime, spawn, registration, live } = scenario()
    registration.mockReset()
    let rendererSpawn: Promise<unknown> | undefined
    const send = vi.fn((channel: string) => {
      if (channel === 'terminal:requestTabCreate') {
        rendererSpawn = runtime.createTerminal('id:worktree-1', { presentation: 'background' })
      }
    })
    const win = {
      isDestroyed: () => false,
      webContents: {
        send,
        isDestroyed: () => false,
        getBackgroundThrottling: () => true,
        setBackgroundThrottling: vi.fn()
      }
    }
    setRuntimeDesktopSurface({
      showNotification: () => false,
      findWindowById: () => win as never,
      onIpc: vi.fn(),
      removeIpcListener: vi.fn()
    })
    runtime.attachWindow(7)
    runtime.syncWindowGraph(7, { tabs: [], leaves: [] })
    const controller = new AbortController()
    const pending = create({}, 'device-a', controller.signal)
    const failed = expect(pending).rejects.toThrow('client_disconnected')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await rendererSpawn
    controller.abort()
    await failed
    await expect(create()).rejects.toThrow('client_disconnected')
    expect(send).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(1)
  })
})
