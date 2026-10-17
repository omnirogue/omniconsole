import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ oversized: vi.fn() }))
vi.mock('../shared/terminal-input', () => ({
  isTerminalInputTooLargeWithDeferredMeasurement: mocks.oversized
}))
import { acceptRelayPtyInput } from './pty-accepted-input'

describe('accepted input ownership after a size-measurement yield', () => {
  it.each(['replaced', 'disposed', 'disconnected', 'oversized'])(
    'does not deliver when %s while measuring',
    async (change) => {
      let measured!: (oversized: boolean) => void
      mocks.oversized.mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          measured = resolve
        })
      )
      let owner = { incarnationId: 'inc-owned', disposed: false }
      const isCurrent = vi.fn(() => true)
      const write = vi.fn(() => true)
      const result = acceptRelayPtyInput({
        params: { id: 'owned', incarnationId: 'inc-owned', data: 'payload' },
        getOwner: () => owner,
        write,
        isCurrent
      })
      if (change === 'replaced') {
        owner = { incarnationId: 'inc-owned', disposed: false }
      }
      if (change === 'disposed') {
        owner.disposed = true
      }
      if (change === 'disconnected') {
        isCurrent.mockReturnValue(false)
      }
      measured(change === 'oversized')
      await expect(result).resolves.toEqual({ accepted: false })
      expect(write).not.toHaveBeenCalled()
    }
  )
})
