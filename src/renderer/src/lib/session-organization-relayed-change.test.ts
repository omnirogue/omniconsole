import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type { SessionFolderOp } from '../../../shared/session-folder-cli'
import type { OrganizationRecord } from '../../../shared/session-organization-change'
import { requestedTargetsForFolderOp } from '../../../shared/session-organization-folder-ops'
import { applySessionFolderOp } from './session-folder-cli-apply'
import type { OrganizationRpc } from './session-organization-change'
import {
  answerOrganizationProbe,
  applyRelayedOrganizationChange,
  beginRelayedOrganizationChange,
  type RelayedSession
} from './session-organization-relayed-change'
import type { OrganizationStores } from './session-organization-values'
import type { SessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const SALES = '00000000-0000-4000-8000-000000000001'
const CHECKOUT = '00000000-0000-4000-8000-000000000002'

function createStores(): OrganizationStores {
  const initial: SessionFolderMetadata = {
    version: 1,
    folders: [
      { id: SALES, name: 'Sales' },
      { id: CHECKOUT, name: 'Checkout' }
    ],
    membership: { 'key-a': SALES }
  }
  const folders = createSessionFoldersStore({ save: vi.fn(), load: vi.fn(() => initial) })
  const view = createSessionSidebarViewStore(
    { save: vi.fn(), load: vi.fn(() => emptySessionSidebarView()) },
    { save: vi.fn(), load: vi.fn(() => []) }
  )
  folders.getState().load()
  view.getState().load()
  return { folders, view }
}

const SESSION: RelayedSession = { key: 'key-a', tabId: 'tab-a' }
const MOVE: SessionFolderOp = {
  kind: 'moveSession',
  paneKey: 'tab-a:leaf-1',
  destination: 'folder',
  folder: 'Checkout'
}

/** What the folder bridge does with one relayed op: begin, apply as today, finish. */
function relay(
  stores: OrganizationStores,
  op: SessionFolderOp,
  change: Parameters<typeof beginRelayedOrganizationChange>[0]['change'],
  rpc?: OrganizationRpc
) {
  const organization = beginRelayedOrganizationChange({
    op,
    change,
    session: SESSION,
    stores,
    deps: { ...(rpc ? { rpc } : {}), mintOpId: () => 'window-op' }
  })
  const applied = applySessionFolderOp(op, stores, {
    key: SESSION.key,
    label: 'Ads',
    tabId: 'tab-a'
  })
  if (!applied.ok) {
    throw new Error(applied.error)
  }
  return organization.finish(applied.result)
}

describe('beginRelayedOrganizationChange', () => {
  it('answers main’s change with resolved targets and the folder ids before and after', () => {
    const stores = createStores()
    const result = relay(stores, MOVE, {
      opId: 'op-agent',
      executor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' },
      reason: 'checkout work'
    })
    expect(result.organization).toEqual({
      opId: 'op-agent',
      targets: [{ sessionKey: 'key-a', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' }],
      value: CHECKOUT,
      before: [SALES],
      after: [CHECKOUT]
    })
    expect(stores.folders.getState().metadata.membership['key-a']).toBe(CHECKOUT)
  })

  it('refuses before applying when the revision check does', () => {
    const stores = createStores()
    expect(() =>
      beginRelayedOrganizationChange({
        op: MOVE,
        change: {
          opId: 'op-agent',
          executor: { kind: 'cli' },
          reason: 'why',
          expectedRevision: 'op-old'
        },
        session: SESSION,
        stores,
        deps: { checkRevision: () => 'Changed since: you moved it.' }
      })
    ).toThrow('Changed since: you moved it.')
    expect(stores.folders.getState().metadata.membership['key-a']).toBe(SALES)
  })

  it('still applies a move from an older main that sends no change, recording it best effort', async () => {
    const stores = createStores()
    const rpc = vi.fn(async () => {
      throw new Error('Unknown method: sessionOrganization.prepare')
    }) as unknown as OrganizationRpc
    const result = relay(stores, MOVE, undefined, rpc)
    expect(result).not.toHaveProperty('organization')
    expect(stores.folders.getState().metadata.membership['key-a']).toBe(CHECKOUT)
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    expect(vi.mocked(rpc).mock.calls[0]).toEqual([
      'sessionOrganization.prepare',
      {
        change: {
          opId: 'window-op',
          kind: 'move',
          executor: { kind: 'cli' },
          targets: [{ sessionKey: 'key-a', paneKey: 'tab-a:leaf-1', tabId: 'tab-a' }],
          value: CHECKOUT
        },
        before: [SALES]
      }
    ])
  })

  it('names a created folder by its new id', () => {
    const stores = createStores()
    const result = relay(
      stores,
      { kind: 'createFolder', name: 'Ops' },
      {
        opId: 'op-create',
        executor: { kind: 'cli' }
      }
    )
    const created = stores.folders
      .getState()
      .metadata.folders.find((folder) => folder.name === 'Ops')
    expect(result.organization).toMatchObject({
      opId: 'op-create',
      targets: [{ folderId: created?.id }],
      value: { name: 'Ops', parent: null, saved: false }
    })
  })
})

describe('answerOrganizationProbe', () => {
  const prepared = (extra: Partial<OrganizationRecord>): OrganizationRecord => ({
    opId: 'crash-1',
    kind: 'move',
    targets: [{ paneKey: 'tab-a:leaf-1' }],
    value: 'Checkout',
    executor: { kind: 'cli' },
    phase: 'prepared',
    ts: '2026-09-25T10:00:00.000Z',
    ...extra
  })
  const find = (target: { paneKey?: string }) =>
    target.paneKey === 'tab-a:leaf-1' ? SESSION : null

  it('confirms a move whose target holds the folder it named', () => {
    const stores = createStores()
    stores.folders.getState().moveSessions(['key-a'], CHECKOUT)
    expect(answerOrganizationProbe([prepared({})], stores, find)).toEqual([
      {
        opId: 'crash-1',
        holds: true,
        targets: [{ paneKey: 'tab-a:leaf-1', sessionKey: 'key-a' }],
        value: CHECKOUT,
        after: [CHECKOUT]
      }
    ])
  })

  it('denies a move that did not land, and cannot tell for a missing row or folder op', () => {
    const stores = createStores()
    expect(answerOrganizationProbe([prepared({})], stores, find)).toEqual([
      { opId: 'crash-1', holds: false }
    ])
    expect(
      answerOrganizationProbe(
        [
          prepared({ targets: [{ paneKey: 'tab-gone:leaf-1' }] }),
          prepared({ opId: 'f', kind: 'folder.rename', targets: [], value: 'X' })
        ],
        stores,
        find
      )
    ).toEqual([
      { opId: 'crash-1', holds: null },
      { opId: 'f', holds: null }
    ])
  })

  // Why (C6): an interrupted archive of a pane-less workflow anchor is checked by its run.
  it('checks an interrupted workflow archive by the anchor its record names', () => {
    const stores = createStores()
    stores.view.getState().setArchived(['key-a'], true)
    const workflow = { controller: 'local' as const, runId: 'execution-1' }
    const findAnchor = (target: { tabId?: string; workflow?: typeof workflow }) =>
      target.workflow?.runId === 'execution-1' && target.tabId === 'tab-a' ? SESSION : null
    const record = prepared({
      kind: 'archive',
      value: true,
      targets: [{ tabId: 'tab-a', workflow }]
    })
    expect(answerOrganizationProbe([record], stores, findAnchor)).toMatchObject([
      { opId: 'crash-1', holds: true, targets: [{ tabId: 'tab-a', workflow, sessionKey: 'key-a' }] }
    ])
    expect(
      requestedTargetsForFolderOp({
        kind: 'archiveSession',
        tabId: 'tab-a',
        workflow,
        archived: true
      })
    ).toEqual([{ tabId: 'tab-a', workflow }])
  })

  it('checks an archive by its archived state', () => {
    const stores = createStores()
    stores.view.getState().setArchived(['key-a'], true)
    expect(
      answerOrganizationProbe(
        [prepared({ kind: 'archive', value: true, targets: [{ sessionKey: 'key-a' }] })],
        stores,
        find
      )[0]
    ).toMatchObject({ holds: true, after: [true] })
  })
})

describe('applyRelayedOrganizationChange (one change, many targets)', () => {
  const panes = Array.from({ length: 100 }, (_, index) => `tab-${index}:leaf-1`)
  const findByPane = (target: { paneKey?: string }) =>
    target.paneKey?.startsWith('tab-') ? { key: `key-${target.paneKey}` } : null

  it('finds every pane’s row, resolves the folder path and moves all 100 as one change', () => {
    const stores = createStores()
    const outcome = applyRelayedOrganizationChange(
      {
        opId: 'bulk-1',
        kind: 'move',
        targets: panes.map((paneKey) => ({ paneKey })),
        value: 'Checkout',
        executor: { kind: 'pane', paneKey: 'tab-9:leaf-9', title: 'Ads review' },
        reason: 'the person asked'
      },
      stores,
      findByPane
    )
    expect(outcome.value).toBe(CHECKOUT)
    expect(outcome.targets[0]).toEqual({ paneKey: 'tab-0:leaf-1', sessionKey: 'key-tab-0:leaf-1' })
    expect([outcome.before?.length, outcome.after?.length]).toEqual([100, 100])
    expect(new Set(outcome.after)).toEqual(new Set([CHECKOUT]))
    const membership = stores.folders.getState().metadata.membership
    expect(panes.every((paneKey) => membership[`key-${paneKey}`] === CHECKOUT)).toBe(true)
  })

  it('changes nothing when one target or the folder is missing', () => {
    const stores = createStores()
    const change = {
      opId: 'bulk-2',
      kind: 'move' as const,
      targets: [{ paneKey: 'tab-1:leaf-1' }, { paneKey: 'gone:leaf-1' }],
      value: 'Checkout',
      executor: { kind: 'cli' as const },
      reason: 'why'
    }
    expect(() => applyRelayedOrganizationChange(change, stores, findByPane)).toThrow(
      'No conversation in the sidebar matches pane gone:leaf-1. Nothing changed.'
    )
    expect(() =>
      applyRelayedOrganizationChange(
        { ...change, targets: [{ paneKey: 'tab-1:leaf-1' }], value: 'Nowhere' },
        stores,
        findByPane
      )
    ).toThrow('Nothing changed.')
    expect(stores.folders.getState().metadata.membership['key-tab-1:leaf-1']).toBeUndefined()
  })
})
