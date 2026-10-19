import { describe, expect, it, vi } from 'vitest'
import { SESSION_HOST_RPC } from '../../shared/session-host-protocol'
import {
  runtimeSessionHostTransport,
  sshSessionHostTransport,
  type RuntimeSessionHostRequest
} from './session-host-client-transports'

describe('session host request timeouts', () => {
  it('gives a restart time to come back with its agent’s 30 s proof; everything else keeps 30 s', async () => {
    const request = vi.fn<RuntimeSessionHostRequest>(
      async () => ({ ok: true, result: {}, _meta: { runtimeId: 'r1' } }) as never
    )
    const transport = runtimeSessionHostTransport(request)
    await transport.call(SESSION_HOST_RPC.execute, { action: 'restart' })
    await transport.call(SESSION_HOST_RPC.execute, { action: 'stop' })
    await transport.call(SESSION_HOST_RPC.observe, {})
    expect(request.mock.calls.map((call) => call[2])).toEqual([45_000, 30_000, 30_000])

    const mux = { request: vi.fn(async () => ({})) }
    const ssh = sshSessionHostTransport({
      mux: () => mux,
      connection: () => 'c1',
      clientHostId: 'h'
    })
    await ssh.call(SESSION_HOST_RPC.execute, { action: 'restart' })
    expect(mux.request).toHaveBeenCalledWith(
      SESSION_HOST_RPC.execute,
      { action: 'restart' },
      {
        timeoutMs: 45_000
      }
    )
  })
})
