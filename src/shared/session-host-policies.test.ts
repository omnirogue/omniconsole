import { describe, expect, it } from 'vitest'
import { normalizeSessionHostControlSettings } from './session-host-control-settings'
import {
  effectiveSessionHostControl,
  hostPolicyAckToPublish,
  hostSwitchState,
  policyEntriesToPublish,
  publishedPolicyKeys,
  readSyncedHostPolicies
} from './session-host-policies'
import type { SessionHostSyncEntry } from './session-host-sync-doc'
import { FIXTURE_HOST, FIXTURE_OTHER_HOST_ID } from './session-host-wire-fixtures'

const pol = (d: string, p: Record<string, unknown>, at: number) =>
  ({ k: 'pol', d, p, at }) as SessionHostSyncEntry

describe('overrides shared between this account’s computers', () => {
  it('sorts pol entries into folders, host switches and confirmations; the newest wins', () => {
    const synced = readSyncedHostPolicies([
      pol('folder-cs', { automation: 'off' }, 5),
      pol('folder-cs', {}, 9),
      pol(`host:${FIXTURE_HOST.hostId}`, { automation: 'off' }, 7),
      pol(`ack:${FIXTURE_OTHER_HOST_ID}`, { automation: 'off' }, 3),
      {
        k: 'rev',
        s: 'a'.repeat(24),
        f: 'title',
        op: 'op-1',
        why: 'x',
        at: 1
      } as SessionHostSyncEntry
    ])
    expect(synced).toEqual({
      folders: { 'folder-cs': { p: {}, at: 9 } },
      hosts: { [FIXTURE_HOST.hostId]: { p: { automation: 'off' }, at: 7 } },
      acks: { [FIXTURE_OTHER_HOST_ID]: { p: { automation: 'off' }, at: 3 } }
    })
  })

  it('takes the newest override from any Mac, which only ever switches things off', () => {
    const local = normalizeSessionHostControlSettings({
      folderPolicies: { ops: { automation: 'off' }, eng: {} }
    })
    const published = { ops: { p: { automation: 'off' as const }, at: 5 }, eng: { p: {}, at: 9 } }
    const synced = readSyncedHostPolicies([
      pol('cs', { automation: 'off' }, 1),
      // Another Mac switched ops back on after this one switched it off: the account's value is on.
      pol('ops', {}, 6),
      // This Mac switched eng back on after another switched it off: it stays on.
      pol('eng', { automation: 'off' }, 8),
      pol(`host:${FIXTURE_OTHER_HOST_ID}`, { automation: 'off' }, 1)
    ])
    const effective = effectiveSessionHostControl(local, synced, FIXTURE_HOST.hostId, published)
    expect(effective.folderPolicies).toEqual({ cs: { automation: 'off' } })
    // Another computer's switch is that computer's, not this one's.
    expect(effective.hostStewardship).toBe(true)
    const switchedOff = readSyncedHostPolicies([
      pol(`host:${FIXTURE_HOST.hostId}`, { automation: 'off' }, 1)
    ])
    expect(
      effectiveSessionHostControl(local, switchedOff, FIXTURE_HOST.hostId).hostStewardship
    ).toBe(false)
    const offHere = normalizeSessionHostControlSettings({ hostStewardship: false })
    expect(
      effectiveSessionHostControl(offHere, readSyncedHostPolicies([]), FIXTURE_HOST.hostId)
        .hostStewardship
    ).toBe(false)
    // An override this build cannot read reads as off, never as relaxed.
    const unreadable = readSyncedHostPolicies([pol('ops2', { automation: 'on' }, 1)])
    expect(effectiveSessionHostControl(local, unreadable, null).folderPolicies.ops2).toMatchObject({
      automation: 'off'
    })
  })

  it('publishes what changed, and an empty policy once an override is removed', () => {
    const now = 100
    const local = normalizeSessionHostControlSettings({
      folderPolicies: { ops: { automation: 'off' } },
      hostPolicies: { [FIXTURE_OTHER_HOST_ID]: { automation: 'off' } }
    })
    const first = policyEntriesToPublish(publishedPolicyKeys(local), {}, now)
    expect(first).toEqual([
      { k: 'pol', d: 'ops', p: { automation: 'off' }, at: now },
      { k: 'pol', d: `host:${FIXTURE_OTHER_HOST_ID}`, p: { automation: 'off' }, at: now }
    ])
    const published = Object.fromEntries(
      first.map((entry) => [entry.d, { p: entry.p, at: entry.at }])
    )
    expect(policyEntriesToPublish(publishedPolicyKeys(local), published, now + 1)).toEqual([])
    const cleared = normalizeSessionHostControlSettings({
      hostPolicies: { [FIXTURE_OTHER_HOST_ID]: { automation: 'off' } }
    })
    expect(policyEntriesToPublish(publishedPolicyKeys(cleared), published, now + 2)).toEqual([
      { k: 'pol', d: 'ops', p: {}, at: now + 2 }
    ])
  })

  it('owes one confirmation per host switch set on it, and none for what it already confirmed', () => {
    const synced = readSyncedHostPolicies([
      pol(`host:${FIXTURE_HOST.hostId}`, { automation: 'off' }, 7)
    ])
    const ack = hostPolicyAckToPublish(synced, FIXTURE_HOST.hostId, undefined)
    expect(ack).toEqual({
      k: 'pol',
      d: `ack:${FIXTURE_HOST.hostId}`,
      p: { automation: 'off' },
      at: 7
    })
    expect(hostPolicyAckToPublish(synced, FIXTURE_HOST.hostId, { p: ack!.p, at: 7 })).toBeNull()
    expect(hostPolicyAckToPublish(synced, FIXTURE_OTHER_HOST_ID, undefined)).toBeNull()
  })

  it('reads a host switch pending until that computer confirms exactly it', () => {
    const requested = { p: { automation: 'off' as const }, at: 10 }
    expect(hostSwitchState(requested, undefined)).toBe('pending')
    expect(hostSwitchState(requested, { p: { automation: 'off' }, at: 9 })).toBe('pending')
    expect(hostSwitchState(requested, { p: {}, at: 10 })).toBe('pending')
    expect(hostSwitchState(requested, { p: { automation: 'off' }, at: 10 })).toBe('applied')
  })
})
