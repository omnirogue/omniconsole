import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OrganizationExecutor,
  OrganizationRecord
} from '../../../shared/session-organization-change'
import { createSessionOrganizationOwnershipStore } from './session-organization-ownership'

const scope = vi.hoisted(() => ({ account: 'sal' }))

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => `${key}:${scope.account}`
}))

const PANE: OrganizationExecutor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Ads review' }

function applied(
  opId: string,
  key: string,
  executor: OrganizationExecutor,
  after = 'checkout'
): OrganizationRecord {
  return {
    opId,
    kind: 'move',
    targets: [{ sessionKey: key }],
    value: after,
    executor,
    phase: 'applied',
    ts: '2026-09-25T10:00:00.000Z',
    revision: opId,
    before: ['sales'],
    after: [after]
  }
}

function storage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value)
    }
  }
}

beforeEach(() => {
  scope.account = 'sal'
})

describe('the ownership mirror', () => {
  it('keeps an agent’s placement until the person moves it, and saves only what it holds', () => {
    const saved = storage()
    const mirror = createSessionOrganizationOwnershipStore(() => saved)
    mirror.getState().applyRecord(applied('agent', 's1', PANE))
    expect(mirror.getState().ownedField('s1', 'placement')).toMatchObject({ opId: 'agent' })
    mirror
      .getState()
      .applyRecord(applied('mine', 's1', { kind: 'person', via: 'sidebar' }, 'sales'))
    expect(mirror.getState().ownedField('s1', 'placement')).toBeNull()
    expect(mirror.getState().stateFor('s1').revocations.placement).toMatchObject({ opId: 'mine' })
    // A fresh window reads the same answer back from this scope's storage.
    const reopened = createSessionOrganizationOwnershipStore(() => saved)
    expect(reopened.getState().stateFor('s1').revocations.placement?.why).toBe('person/sidebar')
    expect([...saved.items.keys()]).toEqual(['omni.session-organization-ownership.v1:sal'])
  })

  it('keeps each account scope apart', () => {
    const saved = storage()
    const mirror = createSessionOrganizationOwnershipStore(() => saved)
    mirror.getState().applyRecord(applied('agent', 's1', PANE))
    scope.account = 'iris'
    expect(mirror.getState().ownedField('s1', 'placement')).toBeNull()
    scope.account = 'sal'
    expect(mirror.getState().ownedField('s1', 'placement')).toMatchObject({ opId: 'agent' })
  })

  it('adopts main’s copy: its ownership, every revocation, and stamps main has not received', () => {
    const mirror = createSessionOrganizationOwnershipStore(() => storage())
    mirror.getState().applyRecord(applied('agent', 'stamped', PANE))
    mirror
      .getState()
      .attachSyncStamp({ key: 'stamped', field: 'placement', opId: 'agent', stamp: 9 })
    mirror.getState().applyRecord(applied('local-only', 'optimistic', PANE))
    mirror.getState().applyRecord(applied('mine', 'revoked', { kind: 'person', via: 'sidebar' }))
    const owned = (opId: string, value: string) => ({
      value,
      revision: opId,
      by: 'pane' as const,
      opId,
      at: '2026-09-25T10:00:00.000Z'
    })
    // Main's copy: the stamped change without its stamp (still on its way), and one it filed.
    const main = {
      stamped: { ownership: { placement: owned('agent', 'checkout') }, revocations: {} },
      fromMain: { ownership: { placement: owned('r', 'x') }, revocations: {} }
    }
    const resend = mirror.getState().adopt(main, true)
    expect(resend).toEqual([{ key: 'stamped', field: 'placement', opId: 'agent', stamp: 9 }])
    expect(mirror.getState().ownedField('stamped', 'placement')?.syncStamp).toBe(9)
    expect(mirror.getState().ownedField('fromMain', 'placement')).toMatchObject({ opId: 'r' })
    // Main never heard of it: counts as the person's.
    expect(mirror.getState().ownedField('optimistic', 'placement')).toBeNull()
    expect(mirror.getState().stateFor('revoked').revocations.placement?.opId).toBe('mine')
  })

  it('moves a pane’s state onto its provider key once', () => {
    const mirror = createSessionOrganizationOwnershipStore(() => storage())
    mirror
      .getState()
      .applyRecord(applied('filed', 'pane', { kind: 'launch', source: 'session-prep' }))
    expect(mirror.getState().migrateKey('pane', 'provider', true)).toBe(true)
    expect(mirror.getState().ownedField('provider', 'placement')).toMatchObject({ opId: 'filed' })
    expect(mirror.getState().keys.pane).toBeUndefined()
    expect(mirror.getState().migrateKey('pane', 'provider', true)).toBe(false)
  })
})
