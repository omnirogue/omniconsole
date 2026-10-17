import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import { createSessionTagsStore } from '@/store/session-tags'
import { createWaitLaterStore } from '@/store/wait-later-store'
import type {
  OrganizationChange,
  OrganizationUndoPlan
} from '../../../shared/session-organization-change'
import {
  applyOrganizationChange,
  undoOrganizationChange,
  type OrganizationRpc
} from './session-organization-change'
import { applyRelayedOrganizationChanges } from './session-organization-relayed-changes'
import type { OrganizationStores } from './session-organization-values'
import { emptySessionSidebarView } from './session-sidebar-view'
import { emptyWaitLater } from './wait-later'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const NOW = new Date(Date.UTC(2026, 8, 25, 12))
const WAKE = Date.UTC(2099, 0, 5, 9)

function createStores(): OrganizationStores {
  const folders = createSessionFoldersStore({
    save: vi.fn(),
    load: vi.fn(() => ({ version: 1 as const, folders: [], membership: {} }))
  })
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) },
    { save: vi.fn(), load: vi.fn(() => []) }
  )
  const backing = new Map<string, string>()
  const tags = createSessionTagsStore(() => ({
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => void backing.set(key, value)
  }))
  const waitLater = createWaitLaterStore({ load: () => emptyWaitLater(), save: vi.fn() }, () => NOW)
  for (const store of [folders, view, tags, waitLater]) {
    store.getState().load()
  }
  return {
    folders,
    view,
    tags,
    waitLater,
    automaticTag: (key) => (key === 'a' ? 'omnirogue' : null)
  }
}

function recordingRpc(plan?: OrganizationUndoPlan) {
  const calls: { method: string; params: unknown }[] = []
  const rpc = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
    return method === 'sessionOrganization.undoPlan' ? plan : {}
  }) as unknown as OrganizationRpc
  return { rpc, calls }
}

const AGENT = { kind: 'pane' as const, paneKey: 'tab-9:leaf-1', title: 'Steward' }

describe('tag, hide and snooze appliers', () => {
  it('tags through the change path, keeping the automatic company tag, and records before/after', async () => {
    const stores = createStores()
    const { rpc, calls } = recordingRpc()
    const outcome = await applyOrganizationChange(
      {
        opId: 'tag-1',
        kind: 'tag',
        targets: [{ sessionKey: 'a' }, { sessionKey: 'b' }],
        value: 'acme',
        executor: AGENT,
        reason: 'ACME work'
      },
      { stores, rpc }
    )
    expect(outcome).toMatchObject({
      status: 'applied',
      before: [false, false],
      after: [true, true]
    })
    expect(stores.tags!.getState().data.assignments).toEqual({
      a: ['omnirogue', 'acme'],
      b: ['acme']
    })
    expect(calls.map((call) => call.method)).toEqual([
      'sessionOrganization.prepare',
      'sessionOrganization.settle'
    ])
  })

  it('hides and unhides as the sidebar does, and a snooze sets the wake time', async () => {
    const stores = createStores()
    const { rpc } = recordingRpc()
    await applyOrganizationChange(
      {
        opId: 'h',
        kind: 'hide',
        targets: [{ sessionKey: 'a' }],
        value: true,
        executor: AGENT,
        reason: 'quiet'
      },
      { stores, rpc }
    )
    expect(stores.view.getState().view.hidden).toEqual(['conversation:a'])
    const snoozed = await applyOrganizationChange(
      {
        opId: 's',
        kind: 'snooze',
        targets: [{ sessionKey: 'b' }],
        value: WAKE,
        executor: AGENT,
        reason: 'waiting'
      },
      { stores, rpc }
    )
    expect(snoozed).toMatchObject({ status: 'applied', before: [null], after: [WAKE] })
    expect(stores.waitLater!.getState().view.until).toEqual({
      'conversation:b': new Date(WAKE).toISOString()
    })
    await applyOrganizationChange(
      {
        opId: 'u',
        kind: 'unhide',
        targets: [{ sessionKey: 'a' }],
        value: false,
        executor: AGENT,
        reason: 'watch it'
      },
      { stores, rpc }
    )
    expect(stores.view.getState().view.hidden).toEqual([])
  })

  it('undoes a multi-tag change per target, skipping one changed since', async () => {
    const stores = createStores()
    stores.tags!.getState().save({
      ...stores.tags!.getState().data,
      assignments: { a: ['acme', 'betacorp'], b: [] }
    })
    const plan: OrganizationUndoPlan = {
      opId: 'tag-1',
      inverse: {
        kind: 'untag',
        targets: [{ sessionKey: 'a' }, { sessionKey: 'a' }, { sessionKey: 'b' }],
        value: 'acme',
        values: ['acme', 'betacorp', 'acme'],
        undoOf: 'tag-1'
      },
      targets: [
        { target: { sessionKey: 'a' }, status: 'undo', expected: true },
        { target: { sessionKey: 'a' }, status: 'undo', expected: true },
        { target: { sessionKey: 'b' }, status: 'undo', expected: true }
      ],
      partial: false
    }
    const { rpc } = recordingRpc(plan)
    const result = await undoOrganizationChange('tag-1', { stores, rpc })
    // `b` lost its tag since (by a path that records nothing): skipped, never overwritten.
    expect(result).toMatchObject({ undone: 2, total: 3 })
    expect(result.skipped).toEqual([expect.objectContaining({ status: 'changed-since' })])
    expect(stores.tags!.getState().data.assignments).toEqual({ a: [], b: [] })
  })
})

describe('applyRelayedOrganizationChanges', () => {
  it('resolves tag names and applies each change; one that fails changes nothing and stops no other', () => {
    const stores = createStores()
    const find = (target: { paneKey?: string }) =>
      target.paneKey === 'tab-1:leaf-1' ? { key: 'b', tabId: 'tab-1' } : null
    const changes: OrganizationChange[] = [
      {
        opId: 'one',
        kind: 'tag',
        targets: [{ paneKey: 'tab-1:leaf-1' }],
        value: 'BetaCorp',
        executor: AGENT,
        reason: 'r'
      },
      {
        opId: 'two',
        kind: 'tag',
        targets: [{ paneKey: 'tab-1:leaf-1' }],
        value: 'No Such Tag',
        executor: AGENT,
        reason: 'r'
      },
      {
        opId: 'three',
        kind: 'hide',
        targets: [{ paneKey: 'tab-1:leaf-1' }],
        value: true,
        executor: AGENT,
        reason: 'r'
      }
    ]
    const reply = applyRelayedOrganizationChanges(changes, stores, find)
    expect(reply.outcomes).toEqual([
      expect.objectContaining({
        ok: true,
        opId: 'one',
        value: 'betacorp',
        before: [false],
        after: [true]
      }),
      expect.objectContaining({
        ok: false,
        opId: 'two',
        error: expect.stringContaining('No tag named')
      }),
      expect.objectContaining({ ok: true, opId: 'three', after: [true] })
    ])
    expect(stores.tags!.getState().data.assignments).toEqual({ b: ['betacorp'] })
  })
})
