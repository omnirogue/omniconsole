import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../omni-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import { waitForLeafPtyIdAllowingQueuedAgentStart } from './methods/terminal/terminal-leaf-pty-wait'

// Why: the phone opening a held agent pane starts it through main's app-wide admission window
// (3 starts per 10 s). Even the person lane can wait up to one window for a slot, as long as the
// subscribe's own 10 s PTY wait — so the wait must keep going while that pane's start is pending
// instead of falling back to bare scrollback a moment before the agent starts.

const timeout = (): Error => new Error('Timed out waiting for PTY to spawn')

describe('waiting for a subscribed terminal PTY behind a queued agent start', () => {
  it('keeps waiting while the pane start is queued or just admitted, then gets the PTY', async () => {
    const waitForLeafPtyId = vi
      .fn<(handle: string, timeoutMs: number, signal?: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce('pty-1')
    const isAgentStartPendingForHandle = vi.fn(() => true)
    await expect(
      waitForLeafPtyIdAllowingQueuedAgentStart(
        { waitForLeafPtyId, isAgentStartPendingForHandle },
        'terminal-1',
        undefined
      )
    ).resolves.toBe('pty-1')
    expect(waitForLeafPtyId).toHaveBeenCalledTimes(2)
    expect(waitForLeafPtyId).toHaveBeenNthCalledWith(1, 'terminal-1', 10_000, undefined)
    expect(isAgentStartPendingForHandle).toHaveBeenCalledWith('terminal-1')
  })

  it('gives up as before when no start is pending, when aborted, or past the ceiling', async () => {
    const neverStarting = vi.fn(async () => {
      throw timeout()
    })
    await expect(
      waitForLeafPtyIdAllowingQueuedAgentStart(
        { waitForLeafPtyId: neverStarting, isAgentStartPendingForHandle: () => false },
        'terminal-1',
        undefined
      )
    ).rejects.toThrow('Timed out')
    expect(neverStarting).toHaveBeenCalledTimes(1)

    const controller = new AbortController()
    controller.abort()
    const aborted = vi.fn(async () => {
      throw new Error('request_aborted')
    })
    await expect(
      waitForLeafPtyIdAllowingQueuedAgentStart(
        { waitForLeafPtyId: aborted, isAgentStartPendingForHandle: () => true },
        'terminal-1',
        controller.signal
      )
    ).rejects.toThrow('request_aborted')
    expect(aborted).toHaveBeenCalledTimes(1)

    let clock = 0
    const wedged = vi.fn(async () => {
      clock += 10_000
      throw timeout()
    })
    await expect(
      waitForLeafPtyIdAllowingQueuedAgentStart(
        { waitForLeafPtyId: wedged, isAgentStartPendingForHandle: () => true },
        'terminal-1',
        undefined,
        () => clock
      )
    ).rejects.toThrow('Timed out')
    expect(wedged).toHaveBeenCalledTimes(30)
  })
})

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    subscribeToPtyExit: vi.fn(() => vi.fn()),
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    getRendererTerminalSerializerGenerationForHandle: () => 0,
    getRendererTerminalSerializerGeneration: () => 0,
    waitForRendererTerminalSerializer: async () => false,
    getPtyOutputSequence: () => 0,
    hasHeadlessTerminalState: () => true,
    ...overrides
  } as OrcaRuntimeService
}

const makeRequest = (method: string, params?: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

describe("the phone's per-terminal open", () => {
  it('asks the renderer to mount the tab as a person opening it', async () => {
    const requestRendererTerminalTabMount = vi.fn(() => true)
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId: vi.fn().mockRejectedValue(timeout()),
      isAgentStartPendingForHandle: vi.fn(() => false),
      requestRendererTerminalTabMount,
      readTerminal: vi.fn().mockResolvedValue({ tail: ['scrollback'], truncated: false })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    await dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      vi.fn(),
      { connectionId: 'conn-phone', sendBinary: vi.fn(), registerBinaryStreamHandler: vi.fn() }
    )
    expect(requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1', {
      personOpen: true
    })
  })
})
