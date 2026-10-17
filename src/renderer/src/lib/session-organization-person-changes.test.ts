import { describe, expect, it, vi } from 'vitest'
import { emptyProjectSettings } from '../../../shared/project-settings'
import {
  inverseOrganizationKind,
  revisionFieldOf
} from '../../../shared/session-organization-change'
import { applyPersonOrganizationChange } from './session-organization-change'
import {
  archiveSessionsByPerson,
  colorFolderGroupByPerson,
  createFolderByPerson,
  deleteFolderByPerson,
  deleteSessionsByPerson,
  moveFolderByPerson,
  moveSessionsByPerson,
  renameFolderByPerson,
  setProjectSettingsByPerson
} from './session-organization-person-changes'
import {
  CHECKOUT,
  createOrganizationTestStores,
  fakeOrganizationRpc,
  SALES
} from './session-organization-test-fixture'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

function setup(answers: Record<string, unknown> = {}) {
  const stores = createOrganizationTestStores()
  const { rpc, calls } = fakeOrganizationRpc(answers)
  const onRecordFailure = vi.fn()
  let next = 0
  const deps = { stores, rpc, onRecordFailure, mintOpId: () => `op-${++next}` }
  return { stores, calls, onRecordFailure, options: { deps } }
}

const settled = async () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a person’s sidebar change', () => {
  it('archives a paired session on its owner without writing the viewer archive store', async () => {
    const { stores, calls, options } = setup({ 'sessionHosts.archive': { status: 'completed' } })
    const key = JSON.stringify(['runtime:laptop', 'pane', 'work', 'tab:leaf'])
    expect(await archiveSessionsByPerson([key, key], true, options)).toBe(true)
    expect(stores.view.getState().archived).toEqual([])
    expect(calls).toEqual([
      { method: 'sessionHosts.archive', params: { viewKey: key, archived: true } }
    ])
  })

  it.each([
    { status: 'pending', operationId: 'op-awaiting-owner' },
    () => {
      throw new Error('owner disconnected')
    }
  ])('does not pretend an unconfirmed owner archive succeeded', async (response) => {
    const { stores, options } = setup({ 'sessionHosts.archive': response })
    const key = JSON.stringify(['runtime:laptop', 'pane', 'work', 'tab:leaf'])
    expect(await archiveSessionsByPerson([key], true, options)).toBe(false)
    expect(stores.view.getState().archived).toEqual([])
  })

  it('moves a whole selection as one applied record, before any IPC returns', async () => {
    const { stores, calls, options } = setup()
    expect(moveSessionsByPerson(['a', 'b', 'a'], CHECKOUT, options)).toBe(true)
    // Applied synchronously: the store already holds it.
    expect(stores.folders.getState().metadata.membership).toMatchObject({
      a: CHECKOUT,
      b: CHECKOUT
    })
    await settled()
    expect(calls).toEqual([
      {
        method: 'sessionOrganization.settle',
        params: {
          phase: 'applied',
          change: {
            opId: 'op-1',
            kind: 'move',
            targets: [{ sessionKey: 'a' }, { sessionKey: 'b' }],
            value: CHECKOUT,
            executor: { kind: 'person', via: 'sidebar' }
          },
          before: [SALES, null],
          after: [CHECKOUT, CHECKOUT]
        }
      }
    ])
  })

  it('never blocks the person when the record fails: the change holds and a toast says so', async () => {
    const { stores, onRecordFailure, options } = setup({
      'sessionOrganization.settle': () => {
        throw new Error('runtime unavailable')
      }
    })
    expect(await archiveSessionsByPerson(['a'], true, options)).toBe(true)
    await settled()
    expect(stores.view.getState().archived).toEqual(['a'])
    expect(onRecordFailure).toHaveBeenCalledWith('runtime unavailable')
  })

  it('records archive, unarchive and delete with the surface that made them', async () => {
    const { calls, options } = setup()
    archiveSessionsByPerson(['a'], true, options)
    archiveSessionsByPerson(['a'], false, { ...options, via: 'notice' })
    deleteSessionsByPerson(['b'], true, options)
    await settled()
    expect(
      calls.map(({ params }) => {
        const change = params.change as { kind: string; value: unknown; executor: unknown }
        return [change.kind, change.value, change.executor, params.after]
      })
    ).toEqual([
      ['archive', true, { kind: 'person', via: 'sidebar' }, [true]],
      ['unarchive', false, { kind: 'person', via: 'notice' }, [false]],
      ['delete', true, { kind: 'person', via: 'sidebar' }, [true]]
    ])
  })

  it('writes nothing for an empty selection', async () => {
    const { calls, options } = setup()
    expect(moveSessionsByPerson([], CHECKOUT, options)).toBe(true)
    await settled()
    expect(calls).toEqual([])
  })

  it('records folder create, rename, move, color and delete, one record each', async () => {
    const { stores, calls, options } = setup()
    const id = createFolderByPerson('Planning', 'saved', undefined, options)!
    expect(id).toBeTruthy()
    expect(renameFolderByPerson(id, ' Review ', options)).toBe(true)
    expect(moveFolderByPerson(SALES, CHECKOUT, undefined, options)).toBe(true)
    expect(colorFolderGroupByPerson(`folder:${CHECKOUT}`, 'blue', options)).toBe(true)
    expect(deleteFolderByPerson(id, options)).toBe(true)
    expect(stores.folders.getState().metadata.folders.some((folder) => folder.id === id)).toBe(
      false
    )
    await settled()
    expect(
      calls.map(({ params }) => {
        const change = params.change as { kind: string; targets: unknown }
        return [change.kind, change.targets, params.before, params.after]
      })
    ).toEqual([
      [
        'folder.create',
        [{ folderId: id }],
        [null],
        [{ name: 'Planning', parentId: null, section: 'saved' }]
      ],
      ['folder.rename', [{ folderId: id }], ['Planning'], ['Review']],
      [
        'folder.move',
        [{ folderId: SALES }],
        [{ parentId: null, section: 'active' }],
        [{ parentId: CHECKOUT, section: 'active' }]
      ],
      ['folder.color', [{ folderId: CHECKOUT }], [null], ['blue']],
      [
        'folder.delete',
        [{ folderId: id }],
        [{ name: 'Review', parentId: null, section: 'saved' }],
        [null]
      ]
    ])
  })

  it('records nothing when the store refuses, and reports the refusal', async () => {
    const { stores, calls, options } = setup()
    expect(createFolderByPerson('Sales', undefined, undefined, options)).toBeNull()
    expect(renameFolderByPerson(CHECKOUT, 'Sales', options)).toBe(false)
    expect(stores.folders.getState().error).toBeTruthy()
    expect(deleteFolderByPerson('missing', options)).toBe(false)
    await settled()
    expect(calls).toEqual([])
  })
})

describe('a person’s project settings', () => {
  const settings = { ...emptyProjectSettings(1), repos: [{ gitIdentity: 'github.com/acme/ads' }] }
  const recorded = (calls: { params: Record<string, unknown> }[]) =>
    calls.map(({ params }) => {
      const change = params.change as { kind: string; value: unknown }
      return [change.kind, change.value, params.before, params.after]
    })

  it('creates a project in one edit and one recorded folder.create carrying its settings', async () => {
    const { stores, calls, options } = setup()
    const id = createFolderByPerson('Ads', undefined, undefined, { ...options, project: settings })!
    expect(stores.folders.getState().metadata.projects?.[id]).toEqual(settings)
    await settled()
    expect(recorded(calls)).toEqual([
      [
        'folder.create',
        { name: 'Ads', parentId: null, section: 'active', project: settings },
        [null],
        [{ name: 'Ads', parentId: null, section: 'active', project: settings }]
      ]
    ])
  })

  it('saves nothing when the new folder cannot be a project', async () => {
    const { stores, calls, options } = setup()
    const before = stores.folders.getState().metadata
    expect(createFolderByPerson('Ads', undefined, SALES, { ...options, project: settings })).toBe(
      null
    )
    expect(stores.folders.getState().metadata).toBe(before)
    expect(stores.folders.getState().error).toMatch(/is a project/)
    await settled()
    expect(calls).toEqual([])
  })

  it('records a save and a removal as folder.project, which Undo puts back by value', async () => {
    const { stores, calls, options } = setup()
    expect(setProjectSettingsByPerson(SALES, settings, options)).toBe(true)
    expect(setProjectSettingsByPerson(SALES, null, options)).toBe(true)
    expect(stores.folders.getState().metadata.projects?.[SALES]).toBeUndefined()
    await settled()
    expect(recorded(calls)).toEqual([
      ['folder.project', settings, [null], [settings]],
      ['folder.project', null, [settings], [null]]
    ])
    expect(inverseOrganizationKind('folder.project')).toBe('folder.project')
    expect(revisionFieldOf('folder.project')).toBe('folder.project')
    const undo = applyPersonOrganizationChange(
      {
        kind: 'folder.project',
        targets: [{ folderId: SALES }],
        value: settings,
        executor: { kind: 'person', via: 'notice' },
        undoOf: 'op-2'
      },
      options.deps
    )
    expect(undo.outcome.status).toBe('applied')
    expect(stores.folders.getState().metadata.projects?.[SALES]).toEqual(settings)
  })

  it('refuses invalid settings with the store’s reason, and a value that is not settings', () => {
    const { stores, options } = setup()
    const invalid = { ...settings, repos: [settings.repos[0]!, settings.repos[0]!] }
    expect(setProjectSettingsByPerson(SALES, invalid, options)).toBe(false)
    expect(stores.folders.getState().error).toBe('That repo is already in this project.')
    const stray = applyPersonOrganizationChange(
      {
        kind: 'folder.project',
        targets: [{ folderId: SALES }],
        value: false,
        executor: { kind: 'person', via: 'sidebar' }
      },
      options.deps
    )
    expect(stray.outcome.status).toBe('failed')
    expect(stores.folders.getState().metadata.projects?.[SALES]).toBeUndefined()
  })
})

// Session parity, step 7 (C4): a ledger row's conversation runs on its paired owner, so a delete
// never marks its key here (the sidebar refuses the row first); the owner's own keys delete as
// before, an undo still brings any key back, and owner-routed archive keeps working (F13).
describe('a person’s delete of a ledger row key', () => {
  const LEDGER_KEY = JSON.stringify([
    'runtime:laptop',
    'ledger',
    'work',
    'c:0123456789abcdef01234567'
  ])
  const LOCAL_KEY = JSON.stringify(['local', 'pane', 'work', 'tab:leaf'])
  const MIRROR_TAB_KEY = JSON.stringify(['runtime:laptop', 'pane', 'work', 'web-terminal-t:leaf'])

  it("drops the ledger key and deletes the owner's own key", async () => {
    const { stores, calls, options } = setup()
    expect(deleteSessionsByPerson([LEDGER_KEY, LOCAL_KEY], true, options)).toBe(true)
    await settled()
    expect(stores.view.getState().view.deleted).toEqual([LOCAL_KEY])
    expect(
      calls.map(({ params }) =>
        (params.change as { targets: { sessionKey: string }[] }).targets.map(
          (target) => target.sessionKey
        )
      )
    ).toEqual([[LOCAL_KEY]])
  })

  it('lets an undo name a ledger key', async () => {
    const { calls, options } = setup()
    expect(deleteSessionsByPerson([LEDGER_KEY], false, options)).toBe(true)
    await settled()
    expect(calls).toHaveLength(1)
  })

  it('keeps owner-routed archive for a mirrored tab row the ledger joined (F13)', async () => {
    const { stores, calls, options } = setup({ 'sessionHosts.archive': { status: 'completed' } })
    expect(await archiveSessionsByPerson([MIRROR_TAB_KEY], true, options)).toBe(true)
    expect(stores.view.getState().archived).toEqual([])
    expect(calls).toEqual([
      { method: 'sessionHosts.archive', params: { viewKey: MIRROR_TAB_KEY, archived: true } }
    ])
  })
})
