import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import { createSessionTagsStore } from '@/store/session-tags'
import { createWaitLaterStore } from '@/store/wait-later-store'
import { localKeyDigest } from '../../../shared/account-sync-session-keys'
import type { OrganizationRecord } from '../../../shared/session-organization-change'
import { SESSION_ORGANIZATION_HOST_RPC } from '../../../shared/session-organization-host-schema'
import { adoptHostOrganizationChanges } from './session-organization-host-adoption'
import {
  hostOrganizationExport,
  isHostOrganizationSettled,
  settleHostOrganization
} from './session-organization-host-settle'
import type { OrganizationRpc } from './session-organization-change'
import type { OrganizationTitleStore } from './session-organization-title'
import type { OrganizationStores } from './session-organization-values'
import { emptySessionSidebarView } from './session-sidebar-view'
import { emptyWaitLater } from './wait-later'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const ONE = '00000000-0000-4000-8000-000000000001'
const TWO = '00000000-0000-4000-8000-000000000002'
const KEY = JSON.stringify(['local', 'provider', 'repo-1::/work/app\0claude\0claude\0session-1'])
const WAKE = Date.UTC(2099, 0, 1)

function stores(membership: Record<string, string> = {}): OrganizationStores {
  const folders = createSessionFoldersStore({
    save: vi.fn(),
    load: vi.fn(() => ({
      version: 1 as const,
      folders: [
        { id: ONE, name: 'One' },
        { id: TWO, name: 'Two' }
      ],
      membership
    }))
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
  const waitLater = createWaitLaterStore({ load: () => emptyWaitLater(), save: vi.fn() })
  for (const store of [folders, view, tags, waitLater]) {
    store.getState().load()
  }
  return { folders, view, tags, waitLater }
}

function titleStore(titles: Record<string, string | null>): OrganizationTitleStore {
  return {
    read: (tabId) =>
      tabId in titles ? { known: true, title: titles[tabId]!, origin: 'yours' } : { known: false },
    write: (tabId, title) => void (titles[tabId] = title)
  }
}

function headless(
  opId: string,
  kind: OrganizationRecord['kind'],
  key: string,
  value: unknown,
  before: unknown,
  after: unknown
): OrganizationRecord {
  return {
    opId,
    kind,
    targets: [{ sessionKey: key }],
    value,
    executor: { kind: 'pane', paneKey: 'tab-9:leaf-1', title: 'Steward' },
    phase: 'applied',
    ts: '2026-09-26T09:00:00.000Z',
    before: [before],
    after: [after],
    revision: opId,
    headless: true
  }
}

describe('adopting headless changes', () => {
  it('applies a change the window still holds the start of; one it already holds is adopted as is', () => {
    const window = stores({ a: ONE })
    const result = adoptHostOrganizationChanges(
      [
        headless('move-b', 'move', 'b', ONE, null, ONE),
        headless('move-a', 'move', 'a', ONE, null, ONE),
        headless('archive-b', 'archive', 'b', true, false, true)
      ],
      window,
      () => null
    )
    expect(result).toEqual({
      adopted: ['move-b', 'move-a', 'archive-b'],
      conflicts: [],
      waiting: []
    })
    expect(window.folders.getState().metadata.membership).toEqual({ a: ONE, b: ONE })
    expect(window.view.getState().archived).toEqual(['b'])
  })

  it('keeps the window’s value where it holds one the change did not start from', () => {
    const window = stores({ a: TWO })
    const result = adoptHostOrganizationChanges(
      [headless('move-a', 'move', 'a', ONE, null, ONE)],
      window,
      () => null
    )
    expect(result.conflicts).toEqual([{ opId: 'move-a', key: 'a', value: TWO }])
    expect(window.folders.getState().metadata.membership).toEqual({ a: TWO })
  })

  it('waits for a title’s tab, and conflicts when the store refuses the value', () => {
    const window = stores()
    const result = adoptHostOrganizationChanges(
      [
        headless('title-a', 'title', 'a', 'Plan', null, 'Plan'),
        headless('tag-b', 'tag', 'b', 'no-such-tag', false, true)
      ],
      window,
      () => null
    )
    expect(result).toEqual({
      adopted: [],
      conflicts: [{ opId: 'tag-b', key: 'b', value: false }],
      waiting: ['title-a']
    })
  })
})

describe('handing the window’s organization to the host', () => {
  it('exports every key it holds: folder, archive, hidden, tags, snooze, title and whose it is', () => {
    const window = stores({ [KEY]: ONE })
    window.view.getState().setArchived(['old'], true)
    window.view.getState().setHiddenMany([`conversation:${KEY}`], true)
    window.waitLater!.getState().setUntil(`conversation:${KEY}`, new Date(WAKE))
    const entries = hostOrganizationExport({
      stores: window,
      sessions: [{ key: KEY, tabId: 'tab-1' }],
      folderPaths: {},
      titles: titleStore({ 'tab-1': 'Launch review' })
    })
    expect(entries).toEqual(
      expect.arrayContaining([
        {
          key: KEY,
          digest: localKeyDigest(KEY)!,
          values: {
            placement: ONE,
            archived: false,
            hidden: true,
            snooze: WAKE,
            tags: [],
            title: 'Launch review',
            titleOrigin: 'yours'
          }
        },
        expect.objectContaining({
          key: 'old',
          values: expect.objectContaining({ placement: null, archived: true })
        })
      ])
    )
  })

  it('adopts first, then hands over the values in one completing batch; sync may run after', async () => {
    const window = stores()
    const calls: { method: string; params: unknown }[] = []
    const rpc = vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return method === SESSION_ORGANIZATION_HOST_RPC.pending
        ? { records: [headless('archive-a', 'archive', 'a', true, false, true)] }
        : {}
    }) as unknown as OrganizationRpc
    await settleHostOrganization({
      rpc,
      stores: window,
      sessions: () => [{ key: 'a', tabId: null }],
      folderPaths: () => ({}),
      titles: titleStore({})
    })
    expect(calls.map((call) => call.method)).toEqual([
      SESSION_ORGANIZATION_HOST_RPC.pending,
      SESSION_ORGANIZATION_HOST_RPC.adopted,
      SESSION_ORGANIZATION_HOST_RPC.migrate,
      // The deletion marks, in a batch of their own (session-organization-host-settle.test.ts).
      SESSION_ORGANIZATION_HOST_RPC.migrate
    ])
    expect(calls[1]!.params).toEqual({ adopted: ['archive-a'], conflicts: [] })
    expect(calls[2]!.params).toMatchObject({
      complete: true,
      entries: [{ key: 'a', values: { archived: true } }]
    })
    expect(calls[3]!.params).toEqual({ entries: [{ key: 'a', values: { deleted: false } }] })
    expect(isHostOrganizationSettled()).toBe(true)
  })

  it('never holds sync back when main cannot answer', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('Unknown method')
    }) as unknown as OrganizationRpc
    await expect(
      settleHostOrganization({ rpc, stores: stores(), sessions: () => [], titles: titleStore({}) })
    ).resolves.toBeUndefined()
    expect(isHostOrganizationSettled()).toBe(true)
  })
})
