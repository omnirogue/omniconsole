import { afterEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import {
  cancelRuntimeSessionInput,
  cancelRuntimeSessionInputVerified
} from './runtime-session-input'

afterEach(() => vi.unstubAllGlobals())

describe('verified host input-queue cancellation', () => {
  it('requires the host acknowledgement for the exact PTY and selected origin', async () => {
    const cancelSessionInput = vi.fn(async () => true)
    vi.stubGlobal('window', { api: { pty: { cancelSessionInput } } })
    expect(await cancelRuntimeSessionInputVerified('ssh:target@@pty', { origin: 'chat' })).toBe(
      true
    )
    expect(cancelSessionInput).toHaveBeenCalledExactlyOnceWith('ssh:target@@pty', {
      origin: 'chat'
    })
  })

  it.each(['refused', 'missing', 'unavailable'] as const)(
    'does not treat %s cancellation as acknowledged',
    async (mode) => {
      const cancelSessionInput = vi.fn(async () => false)
      if (mode === 'unavailable') {
        cancelSessionInput.mockRejectedValue(new Error('IPC unavailable'))
      }
      vi.stubGlobal('window', { api: { pty: mode === 'missing' ? {} : { cancelSessionInput } } })
      expect(await cancelRuntimeSessionInputVerified('local-pty', { origin: 'chat' })).toBe(false)
      await expect(
        cancelRuntimeSessionInput('local-pty', { origin: 'chat' })
      ).resolves.toBeUndefined()
    }
  )

  it('does not ask the client queue to cancel a paired runtime that uses renderer-serialized input', async () => {
    const cancelSessionInput = vi.fn(async () => false)
    vi.stubGlobal('window', { api: { pty: { cancelSessionInput } } })
    const ptyId = toRemoteRuntimePtyId('term-owned', 'runtime-owner')
    expect(await cancelRuntimeSessionInputVerified(ptyId, { origin: 'chat' })).toBe(true)
    expect(cancelSessionInput).not.toHaveBeenCalled()
  })
})
