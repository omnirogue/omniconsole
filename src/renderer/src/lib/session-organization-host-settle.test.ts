import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import { createSessionTagsStore } from '@/store/session-tags'
import { createWaitLaterStore } from '@/store/wait-later-store'
import { SESSION_ORGANIZATION_HOST_RPC } from '../../../shared/session-organization-host-schema'
import {
  hostOrganizationDeletionExport,
  isHostOrganizationSettled,
  settleHostOrganization
} from './session-organization-host-settle'
import type { OrganizationRpc } from './session-organization-change'
import type { OrganizationStores } from './session-organization-values'
import { emptySessionSidebarView } from './session-sidebar-view'
import { emptyWaitLater } from './wait-later'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const GONE = JSON.stringify(['local', 'provider', 'repo-1::/work/app\0claude\0claude\0gone'])
const KEPT = JSON.stringify(['local', 'provider', 'repo-1::/work/app\0claude\0claude\0kept'])

function stores(): OrganizationStores {
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
  const waitLater = createWaitLaterStore({ load: () => emptyWaitLater(), save: vi.fn() })
  for (const store of [folders, view, tags, waitLater]) {
    store.getState().load()
  }
  return { folders, view, tags, waitLater }
}

const titles = { read: () => ({ known: false as const }), write: () => {} }

describe('handing main the window’s deletion marks (session parity, F4)', () => {
  it('marks every deleted key true and every other exported key false', () => {
    const window = stores()
    window.view.getState().setDeleted([GONE], true)
    expect(hostOrganizationDeletionExport(window, [{ key: KEPT }, { key: GONE }])).toEqual([
      { key: KEPT, values: { deleted: false } },
      { key: GONE, values: { deleted: true } }
    ])
  })

  it('sends them after the values, in a batch of their own, so the values stay as an older main reads them', async () => {
    const window = stores()
    window.view.getState().setDeleted([GONE], true)
    const calls: { method: string; params: unknown }[] = []
    const rpc = vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return method === SESSION_ORGANIZATION_HOST_RPC.pending ? { records: [] } : {}
    }) as unknown as OrganizationRpc
    await settleHostOrganization({
      rpc,
      stores: window,
      sessions: () => [{ key: KEPT, tabId: null }],
      folderPaths: () => ({}),
      titles
    })
    const migrations = calls.filter((call) => call.method === SESSION_ORGANIZATION_HOST_RPC.migrate)
    expect(migrations).toHaveLength(2)
    expect(JSON.stringify(migrations[0]!.params)).not.toContain('deleted')
    expect(migrations[0]!.params).toMatchObject({ complete: true })
    expect(migrations[1]!.params).toEqual({
      entries: [
        { key: KEPT, values: { deleted: false } },
        { key: GONE, values: { deleted: true } }
      ]
    })
  })

  it('settles all the same when an older main refuses the field, having imported the values', async () => {
    const accepted: unknown[] = []
    const rpc = vi.fn(async (method: string, params?: unknown) => {
      if (method !== SESSION_ORGANIZATION_HOST_RPC.migrate) {
        return { records: [] }
      }
      // Why: the older main's strict migrate schema has no `deleted`.
      if (JSON.stringify(params).includes('"deleted"')) {
        throw new Error("Unrecognized key(s) in object: 'deleted'")
      }
      accepted.push(params)
      return {}
    }) as unknown as OrganizationRpc
    const window = stores()
    window.view.getState().setDeleted([GONE], true)
    await expect(
      settleHostOrganization({
        rpc,
        stores: window,
        sessions: () => [{ key: KEPT, tabId: null }],
        folderPaths: () => ({}),
        titles
      })
    ).resolves.toBeUndefined()
    expect(accepted).toEqual([expect.objectContaining({ complete: true })])
    expect(isHostOrganizationSettled()).toBe(true)
  })
})
