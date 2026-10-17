import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type {
  OrganizationChange,
  OrganizationTitleOrigin,
  OrganizationUndoPlan
} from '../../../shared/session-organization-change'
import type { OrganizationRpc } from './session-organization-change'
import type { OrganizationTitleStore } from './session-organization-title'
import type { OrganizationStores } from './session-organization-values'
import { emptySessionSidebarView } from './session-sidebar-view'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn()
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toastMocks) }))
vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))
// Why: a tab's sidebar row is found from the app store; here every tab is listed as `row-<tab>`.
vi.mock('./sidebar-sessions', () => ({ buildPaneSessions: () => [] }))
vi.mock('./session-manage-sidebar-rows', () => ({
  matchManagedSession: (_sessions: unknown, target: { tabId?: string }) =>
    target.tabId
      ? { sessionKey: `row-${target.tabId}`, rowKey: `row-${target.tabId}`, paneKey: null }
      : null
}))
const appMocks = vi.hoisted(() => ({ setTabCustomTitle: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => appMocks } }))

import {
  recordPaneRenameByPerson,
  renameSessionByPerson,
  renameSessionsFromGoals,
  renameTerminalRecorded,
  titleNewTerminalTab
} from './session-title-change'

type Tab = { title: string | null; origin?: OrganizationTitleOrigin }

function createStores(tabs: Record<string, Tab>): OrganizationStores & {
  tabs: Record<string, Tab>
} {
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
  const titles: OrganizationTitleStore = {
    read: (tabId) => {
      const tab = tabs[tabId]
      return tab ? { known: true, title: tab.title, origin: tab.origin } : { known: false }
    },
    write: (tabId, title, opts) => {
      tabs[tabId] = { title, origin: opts.origin }
    }
  }
  return { folders, view, titles, tabs }
}

function fakeRpc(answers: Record<string, unknown> = {}) {
  const calls: {
    method: string
    params: { change?: OrganizationChange } & Record<string, unknown>
  }[] = []
  const rpc = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params: params as never })
    return answers[method] ?? {}
  }) as unknown as OrganizationRpc
  return { rpc, calls }
}

beforeEach(() => {
  appMocks.setTabCustomTitle.mockReset()
  toastMocks.success.mockReset()
  toastMocks.error.mockReset()
  toastMocks.warning.mockReset()
})

describe('title origin at every recorded title path', () => {
  it('records a sidebar rename as the person’s, origin yours, under the row’s key', async () => {
    const stores = createStores({ t1: { title: 'worker-task_5ad8', origin: 'generated' } })
    const { rpc, calls } = fakeRpc({ 'sessionOrganization.settle': { revision: 'op-1' } })
    const outcome = renameSessionByPerson(
      { tabId: 't1', title: 'Launch plan', via: 'sidebar' },
      { stores, rpc, mintOpId: () => 'op-1' }
    )
    expect(outcome).toMatchObject({
      status: 'applied',
      before: ['worker-task_5ad8'],
      after: ['Launch plan']
    })
    expect(stores.tabs.t1).toEqual({ title: 'Launch plan', origin: 'yours' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.method).toBe('sessionOrganization.settle')
    expect(calls[0]!.params.change).toMatchObject({
      opId: 'op-1',
      kind: 'title',
      targets: [{ tabId: 't1', sessionKey: 'row-t1' }],
      value: 'Launch plan',
      origin: 'yours',
      executor: { kind: 'person', via: 'sidebar' }
    })
  })

  it('prepares a launcher title before it applies and records it generated', async () => {
    const stores = createStores({ t2: { title: null } })
    const { rpc, calls } = fakeRpc({ 'sessionOrganization.settle': { revision: 'op-2' } })
    const outcome = await renameTerminalRecorded(
      { tabId: 't2', title: 'Ads: Q4 headlines', origin: 'generated', source: 'session-launch' },
      { stores, rpc, mintOpId: () => 'op-2' }
    )
    expect(outcome.status).toBe('applied')
    expect(calls.map((call) => call.method)).toEqual([
      'sessionOrganization.prepare',
      'sessionOrganization.settle'
    ])
    expect(calls[0]!.params.change).toMatchObject({
      kind: 'title',
      origin: 'generated',
      executor: { kind: 'launch', source: 'session-launch' }
    })
    expect(stores.tabs.t2).toEqual({ title: 'Ads: Q4 headlines', origin: 'generated' })
  })

  it('refuses a CLI rename it could not record first, and leaves the title as it was', async () => {
    const stores = createStores({ t3: { title: 'Mine', origin: 'yours' } })
    const rpc = vi.fn(async (method: string) => {
      if (method === 'sessionOrganization.prepare') {
        throw new Error('trail unwritable')
      }
      return {}
    }) as unknown as OrganizationRpc
    const outcome = await renameTerminalRecorded({ tabId: 't3', title: 'Other' }, { stores, rpc })
    expect(outcome).toMatchObject({ status: 'refused', error: 'trail unwritable' })
    expect(stores.tabs.t3).toEqual({ title: 'Mine', origin: 'yours' })
    expect(toastMocks.error).toHaveBeenCalledTimes(1)
  })

  it('renames from goals as one person change, origin generated, with one Undo from the record', async () => {
    const stores = createStores({
      t1: { title: 'worker-task_5ad8df40da3a' },
      t2: { title: ' claude conversation ' }
    })
    const plan: OrganizationUndoPlan = {
      opId: 'goals-1',
      inverse: {
        kind: 'title',
        targets: [
          { tabId: 't1', sessionKey: 'row-t1' },
          { tabId: 't2', sessionKey: 'row-t2' }
        ],
        value: 'worker-task_5ad8df40da3a',
        values: ['worker-task_5ad8df40da3a', ' claude conversation '],
        undoOf: 'goals-1'
      },
      targets: [
        { target: { tabId: 't1' }, status: 'undo', expected: 'Fix the PDF export' },
        { target: { tabId: 't2' }, status: 'undo', expected: 'Refer and earn copy' }
      ],
      partial: false
    }
    const { rpc, calls } = fakeRpc({ 'sessionOrganization.undoPlan': plan })
    let minted = 0
    const outcome = renameSessionsFromGoals(
      [
        { tabId: 't1', previous: 'worker-task_5ad8df40da3a', next: 'Fix the PDF export' },
        { tabId: 't2', previous: ' claude conversation ', next: 'Refer and earn copy' }
      ],
      'work',
      { stores, rpc, mintOpId: () => (minted++ === 0 ? 'goals-1' : 'undo-1') }
    )
    expect(outcome?.status).toBe('applied')
    expect(stores.tabs).toEqual({
      t1: { title: 'Fix the PDF export', origin: 'generated' },
      t2: { title: 'Refer and earn copy', origin: 'generated' }
    })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.params.change).toMatchObject({
      kind: 'title',
      targets: [{ tabId: 't1' }, { tabId: 't2' }],
      values: ['Fix the PDF export', 'Refer and earn copy'],
      origin: 'generated',
      executor: { kind: 'person', via: 'work' }
    })
    const [message, options] = toastMocks.success.mock.calls[0]!
    expect(message).toBe('Renamed 2 sessions from their goals')
    options.action.onClick()
    await vi.waitFor(() =>
      expect(stores.tabs).toEqual({
        t1: { title: 'worker-task_5ad8df40da3a', origin: 'unknown' },
        t2: { title: ' claude conversation ', origin: 'unknown' }
      })
    )
  })

  it('records a created tab’s first title as the launch’s, never the person’s', async () => {
    const stores = createStores({ t4: { title: null } })
    const { rpc, calls } = fakeRpc({ 'sessionOrganization.settle': { revision: 'op-4' } })
    const outcome = await titleNewTerminalTab(
      { tabId: 't4', title: 'Refund triage', origin: 'unknown' },
      { stores, rpc, mintOpId: () => 'op-4' }
    )
    expect(outcome).toMatchObject({ status: 'applied', before: [null], after: ['Refund triage'] })
    expect(calls.map((call) => call.method)).toEqual([
      'sessionOrganization.prepare',
      'sessionOrganization.settle'
    ])
    expect(calls[1]!.params.change).toMatchObject({
      kind: 'title',
      targets: [{ tabId: 't4', sessionKey: 'row-t4' }],
      value: 'Refund triage',
      origin: 'unknown',
      executor: { kind: 'launch', source: 'terminal-create' }
    })
    expect(stores.tabs.t4).toEqual({ title: 'Refund triage', origin: 'unknown' })
    expect(appMocks.setTabCustomTitle).not.toHaveBeenCalled()
  })

  it('still names a created tab when its first title cannot be recorded', async () => {
    const stores = createStores({ t5: { title: null } })
    const rpc = vi.fn(async () => {
      throw new Error('trail unwritable')
    }) as unknown as OrganizationRpc
    const outcome = await titleNewTerminalTab(
      { tabId: 't5', title: 'Ads: Q4', origin: 'generated' },
      { stores, rpc }
    )
    expect(outcome?.status).toBe('refused')
    expect(appMocks.setTabCustomTitle).toHaveBeenCalledWith('t5', 'Ads: Q4', {
      recordInteraction: false,
      origin: 'generated'
    })
  })

  it('records the pane header rename as the person’s, origin yours, with no Undo values', async () => {
    const { rpc, calls } = fakeRpc()
    const leafId = '00000000-0000-4000-8000-000000000009'
    recordPaneRenameByPerson({ tabId: 't6', leafId, title: 'Checkout fixes' }, { rpc })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      method: 'sessionOrganization.settle',
      params: {
        phase: 'applied',
        change: {
          opId: expect.any(String),
          kind: 'title',
          targets: [{ tabId: 't6', sessionKey: 'row-t6', paneKey: `t6:${leafId}` }],
          value: 'Checkout fixes',
          origin: 'yours',
          executor: { kind: 'person', via: 'pane-rename' }
        }
      }
    })
  })
})
