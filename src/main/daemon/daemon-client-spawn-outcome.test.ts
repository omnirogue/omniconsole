import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonPendingRequests } from './daemon-client-pending-requests'
import { requestDaemonRpc } from './daemon-client-rpc-request'
import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import { DaemonConnectionLostError } from './types'
import { NDJSON_MAX_LINE_BYTES } from './ndjson'

afterEach(() => vi.useRealTimers())

function requestScenario(type = 'createOrAttach', signal?: AbortSignal) {
  const pendingRequests = new DaemonPendingRequests()
  const write = vi.fn()
  const settleCreateCancellation = vi.fn(async () => ({ canceled: false }))
  const request = (payload: unknown = { sessionId: 'local-worker' }, timeoutMs = 30_000) =>
    requestDaemonRpc({
      socket: { write } as unknown as Socket,
      pendingRequests,
      id: 'spawn-1',
      type,
      payload,
      timeoutMs,
      ...(signal ? { signal } : {}),
      unmatchedCancelGraceMs: 10,
      onCreateCancellationFailure: () => pendingRequests.rejectAll('Connection lost'),
      settleCreateCancellation
    })
  return { request, write, pendingRequests, settleCreateCancellation }
}

describe('daemon create request outcome at socket dispatch', () => {
  it.each(['createOrAttach', 'prepareLaunch', 'prepareObservedLaunch'])(
    'retains %s uncertainty when its process exists but the reply is lost',
    async (type) => {
      const { request, write, pendingRequests } = requestScenario(type)
      let physicalProcesses = 0
      write.mockImplementation(() => {
        physicalProcesses += 1
        queueMicrotask(() => pendingRequests.rejectAll('Connection lost'))
      })
      const error = await request().catch((error: unknown) => error)
      expect(error).toBeInstanceOf(DaemonConnectionLostError)
      expect(error).toMatchObject({ agentSessionOperationOutcome: 'unknown' })
      expect(physicalProcesses).toBe(1)
      expect(pendingRequests.size).toBe(0)
    }
  )

  it('preserves a non-create request transport error', async () => {
    const { request, pendingRequests } = requestScenario('listSessions')
    const result = request()
    pendingRequests.rejectAll('Connection lost')
    const error = await result.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(DaemonConnectionLostError)
    expect(error).not.toHaveProperty('agentSessionOperationOutcome')
  })

  it('leaves a request aborted before dispatch retryable', async () => {
    const abort = new AbortController()
    abort.abort()
    const { request, write, pendingRequests } = requestScenario('createOrAttach', abort.signal)
    const error = await request().catch((error: unknown) => error)
    expect(error).toMatchObject({ message: 'client_disconnected' })
    expect(error).not.toHaveProperty('agentSessionOperationOutcome')
    expect(write).not.toHaveBeenCalled()
    expect(pendingRequests.size).toBe(0)
  })

  it('leaves local encoding refusal retryable without dispatching', () => {
    const { request, write } = requestScenario()
    let failure: unknown
    try {
      request({ sessionId: 'local-worker', command: 'x'.repeat(NDJSON_MAX_LINE_BYTES) })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toHaveProperty('agentSessionOperationOutcome')
    expect(write).not.toHaveBeenCalled()
  })

  it('leaves a socket write that refused dispatch retryable', async () => {
    const { request, write } = requestScenario()
    write.mockImplementation(() => {
      throw new Error('socket write refused')
    })
    const error = await request().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(DaemonConnectionLostError)
    expect(error).not.toHaveProperty('agentSessionOperationOutcome')
  })

  it.each(['pty_launch_gate_request_invalid'])(
    'preserves the owner refusal %s',
    async (message) => {
      const { request, pendingRequests } = requestScenario()
      const result = request()
      pendingRequests.settle({ id: 'spawn-1', ok: false, error: message })
      const error = await result.catch((error: unknown) => error)
      expect(error).toMatchObject({ message })
      expect(error).not.toHaveProperty('agentSessionOperationOutcome')
    }
  )

  it('retains cancellation-reply uncertainty because a completed session can be detached', async () => {
    const { request, pendingRequests } = requestScenario()
    const result = request()
    pendingRequests.settle({
      id: 'spawn-1',
      ok: false,
      error: 'Attach canceled for session local-worker'
    })
    const error = await result.catch((error: unknown) => error)
    expect(error).toMatchObject({ agentSessionOperationOutcome: 'unknown' })
  })

  it.each([true, false])(
    'retains expiry uncertainty when cancellation only acknowledges the preparation (%s)',
    async (canceled) => {
      vi.useFakeTimers()
      const { request, settleCreateCancellation } = requestScenario()
      settleCreateCancellation.mockResolvedValue({ canceled })
      const result = request(undefined, 10).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(20)
      expect(await result).toMatchObject({ agentSessionOperationOutcome: 'unknown' })
    }
  )

  it('never automatically respawns a daemon for a dispatched create with no owner receipt', async () => {
    const failure = Object.assign(new DaemonConnectionLostError('Connection lost'), {
      agentSessionOperationOutcome: 'unknown' as const
    })
    const operation = vi.fn(async () => {
      throw failure
    })
    const doRespawn = vi.fn(async () => {})
    const recovery = {
      isRetiredEndpointTokenMissing: () => false,
      respawnAdoptionClosed: false,
      respawnFn: doRespawn,
      doRespawn
    }
    const withRetry = (
      DaemonPtyDaemonRecovery.prototype as unknown as {
        withDaemonRetry: (operation: () => Promise<unknown>) => Promise<unknown>
      }
    ).withDaemonRetry.bind(recovery)
    await expect(withRetry(operation)).rejects.toBe(failure)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(doRespawn).not.toHaveBeenCalled()
  })
})
