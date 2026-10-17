import { describe, expect, it } from 'vitest'
import {
  deriveHostResourceView,
  formatBadgeGb,
  formatDetailGb,
  formatLoadPerCore,
  freestOkHost,
  hostLoadBand,
  hostLoadWarning,
  type HostResourceReading
} from './host-resource-model'

const GIB = 1024 ** 3

function reading(overrides: Partial<HostResourceReading> = {}): HostResourceReading {
  return {
    hostKey: 'ssh:mw0002',
    state: 'ok',
    readAt: 1_000,
    memory: {
      totalMemory: 32 * GIB,
      availableMemory: 12.4 * GIB,
      cpuCoreCount: 10,
      loadAverage1m: 3.2
    },
    liveSessions: 4,
    ...overrides
  }
}

describe('hostLoadBand', () => {
  it('is ok below 0.6, offload from 0.6 through 0.8, hot above 0.8', () => {
    expect(hostLoadBand(0)).toBe('ok')
    expect(hostLoadBand(0.59)).toBe('ok')
    expect(hostLoadBand(0.6)).toBe('offload')
    expect(hostLoadBand(0.8)).toBe('offload')
    expect(hostLoadBand(0.81)).toBe('hot')
    expect(hostLoadBand(3)).toBe('hot')
  })
})

describe('deriveHostResourceView', () => {
  it('derives free of total, load per core, band, sessions and age', () => {
    const view = deriveHostResourceView(reading(), 13_400)!
    expect(view.freeGb).toBeCloseTo(12.4)
    expect(view.totalGb).toBe(32)
    expect(view.loadPerCore).toBeCloseTo(0.32)
    expect(view.band).toBe('ok')
    expect(view.liveSessions).toBe(4)
    expect(view.ageSeconds).toBe(12)
  })

  it('has no numbers for a host that has not answered', () => {
    expect(deriveHostResourceView(reading({ state: 'unavailable' }), 0)).toBeNull()
    expect(deriveHostResourceView(reading({ state: 'checking', memory: null }), 0)).toBeNull()
    expect(deriveHostResourceView(null, 0)).toBeNull()
  })

  it('keeps an unknown session count unknown and guards malformed numbers', () => {
    const view = deriveHostResourceView(
      reading({
        liveSessions: null,
        readAt: null,
        memory: {
          totalMemory: 8 * GIB,
          availableMemory: 20 * GIB,
          cpuCoreCount: 0,
          loadAverage1m: Number.NaN
        }
      }),
      0
    )!
    expect(view.liveSessions).toBeNull()
    expect(view.ageSeconds).toBeNull()
    expect(view.freeGb).toBe(8)
    expect(view.cpuCoreCount).toBe(1)
    expect(view.loadPerCore).toBe(0)
  })

  it('bands a busy host hot', () => {
    const view = deriveHostResourceView(
      reading({
        memory: {
          totalMemory: 64 * GIB,
          availableMemory: 4 * GIB,
          cpuCoreCount: 8,
          loadAverage1m: 7.2
        }
      }),
      1_000
    )!
    expect(view.loadPerCore).toBeCloseTo(0.9)
    expect(view.band).toBe('hot')
  })
})

describe('GB formatting', () => {
  it('rounds for the badge and keeps one decimal in the tooltip', () => {
    expect(formatBadgeGb(12.4)).toBe('12')
    expect(formatBadgeGb(3.46)).toBe('3.5')
    expect(formatDetailGb(12.4)).toBe('12.4')
    expect(formatDetailGb(32)).toBe('32')
    expect(formatDetailGb(127.6)).toBe('128')
  })
})

describe('freestOkHost and hostLoadWarning', () => {
  const hosts = [
    { id: 'a', label: 'mw0002', loadPerCore: 0.9, available: true },
    { id: 'b', label: 'mw0003', loadPerCore: 0.4, available: true },
    { id: 'c', label: 'mw0004', loadPerCore: 0.1, available: true },
    { id: 'd', label: 'mw0005', loadPerCore: 0.05, available: false },
    { id: 'e', label: 'mw0006', loadPerCore: 0.7, available: true },
    { id: 'f', label: 'mw0007', loadPerCore: null, available: true }
  ]

  it('picks the lowest-load available ok host other than the target', () => {
    expect(freestOkHost(hosts, 'a')?.label).toBe('mw0004')
    expect(freestOkHost(hosts, 'c')?.label).toBe('mw0003')
  })

  it('warns only for a hot target, naming the freest ok host', () => {
    expect(hostLoadWarning(hosts, 'a')).toMatchObject({
      target: { label: 'mw0002', loadPerCore: 0.9 },
      suggestion: { label: 'mw0004' }
    })
    expect(hostLoadWarning(hosts, 'e')).toBeNull()
    expect(hostLoadWarning(hosts, 'f')).toBeNull()
    expect(hostLoadWarning(hosts, null)).toBeNull()
    expect(hostLoadWarning(hosts, 'missing')).toBeNull()
  })

  it('still warns with no suggestion when no other host is ok', () => {
    expect(
      hostLoadWarning(
        [
          { id: 'a', label: 'one', loadPerCore: 0.95, available: true },
          { id: 'b', label: 'two', loadPerCore: 0.7, available: true }
        ],
        'a'
      )
    ).toMatchObject({ suggestion: null })
  })
})

describe('formatLoadPerCore', () => {
  it('keeps the band edge readable with two decimals', () => {
    expect(formatLoadPerCore(0.32)).toBe('0.3')
    expect(formatLoadPerCore(0.84, 2)).toBe('0.84')
  })
})
