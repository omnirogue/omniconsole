import { describe, expect, it, vi } from 'vitest'
import { workDeliveryApiOver } from './work-delivery-api'

describe('work-delivery receipt body', () => {
  it('adds path and latency_ms only when the receipt carries them', async () => {
    const send = vi.fn(async () => ({ status: 'ok' as const, value: {} }))
    const api = workDeliveryApiOver(send as never)
    await api.receipt('review:p:d1', 'host_mac', { state: 'typed' })
    await api.receipt('review:p:d1', 'host_mac', {
      state: 'typed',
      path: 'hook_stop',
      latencyMs: 0
    })
    expect(send.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { method: 'POST', body: { host_id: 'host_mac', state: 'typed' } },
      {
        method: 'POST',
        body: { host_id: 'host_mac', state: 'typed', path: 'hook_stop', latency_ms: 0 }
      }
    ])
  })
})
