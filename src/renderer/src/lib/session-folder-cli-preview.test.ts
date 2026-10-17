import { describe, expect, it, vi } from 'vitest'
import { createSessionFoldersStore } from '@/store/session-folders'
import { createSessionSidebarViewStore } from '@/store/session-sidebar-view'
import type { SessionFolderOp } from '../../../shared/session-folder-cli'
import { previewSessionFolderOp } from './session-folder-cli-preview'
import type { SessionFolderCliStores } from './session-folder-cli-apply'
import type { SessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const SALES = '00000000-0000-4000-8000-000000000001'
const CLIENTS = '00000000-0000-4000-8000-000000000002'
const ACME = '00000000-0000-4000-8000-000000000003'

function createStores() {
  const initial: SessionFolderMetadata = {
    version: 1,
    folders: [
      { id: SALES, name: 'Sales' },
      { id: CLIENTS, name: 'Clients', section: 'saved' },
      { id: ACME, name: 'Acme', section: 'saved', parentId: CLIENTS }
    ],
    membership: { 'pane-a': SALES, 'pane-b': ACME }
  }
  const foldersSave = vi.fn()
  const viewSave = vi.fn()
  const archivedSave = vi.fn()
  const folders = createSessionFoldersStore({ save: foldersSave, load: vi.fn(() => initial) })
  const view = createSessionSidebarViewStore(
    { save: viewSave, load: vi.fn(() => emptySessionSidebarView()) },
    { save: archivedSave, load: vi.fn(() => ['pane-b']) }
  )
  folders.getState().load()
  view.getState().load()
  const stores: SessionFolderCliStores = { folders, view }
  return { stores, saves: [foldersSave, viewSave, archivedSave] }
}

const session = { key: 'pane-a', label: 'Parser fix', tabId: 'tab-1' }

function preview(op: SessionFolderOp, withSession = true) {
  const { stores, saves } = createStores()
  const before = JSON.stringify([stores.folders.getState().metadata, stores.view.getState().view])
  const result = previewSessionFolderOp(op, stores, withSession ? session : null)
  // A dry run writes nothing anywhere: no store change and no storage write.
  expect(JSON.stringify([stores.folders.getState().metadata, stores.view.getState().view])).toBe(
    before
  )
  for (const save of saves) {
    expect(save).not.toHaveBeenCalled()
  }
  return result
}

describe('previewSessionFolderOp', () => {
  it('describes a session move from where it is to where it would go', () => {
    expect(
      preview({
        kind: 'moveSession',
        paneKey: 'p',
        destination: 'folder',
        folder: 'Saved Sessions / Clients / Acme'
      })
    ).toEqual({
      ok: true,
      result: {
        dryRun: true,
        summary:
          'Would move “Parser fix” from “Sales” to “Saved Sessions / Clients / Acme” (dry run: nothing changed).'
      }
    })
  })

  it('checks an archive the way the archive does', () => {
    expect(preview({ kind: 'archiveSession', paneKey: 'p', archived: true })).toMatchObject({
      ok: true,
      result: {
        summary: 'Would archive “Parser fix”; its folder is kept (dry run: nothing changed).'
      }
    })
    expect(preview({ kind: 'archiveSession', paneKey: 'p', archived: false })).toEqual({
      ok: false,
      error: '“Parser fix” is not archived, so there is nothing to unarchive.'
    })
  })

  it('says what a session delete would close', () => {
    const result = preview({ kind: 'deleteSession', paneKey: 'p' })
    expect(result.ok && result.result.summary).toContain('Would delete “Parser fix”')
  })

  it('counts what a folder delete moves up, and where', () => {
    expect(
      preview({ kind: 'deleteFolder', folder: 'Saved Sessions / Clients' }, false)
    ).toMatchObject({
      ok: true,
      result: {
        summary:
          'Would delete folder “Saved Sessions / Clients”: its 0 sessions and 1 subfolder move up into “Saved Sessions”; no session is closed or deleted (dry run: nothing changed).'
      }
    })
  })

  it('refuses a folder move the store would refuse', () => {
    expect(preview({ kind: 'moveFolder', folder: 'Clients', into: 'Acme' }, false)).toMatchObject({
      ok: false
    })
    expect(
      preview({ kind: 'moveFolder', folder: 'Sales', into: 'Saved Sessions / Clients' }, false)
    ).toMatchObject({
      ok: true,
      result: { summary: expect.stringContaining('to “Saved Sessions / Clients / Sales”') }
    })
  })

  it('refuses reordering beside a folder that is not a sibling', () => {
    expect(
      preview({ kind: 'reorderFolder', folder: 'Sales', target: 'Acme', position: 'before' }, false)
    ).toMatchObject({ ok: false })
  })
})
