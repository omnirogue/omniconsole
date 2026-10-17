import { describe, expect, it, vi } from 'vitest'
import { DaemonRequestRouter } from './daemon-request-router'

describe('backward-compatible accepted input envelope', () => {
  it.each([true, false])(
    'returns actual owner acceptance %s and never repeats the write',
    async (accepted) => {
      const host = { write: vi.fn(), writeAccepted: vi.fn(() => accepted) }
      const attachments = { recordInput: vi.fn(), clearInput: vi.fn() }
      const router = new DaemonRequestRouter({
        host,
        attachments,
        connections: { get: () => undefined }
      } as never)
      expect(
        await router.route('client', {
          id: 'request',
          type: 'write',
          payload: { sessionId: 'p', data: '\r', requireAccepted: true }
        })
      ).toEqual({ accepted })
      expect(host.writeAccepted).toHaveBeenCalledExactlyOnceWith('p', '\r')
      expect(host.write).not.toHaveBeenCalled()
      expect(attachments.clearInput).toHaveBeenCalledTimes(accepted ? 0 : 1)
    }
  )

  it('keeps ordinary old-client writes and their empty receipt unchanged', async () => {
    const host = { write: vi.fn(), writeAccepted: vi.fn() }
    const router = new DaemonRequestRouter({
      host,
      attachments: { recordInput: vi.fn() },
      connections: { get: () => undefined }
    } as never)
    expect(
      await router.route('client', {
        id: 'request',
        type: 'write',
        payload: { sessionId: 'p', data: 'text' }
      })
    ).toEqual({})
    expect(host.write).toHaveBeenCalledExactlyOnceWith('p', 'text')
    expect(host.writeAccepted).not.toHaveBeenCalled()
  })
})
