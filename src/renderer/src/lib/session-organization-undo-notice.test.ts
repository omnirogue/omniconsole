import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type { OrganizationUndoPlan } from '../../../shared/session-organization-change'
import type { OrganizationRpc } from './session-organization-change'
import type { OrganizationStores } from './session-organization-values'
import { emptySessionSidebarView } from './session-sidebar-view'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toastMocks) }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

import {
  organizationUndoNotice,
  undoOrganizationChangeWithNotice,
  undoOrganizationChangesWithNotice
} from './session-organization-undo-notice'

function rpcAnswering(plans: Record<string, OrganizationUndoPlan>): OrganizationRpc {
  return vi.fn(async (method: string, params?: unknown) => {
    if (method === 'sessionOrganization.undoPlan') {
      return plans[(params as { opId: string }).opId]
    }
    return {}
  }) as unknown as OrganizationRpc
}

function titles(tabs: Record<string, string | null>): OrganizationStores {
  const folders = createSessionFoldersStore({
    save: vi.fn(),
    load: vi.fn(() => ({ version: 1 as const, folders: [], membership: {} }))
  })
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) },
    { save: vi.fn(), load: vi.fn(() => []) }
  )
  folders.getState().load()
  view.getState().load()
  return {
    folders,
    view,
    titles: {
      read: (tabId) =>
        tabId in tabs ? { known: true, title: tabs[tabId] ?? null } : { known: false },
      write: (tabId, title) => {
        tabs[tabId] = title
      }
    }
  }
}

beforeEach(() => {
  toastMocks.success.mockReset()
  toastMocks.warning.mockReset()
  toastMocks.error.mockReset()
})

describe('History Undo', () => {
  it('refuses a target changed since and says so, changing nothing', async () => {
    const rpc = rpcAnswering({
      'op-1': {
        opId: 'op-1',
        inverse: null,
        targets: [{ target: { sessionKey: 's1' }, status: 'changed-since', laterOpId: 'op-2' }],
        partial: false
      }
    })
    const result = await undoOrganizationChangeWithNotice('op-1', 'sidebar', { rpc })
    expect(result).toMatchObject({ undone: 0, total: 1 })
    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Nothing was undone: it changed since, so it was left as it is.'
    )
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  it('skips a title renamed in this window since, even when main still plans the Undo', async () => {
    const tabs: Record<string, string | null> = { t1: 'Renamed again by hand' }
    const rpc = rpcAnswering({
      'op-1': {
        opId: 'op-1',
        inverse: { kind: 'title', targets: [{ tabId: 't1' }], value: 'Old', undoOf: 'op-1' },
        targets: [{ target: { tabId: 't1' }, status: 'undo', expected: 'Agent title' }],
        partial: false
      }
    })
    await undoOrganizationChangeWithNotice('op-1', 'sidebar', { rpc, stores: titles(tabs) })
    expect(tabs.t1).toBe('Renamed again by hand')
    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Nothing was undone: it changed since, so it was left as it is.'
    )
  })

  it('undoes a group newest first and reports the part it left alone', async () => {
    const tabs: Record<string, string | null> = { t1: 'New one', t2: 'Changed by hand' }
    const rpc = rpcAnswering({
      a: {
        opId: 'a',
        inverse: { kind: 'title', targets: [{ tabId: 't1' }], value: 'Old one', undoOf: 'a' },
        targets: [{ target: { tabId: 't1' }, status: 'undo', expected: 'New one' }],
        partial: false
      },
      b: {
        opId: 'b',
        inverse: null,
        targets: [{ target: { tabId: 't2' }, status: 'changed-since', laterOpId: 'c' }],
        partial: false
      }
    })
    const result = await undoOrganizationChangesWithNotice(['a', 'b'], 'work', {
      rpc,
      stores: titles(tabs)
    })
    expect(tabs).toEqual({ t1: 'Old one', t2: 'Changed by hand' })
    expect(result).toMatchObject({ undone: 1, total: 2 })
    expect(toastMocks.warning).toHaveBeenCalledWith(
      'Undid 1 of 2; 1 changed since, so they were left as they are.'
    )
  })

  it('names a change that can never be undone', () => {
    expect(
      organizationUndoNotice({
        undone: 0,
        total: 1,
        skipped: [{ target: { folderId: 'f' }, status: 'not-undoable' }]
      })
    ).toEqual({ tone: 'warning', text: 'This change cannot be undone.' })
  })
})
