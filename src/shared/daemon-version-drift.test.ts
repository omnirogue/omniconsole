import { describe, expect, it } from 'vitest'
import { isAnyPtyBusy, resolveDaemonVersionDrift } from './daemon-version-drift'

describe('resolveDaemonVersionDrift', () => {
  it('flags a daemon whose recorded appVersion differs from the running app', () => {
    expect(resolveDaemonVersionDrift({ daemonAppVersion: '1.9.0', appVersion: '1.9.4' })).toEqual({
      drifted: true,
      daemonVersion: '1.9.0'
    })
  })

  it('stays quiet when the daemon matches the app', () => {
    expect(resolveDaemonVersionDrift({ daemonAppVersion: '1.9.4', appVersion: '1.9.4' })).toEqual({
      drifted: false,
      daemonVersion: '1.9.4'
    })
  })

  it('stays quiet when the daemon version is unknown (no pid record, pre-metadata daemon, web client)', () => {
    expect(resolveDaemonVersionDrift({ daemonAppVersion: null, appVersion: '1.9.4' }).drifted).toBe(
      false
    )
    expect(resolveDaemonVersionDrift({ daemonAppVersion: '1.9.0', appVersion: '' }).drifted).toBe(
      false
    )
    expect(resolveDaemonVersionDrift(null).drifted).toBe(false)
  })
})

describe('isAnyPtyBusy', () => {
  it('is false when every pane is idle or unknown', () => {
    expect(isAnyPtyBusy({})).toBe(false)
    expect(
      isAnyPtyBusy({
        a: { state: 'done' },
        b: { state: 'waiting' },
        c: undefined
      })
    ).toBe(false)
  })

  it('is true while any pane is working or blocked on a permission', () => {
    expect(isAnyPtyBusy({ a: { state: 'done' }, b: { state: 'working' } })).toBe(true)
    expect(isAnyPtyBusy({ a: { state: 'blocked' } })).toBe(true)
  })
})
