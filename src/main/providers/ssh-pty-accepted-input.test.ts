import { describe, expect, it, vi } from 'vitest'
import { createSshPtyAcceptedWriter } from './ssh-pty-accepted-input'
import { createMockMux } from './ssh-pty-provider-mock-multiplexer'

function setup() {
  const mux = createMockMux()
  const hasPty = vi.fn(() => true)
  const getIncarnation = vi.fn((): string | undefined => 'inc-owned')
  mux.request.mockImplementation(async (method: string) =>
    method === 'pty.getCapabilities'
      ? { acceptedInputVersion: 1 }
      : { accepted: true, incarnationId: 'inc-owned' }
  )
  const write = createSshPtyAcceptedWriter({
    mux: mux as never,
    toRelayPtyId: () => 'remote-pty',
    hasPty,
    getIncarnation
  })
  return { mux, hasPty, getIncarnation, write }
}

describe('SSH host-acknowledged input', () => {
  it('negotiates once and sends each control to the captured remote incarnation', async () => {
    const { mux, write } = setup()
    await expect(write('ssh:owner@@remote-pty', '\x1b[A')).resolves.toBe(true)
    await expect(write('ssh:owner@@remote-pty', '\r')).resolves.toBe(true)
    expect(mux.request.mock.calls.map(([method]) => method)).toEqual([
      'pty.getCapabilities',
      'pty.writeAccepted',
      'pty.writeAccepted'
    ])
    expect(mux.request.mock.calls[1]?.[1]).toEqual({
      id: 'remote-pty',
      incarnationId: 'inc-owned',
      data: '\x1b[A'
    })
    expect(mux.notify).not.toHaveBeenCalled()
  })

  it.each([undefined, {}, { acceptedInputVersion: 2 }])(
    'keeps an older/unknown relay unconfirmed (%j)',
    async (capabilities) => {
      const { mux, write } = setup()
      mux.request.mockResolvedValue(capabilities)
      await expect(write('owned', '\r')).resolves.toBe(false)
      expect(mux.request).toHaveBeenCalledOnce()
      expect(mux.notify).not.toHaveBeenCalled()
    }
  )

  it('can discover support after the same connection upgrades its older relay', async () => {
    const { mux, write } = setup()
    mux.request.mockResolvedValueOnce({})
    await expect(write('owned', '\r')).resolves.toBe(false)
    await expect(write('owned', '\r')).resolves.toBe(true)
    expect(mux.request.mock.calls.map(([method]) => method)).toEqual([
      'pty.getCapabilities',
      'pty.getCapabilities',
      'pty.writeAccepted'
    ])
  })

  it.each(['exited', 'replaced', 'disconnected', 'lease changed'])(
    'refuses input after %s during capability negotiation',
    async (change) => {
      const { mux, write, hasPty, getIncarnation } = setup()
      let answer!: (value: unknown) => void
      mux.request.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve
        })
      )
      const isCurrent = vi.fn(() => true)
      const result = write('owned', '\r', { isCurrent })
      if (change === 'exited') {
        hasPty.mockReturnValue(false)
      }
      if (change === 'replaced') {
        getIncarnation.mockReturnValue('inc-replacement')
      }
      if (change === 'disconnected') {
        mux.isDisposed.mockReturnValue(true)
      }
      if (change === 'lease changed') {
        isCurrent.mockReturnValue(false)
      }
      answer({ acceptedInputVersion: 1 })
      await expect(result).resolves.toBe(false)
      expect(mux.request).toHaveBeenCalledOnce()
      expect(mux.notify).not.toHaveBeenCalled()
    }
  )

  it.each([{ accepted: false }, { accepted: true, incarnationId: 'other' }, undefined])(
    'does not treat an unconfirmed response as acceptance or replay input (%j)',
    async (response) => {
      const { mux, write } = setup()
      mux.request.mockResolvedValueOnce({ acceptedInputVersion: 1 }).mockResolvedValueOnce(response)
      await expect(write('owned', '\r')).resolves.toBe(false)
      expect(mux.request).toHaveBeenCalledTimes(2)
      expect(mux.notify).not.toHaveBeenCalled()
    }
  )

  it('does not replay after losing the input acknowledgement', async () => {
    const { mux, write } = setup()
    mux.request
      .mockResolvedValueOnce({ acceptedInputVersion: 1 })
      .mockRejectedValueOnce(new Error('reply lost'))
    await expect(write('owned', '\r')).resolves.toBe(false)
    expect(mux.request).toHaveBeenCalledTimes(2)
    expect(mux.notify).not.toHaveBeenCalled()
  })

  it('does not share capability evidence between different execution hosts', async () => {
    const modern = setup()
    const old = setup()
    old.mux.request.mockResolvedValue({})
    await expect(modern.write('owned', '\r')).resolves.toBe(true)
    await expect(old.write('owned', '\r')).resolves.toBe(false)
    expect(old.mux.request).toHaveBeenCalledOnce()
  })
})
