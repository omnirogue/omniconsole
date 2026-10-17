import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getAllDrivers,
  getDriverForPty,
  getDriverReleasedAtForPty,
  hydrateDrivers,
  isPtyLocked,
  onDriverChange,
  replaceDriverPtyId,
  setDriverForPty
} from './mobile-driver-state'

afterEach(() => {
  hydrateDrivers([])
  vi.useRealTimers()
})

describe('mobile-driver-state', () => {
  it('stores and clears driver state keyed by PTY id', () => {
    setDriverForPty('pty-1', { kind: 'mobile', clientId: 'phone-1' })

    expect(getDriverForPty('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-1' })
    expect(isPtyLocked('pty-1')).toBe(true)

    setDriverForPty('pty-1', { kind: 'idle' })

    expect(getDriverForPty('pty-1')).toEqual({ kind: 'idle' })
    expect(isPtyLocked('pty-1')).toBe(false)
  })

  it('returns a defensive snapshot of all non-idle drivers', () => {
    setDriverForPty('pty-1', { kind: 'mobile', clientId: 'phone-1' })
    setDriverForPty('pty-2', { kind: 'desktop' })

    const drivers = getAllDrivers()
    expect([...drivers.entries()]).toEqual([
      ['pty-1', { kind: 'mobile', clientId: 'phone-1' }],
      ['pty-2', { kind: 'desktop' }]
    ])
    drivers.clear()

    expect(getDriverForPty('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-1' })
    expect(getDriverForPty('pty-2')).toEqual({ kind: 'desktop' })
  })

  it('moves a presence lock when a provider replaces the PTY identity', () => {
    setDriverForPty('pty-old', { kind: 'mobile', clientId: 'phone-1' })

    replaceDriverPtyId('pty-old', 'pty-new')

    expect(getDriverForPty('pty-old')).toEqual({ kind: 'idle' })
    expect(getDriverForPty('pty-new')).toEqual({ kind: 'mobile', clientId: 'phone-1' })
    expect([...getAllDrivers().keys()]).toEqual(['pty-new'])
  })

  it('hydrates driver snapshots and notifies affected listeners', () => {
    setDriverForPty('pty-old', { kind: 'mobile', clientId: 'phone-old' })
    const listener = vi.fn()
    const unsub = onDriverChange(listener)

    hydrateDrivers([{ ptyId: 'pty-new', driver: { kind: 'mobile', clientId: 'phone-new' } }])

    expect(getDriverForPty('pty-old')).toEqual({ kind: 'idle' })
    expect(getDriverForPty('pty-new')).toEqual({ kind: 'mobile', clientId: 'phone-new' })
    expect(listener).toHaveBeenCalledWith({
      ptyId: 'pty-old',
      driver: { kind: 'idle' }
    })
    expect(listener).toHaveBeenCalledWith({
      ptyId: 'pty-new',
      driver: { kind: 'mobile', clientId: 'phone-new' }
    })

    unsub()
  })

  it('remembers when a person let go of a PTY, across a handle rotation and a hydration', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    expect(getDriverReleasedAtForPty('pty-release')).toBeUndefined()
    // Releasing a seat nobody held is not a release.
    setDriverForPty('pty-release', { kind: 'idle' })
    expect(getDriverReleasedAtForPty('pty-release')).toBeUndefined()

    setDriverForPty('pty-release', { kind: 'mobile', clientId: 'phone-1' })
    expect(getDriverReleasedAtForPty('pty-release')).toBeUndefined()
    vi.setSystemTime(1_060_000)
    setDriverForPty('pty-release', { kind: 'idle' })
    expect(getDriverReleasedAtForPty('pty-release')).toBe(1_060_000)

    replaceDriverPtyId('pty-release', 'pty-release-2')
    expect(getDriverReleasedAtForPty('pty-release')).toBeUndefined()
    expect(getDriverReleasedAtForPty('pty-release-2')).toBe(1_060_000)

    setDriverForPty('pty-hydrated', { kind: 'desktop' })
    vi.setSystemTime(1_120_000)
    hydrateDrivers([])
    expect(getDriverReleasedAtForPty('pty-hydrated')).toBe(1_120_000)
  })

  it('does not stamp the old handle of a PTY a person still drives, and forgets old releases', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    setDriverForPty('pty-rotating', { kind: 'mobile', clientId: 'phone-1' })
    replaceDriverPtyId('pty-rotating', 'pty-rotated')
    expect(getDriverReleasedAtForPty('pty-rotating')).toBeUndefined()
    expect(getDriverForPty('pty-rotated')).toEqual({ kind: 'mobile', clientId: 'phone-1' })

    setDriverForPty('pty-rotated', { kind: 'idle' })
    expect(getDriverReleasedAtForPty('pty-rotated')).toBe(2_000_000)
    vi.setSystemTime(2_000_000 + 61 * 60_000)
    setDriverForPty('pty-other', { kind: 'mobile', clientId: 'phone-2' })
    setDriverForPty('pty-other', { kind: 'idle' })
    expect(getDriverReleasedAtForPty('pty-rotated')).toBeUndefined()
  })
})
