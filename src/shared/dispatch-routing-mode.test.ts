import { describe, expect, it } from 'vitest'
import { resolveDispatchRoutingMode as resolve } from './dispatch-routing-mode'

describe('host routing control', () => {
  it.each(['off', 'shadow'] as const)('host %s overrides live and persisted choices', (host) => {
    expect(resolve(host, 'live')).toBe(host)
    expect(resolve(host)).toBe(host)
  })
  it('preserves narrower request modes while live and defaults existing hosts to live', () => {
    expect(resolve('live', 'off')).toBe('off')
    expect(resolve('live', 'shadow')).toBe('shadow')
    expect(resolve(undefined)).toBe('live')
  })
})
