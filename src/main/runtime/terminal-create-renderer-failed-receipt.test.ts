import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './omni-runtime'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import type { RpcContext } from './rpc/core'
import { setRuntimeDesktopSurface } from './runtime-desktop-surface'

const method = TERMINAL_METHODS.find((candidate) => candidate.name === 'terminal.create')!

function scenario(
  presentation: 'rendererBacked' | 'focus',
  failure: 'timeout' | 'reply' | 'handle'
) {
  const runtime = new OrcaRuntimeService()
  const tabId = randomUUID()
  let reply!: (event: Electron.IpcMainEvent, data: unknown) => void
  const send = vi.fn((_channel: string, request: { requestId: string }) => {
    if (failure !== 'timeout') {
      reply({ sender: webContents } as unknown as Electron.IpcMainEvent, {
        requestId: request.requestId,
        tabId,
        ...(failure === 'reply' ? { error: 'renderer receipt unavailable' } : {})
      })
    }
  })
  const webContents = { send }
  const win = { isDestroyed: () => false, webContents }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    findWindowById: () => win as never,
    onIpc: (_channel, handler) => {
      reply = handler as typeof reply
    },
    removeIpcListener: vi.fn()
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope(): Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: 'worktree-1',
    path: '/tmp/renderer-create',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const listProcesses = vi.fn(async () => [])
  runtime.setPtyController({ listProcesses } as never)
  const waitForTerminalHandle = vi
    .spyOn(
      runtime as unknown as { waitForTerminalHandle(tabId: string): Promise<string> },
      'waitForTerminalHandle'
    )
    .mockRejectedValue(new Error('terminal handle unavailable'))
  const mutationId = randomUUID()
  const create = () =>
    method.handler(
      {
        worktree: 'id:worktree-1',
        clientMutationId: mutationId,
        [presentation]: true
      },
      { runtime, clientId: 'device-a' } as RpcContext,
      vi.fn()
    ) as Promise<unknown>
  return { create, send, listProcesses, waitForTerminalHandle, runtime }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  setRuntimeDesktopSurface(null)
})

describe('renderer-backed terminal.create retries after lost receipts', () => {
  it.each(['rendererBacked', 'focus'] as const)(
    'retains a timed-out %s request without inventing a missing provider identity',
    async (presentation) => {
      vi.useFakeTimers()
      const { create, send, listProcesses } = scenario(presentation, 'timeout')
      const first = create()
      const failed = expect(first).rejects.toThrow('Terminal creation timed out')
      await vi.advanceTimersByTimeAsync(10_000)
      await failed
      const replay = create()
      const replayFailed = expect(replay).rejects.toThrow('Terminal creation timed out')
      await vi.advanceTimersByTimeAsync(10_000)
      await replayFailed
      expect(send).toHaveBeenCalledTimes(1)
      expect(listProcesses).not.toHaveBeenCalled()
    }
  )

  it.each(['reply', 'handle'] as const)(
    'retains the original rejection after renderer %s failure',
    async (failure) => {
      const { create, send, listProcesses } = scenario('rendererBacked', failure)
      const firstError = await create().catch((error: unknown) => error)
      const replayError = await create().catch((error: unknown) => error)
      expect(firstError).toBeInstanceOf(Error)
      expect(firstError).toMatchObject({ agentSessionOperationOutcome: 'unknown' })
      expect(replayError).toBe(firstError)
      expect(send).toHaveBeenCalledTimes(1)
      expect(listProcesses).not.toHaveBeenCalled()
    }
  )

  it('allows another attempt when graph readiness fails before renderer dispatch', async () => {
    const { create, send, waitForTerminalHandle, runtime } = scenario('rendererBacked', 'handle')
    vi.spyOn(
      runtime as unknown as { assertGraphReady(): void },
      'assertGraphReady'
    ).mockImplementationOnce(() => {
      throw new Error('graph not ready')
    })
    waitForTerminalHandle.mockResolvedValue('term_ready')
    await expect(create()).rejects.toThrow('graph not ready')
    expect(send).not.toHaveBeenCalled()
    await expect(create()).resolves.toMatchObject({ terminal: { handle: 'term_ready' } })
    expect(send).toHaveBeenCalledTimes(1)
  })
})
