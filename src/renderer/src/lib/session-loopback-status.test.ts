import { describe, expect, it, vi } from 'vitest'
import { probeSessionLoopbackUrls } from './session-loopback-status'
describe('session loopback ownership', () => {
  it.each(['ssh:server', 'runtime:paired', null, undefined])(
    'never probes client loopback for %s',
    async (host) => {
      const probe = vi.fn(async () => 'live' as const)
      expect(
        (await probeSessionLoopbackUrls(['http://localhost:3000'], host, probe)).get(
          'http://localhost:3000'
        )
      ).toBe('unverifiable')
      expect(probe).not.toHaveBeenCalled()
    }
  )
  it('only claims stopped from an explicit closed-port result', async () => {
    expect(
      (
        await probeSessionLoopbackUrls(['http://localhost:3000'], 'local', async () => {
          throw new Error('transport')
        })
      ).get('http://localhost:3000')
    ).toBe('unverifiable')
    expect(
      (
        await probeSessionLoopbackUrls(['http://localhost:3000'], 'local', async () => 'stopped')
      ).get('http://localhost:3000')
    ).toBe('stopped')
  })
})
