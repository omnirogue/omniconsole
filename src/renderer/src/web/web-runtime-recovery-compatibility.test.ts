import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime-client-error-classification'
import { WebRuntimeConnectionWaiters } from './web-runtime-connection-waiters'
import { WebRuntimeRequestRegistry } from './web-runtime-request-registry'

beforeEach(() => {
  vi.stubGlobal('window', globalThis)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function classify(error: unknown) {
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
}
function waiters(state: 'connecting' | 'auth-failed' = 'connecting') {
  return new WebRuntimeConnectionWaiters({
    endpoint: 'https://synthetic.example',
    getState: () => state,
    isIntentionallyClosed: () => false
  })
}

describe('actual web transport errors retain recovery classification', () => {
  it('retries a real unavailable connection error', async () => {
    const connection = waiters()
    const rejected = connection.wait().catch((error: unknown) => error)
    connection.rejectUnavailable()
    expect(classify(await rejected)).toBe(true)
  })
  it('retries the actual connection timeout error', async () => {
    const rejected = waiters()
      .wait(10)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    expect(classify(await rejected)).toBe(true)
  })
  it('retries a request that lost its connection before send', async () => {
    const registry = new WebRuntimeRequestRegistry({
      deviceToken: 'synthetic',
      nextId: () => '1',
      waitForConnected: async () => undefined,
      sendEncrypted: () => false
    })
    expect(classify(await registry.call('synthetic.read').catch((error: unknown) => error))).toBe(
      true
    )
    expect(registry.pending.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps real authentication rejection fatal', async () => {
    expect(
      classify(
        await waiters('auth-failed')
          .wait()
          .catch((error: unknown) => error)
      )
    ).toBe(false)
  })
  it.each(['Orca', 'Omni', 'OmniConsole'])(
    'supports %s legacy messages without overriding explicit fatal codes',
    (brand) => {
      for (const text of [
        `Remote ${brand} runtime connection closed.`,
        `Remote ${brand} runtime connection interrupted.`,
        `Timed out while connecting to the remote ${brand} runtime.`
      ]) {
        expect(classify(new Error(text))).toBe(true)
        for (const code of ['unauthorized', 'invalid_runtime_response', 'unknown_code']) {
          expect(classify(Object.assign(new Error(text), { code }))).toBe(false)
        }
      }
      expect(classify(new Error(`Remote ${brand} runtime rejected the device token.`))).toBe(false)
      expect(classify(new Error('Remote unrelated runtime connection closed.'))).toBe(false)
    }
  )
})
