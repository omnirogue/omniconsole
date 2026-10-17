import { describe, expect, it } from 'vitest'
import type {
  OrganizationExecutor,
  OrganizationKeyState,
  OrganizationRecord
} from './session-organization-change'
import {
  adoptedOrganizationKeyState,
  emptyOrganizationKeyState,
  migrateOrganizationKeyState,
  nextOrganizationKeyState,
  ownedRevisionRefusal,
  parseOrganizationKeyState,
  seededOrganizationKeyState,
  withSyncStamp
} from './session-organization-ownership'

const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Ads review' }
const PERSON: OrganizationExecutor = { kind: 'person', via: 'sidebar' }

let second = 0
function applied(
  opId: string,
  executor: OrganizationExecutor,
  extra: Partial<OrganizationRecord> = {}
): OrganizationRecord {
  second += 1
  return {
    opId,
    kind: 'move',
    targets: [{ sessionKey: 's1' }],
    value: 'checkout',
    executor,
    phase: 'applied',
    ts: new Date(Date.UTC(2026, 8, 25, 10, 0, second)).toISOString(),
    revision: executor.kind === 'sync' ? `sync:${executor.stamp}` : opId,
    before: ['sales'],
    after: ['checkout'],
    ...extra
  }
}

const apply = (state: OrganizationKeyState, ...records: OrganizationRecord[]) =>
  records.reduce((current, record) => nextOrganizationKeyState(current, record, 0), state)

describe('nextOrganizationKeyState', () => {
  it('lets an agent’s checked change own the placement, until the person moves it for good', () => {
    const owned = apply(emptyOrganizationKeyState(), applied('agent', PANE))
    expect(owned.ownership.placement).toMatchObject({
      value: 'checkout',
      revision: 'agent',
      by: 'pane',
      opId: 'agent'
    })
    const mine = apply(owned, applied('mine', PERSON, { after: ['sales'], value: 'sales' }))
    expect(mine).toEqual({
      ownership: {},
      revocations: {
        placement: { at: expect.any(String), opId: 'mine', why: 'person/sidebar' }
      }
    })
    // Permanent: a later agent change never makes the person's placement an agent's again.
    expect(apply(mine, applied('agent-again', PANE))).toBe(mine)
  })

  it('never owns what a change left as it was, and ignores fields without ownership', () => {
    const state = emptyOrganizationKeyState()
    expect(apply(state, applied('same', PANE, { before: ['checkout'] }))).toBe(state)
    expect(apply(state, applied('archive', PANE, { kind: 'archive' }))).toBe(state)
    expect(apply(state, applied('prep', PANE, { phase: 'prepared' }))).toBe(state)
  })

  it('takes ownership back for another device’s stamp, even on the same folder, but not for its echo', () => {
    const owned = withSyncStamp(apply(emptyOrganizationKeyState(), applied('agent', PANE)), {
      field: 'placement',
      opId: 'agent',
      stamp: 500
    })
    const echo = applied('echo', { kind: 'sync', stamp: 500 }, { before: ['checkout'] })
    expect(apply(owned, echo)).toBe(owned)
    const elsewhere = applied('x-y-x', { kind: 'sync', stamp: 900 }, { before: ['checkout'] })
    expect(apply(owned, elsewhere)).toEqual({
      ownership: {},
      revocations: {
        placement: { at: expect.any(String), opId: 'x-y-x', why: 'sync/900' }
      }
    })
  })

  it('takes ownership back for a restore or an unchecked window, and carries it through key migration', () => {
    const owned = apply(emptyOrganizationKeyState(), applied('agent', PANE))
    const restore = applied('restore', { kind: 'app', feature: 'restore' })
    expect(apply(owned, restore).revocations.placement?.why).toBe('app/restore')
    const unchecked = applied('old-window', PANE, { revisionUnchecked: true })
    expect(apply(owned, unchecked).revocations.placement?.why).toBe('pane/unchecked')
    // With nothing owned there is nothing to take back.
    expect(apply(emptyOrganizationKeyState(), unchecked)).toEqual(emptyOrganizationKeyState())
    const migration = applied('rekey', { kind: 'app', feature: 'key-migration' })
    expect(apply(owned, migration)).toBe(owned)
  })

  it('treats a title like a placement, independently of it', () => {
    const titled = apply(
      emptyOrganizationKeyState(),
      applied(
        'named',
        { kind: 'launch', source: 'session-launch' },
        {
          kind: 'title',
          value: 'Fix checkout',
          before: ['Claude'],
          after: ['Fix checkout']
        }
      )
    )
    const moved = apply(titled, applied('mine', PERSON))
    expect(moved.ownership.title).toMatchObject({ value: 'Fix checkout', by: 'launch' })
    expect(moved.revocations.placement?.opId).toBe('mine')
    expect(moved.revocations.title).toBeUndefined()
  })
})

describe('sync stamps, key migration, seeding and adoption', () => {
  const owned = apply(emptyOrganizationKeyState(), applied('agent', PANE))

  it('notes a stamp only on the owned change it was authored for, once', () => {
    const stamped = withSyncStamp(owned, { field: 'placement', opId: 'agent', stamp: 7 })
    expect(stamped.ownership.placement?.syncStamp).toBe(7)
    expect(withSyncStamp(stamped, { field: 'placement', opId: 'agent', stamp: 8 })).toBe(stamped)
    expect(withSyncStamp(owned, { field: 'placement', opId: 'older', stamp: 7 })).toBe(owned)
  })

  it('moves the placement with the folder the provider key keeps, the title with the pane, and every revocation', () => {
    const pane = apply(
      owned,
      applied('title', PANE, { kind: 'title', before: ['a'], after: ['b'], value: 'b' })
    )
    const provider = apply(
      emptyOrganizationKeyState(),
      applied('old', PANE, { before: [null], after: ['sales'] })
    )
    expect(migrateOrganizationKeyState(pane, provider, true).ownership).toMatchObject({
      placement: { opId: 'agent' },
      title: { opId: 'title' }
    })
    expect(migrateOrganizationKeyState(pane, provider, false).ownership).toMatchObject({
      placement: { opId: 'old' },
      title: { opId: 'title' }
    })
    const touched = apply(provider, applied('mine', PERSON))
    const merged = migrateOrganizationKeyState(pane, touched, true)
    expect(merged.ownership.placement).toBeUndefined()
    expect(merged.revocations.placement?.opId).toBe('mine')
  })

  it('seeds a launch placement only where nothing is recorded for it', () => {
    const seed = { key: 's1', value: 'batch', batchId: 'b1', at: '2026-09-24T10:00:00.000Z' }
    expect(seededOrganizationKeyState(emptyOrganizationKeyState(), seed, false)).toEqual({
      ownership: {
        placement: {
          value: 'batch',
          revision: 'seed:b1',
          by: 'launch',
          opId: 'seed:b1',
          at: seed.at
        }
      },
      revocations: {}
    })
    const empty = emptyOrganizationKeyState()
    expect(seededOrganizationKeyState(empty, seed, true)).toBe(empty)
    expect(seededOrganizationKeyState(owned, seed, false)).toBe(owned)
    const mine = apply(emptyOrganizationKeyState(), applied('mine', PERSON))
    expect(seededOrganizationKeyState(mine, seed, false)).toBe(mine)
  })

  it('adopts main’s ownership, keeps every revocation, and resends a stamp main lacks', () => {
    const local = withSyncStamp(owned, { field: 'placement', opId: 'agent', stamp: 7 })
    expect(adoptedOrganizationKeyState(local, owned)).toEqual({
      state: local,
      resend: [{ field: 'placement', opId: 'agent', stamp: 7 }]
    })
    const revokedHere = apply(owned, applied('x-y-x', { kind: 'sync', stamp: 9 }))
    expect(adoptedOrganizationKeyState(revokedHere, owned).state).toEqual(revokedHere)
    // Ownership main does not hold is dropped: anything missing counts as the person's.
    expect(adoptedOrganizationKeyState(owned, emptyOrganizationKeyState()).state).toEqual(
      emptyOrganizationKeyState()
    )
  })

  it('reads a saved state field by field; a revoked field never keeps ownership', () => {
    const mine = apply(emptyOrganizationKeyState(), applied('mine', PERSON))
    expect(
      parseOrganizationKeyState({
        ownership: { placement: owned.ownership.placement, title: { value: 'x' } },
        revocations: mine.revocations
      })
    ).toEqual(mine)
    expect(parseOrganizationKeyState({ ownership: { placement: 'nope' } })).toBeNull()
  })

  it('refuses an expected revision unless the field is still owned at exactly it', () => {
    expect(ownedRevisionRefusal(owned, 'placement', 'agent')).toBeNull()
    expect(ownedRevisionRefusal(owned, 'placement', 'older')).toEqual({
      reason: 'changed-since',
      current: 'agent'
    })
    expect(ownedRevisionRefusal(owned, 'title', 'agent')).toEqual({ reason: 'not-owned' })
    const mine = apply(owned, applied('mine', PERSON))
    expect(ownedRevisionRefusal(mine, 'placement', 'agent')).toEqual({
      reason: 'yours',
      why: 'person/sidebar'
    })
  })
})
