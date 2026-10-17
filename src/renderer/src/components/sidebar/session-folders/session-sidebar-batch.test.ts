import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySessionFolderMetadata, SAVED_SESSIONS_FOLDER_ID } from '@/lib/session-folders'
import { resolveSessionGroupDrop, type SessionSidebarDragBatch } from '@/lib/session-sidebar-drag'
import { sessionFolderGroupKey } from '@/lib/session-sidebar-view'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSelection } from '@/store/session-selection'
import { moveSessionSidebarBatch, sessionSidebarDragBatch } from './session-sidebar-batch'

function fakeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key)
  }
}

/** Affiliates (Conversations) and Payouts / June (Saved), with one session in each spot. */
function seed() {
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
  const folders = useSessionFolders.getState()
  const affiliates = folders.createFolder('Affiliates')!
  const payouts = folders.createFolder('Payouts', 'saved')!
  const june = folders.createFolder('June', 'saved', payouts)!
  useSessionFolders.getState().moveSession('in-june', june)
  useSessionFolders.getState().moveSession('loose', SAVED_SESSIONS_FOLDER_ID)
  return { affiliates, payouts, june }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
  useSessionSelection.getState().set([])
})

describe('dragging a selection of folders and sessions', () => {
  it('carries the whole selection only when the dragged item is part of it', () => {
    const { payouts } = seed()
    useSessionSelection.getState().toggle('loose')
    useSessionSelection.getState().toggleFolder(payouts)
    expect(sessionSidebarDragBatch({ sessionKey: 'loose' })).toMatchObject({
      sessionKeys: ['loose'],
      folderIds: [payouts]
    })
    expect(sessionSidebarDragBatch({ sessionKey: 'other' })).toBeUndefined()
  })

  // E1/F13 (session parity, Phase 1b): a row a paired owner's ledger created is filed on its owner.
  it('never carries a ledger-only row in a dragged selection', () => {
    seed()
    const ledgerKey = JSON.stringify(['runtime:env-studio', 'ledger', 'repo:/w', 'c:0123'])
    const joinedKey = JSON.stringify(['runtime:env-studio', 'pane', 'repo:/w', 'tab:leaf'])
    for (const key of ['loose', ledgerKey, joinedKey]) {
      useSessionSelection.getState().toggle(key)
    }
    expect(sessionSidebarDragBatch({ sessionKey: 'loose' })?.sessionKeys).toEqual([
      'loose',
      joinedKey
    ])
    useSessionSelection.getState().toggle(joinedKey)
    // Why undefined: with the ledger row left behind, the dragged row moves alone, as before.
    expect(sessionSidebarDragBatch({ sessionKey: 'loose' })).toBeUndefined()
  })

  it('moves picked folders and sessions into a folder in one drop', () => {
    const { affiliates, payouts, june } = seed()
    const result = moveSessionSidebarBatch(
      // Why 'in-june': a session inside a picked folder rides along instead of being pulled out.
      { sessionKeys: ['loose', 'in-june'], folderIds: [payouts, june] },
      { kind: 'row', folderId: affiliates },
      { rpc: vi.fn(async () => ({})) as never }
    )
    expect(result).toEqual({ sessions: 1, folders: 1 })
    const { metadata } = useSessionFolders.getState()
    const byId = new Map(metadata.folders.map((folder) => [folder.id, folder]))
    expect(byId.get(payouts)?.parentId).toBe(affiliates)
    expect(byId.get(june)?.parentId).toBe(payouts)
    expect(metadata.membership.loose).toBe(affiliates)
    expect(metadata.membership['in-june']).toBe(june)
    expect(useSessionSelection.getState().folderIds.size).toBe(0)
  })

  it('refuses to drop a batch inside one of its own folders', () => {
    const { payouts, june } = seed()
    const batch: SessionSidebarDragBatch = {
      sessionKeys: ['loose'],
      folderIds: [payouts],
      blockedFolderIds: [payouts, june]
    }
    expect(
      resolveSessionGroupDrop({
        drag: { kind: 'row', sessionKey: 'loose', workspaceGroupKey: 'workspace:other', batch },
        group: {
          key: sessionFolderGroupKey(june),
          kind: 'folder',
          folderId: june,
          canReorder: false
        },
        clientY: 10,
        rect: { top: 0, height: 20 }
      })
    ).toBeNull()
  })
})

describe('a drag is recorded as the person’s change', () => {
  it('records the sessions and the folders it moved, one applied record each, by the sidebar', async () => {
    const { affiliates, payouts } = seed()
    const settled: unknown[] = []
    const rpc = vi.fn(async (method: string, params: unknown) => {
      settled.push({ method, params })
      return { revision: 'r' }
    })
    moveSessionSidebarBatch(
      { sessionKeys: ['loose', 'unfiled-one'], folderIds: [payouts] },
      { kind: 'row', folderId: affiliates },
      {
        rpc: rpc as never,
        mintOpId: (() => {
          let n = 0
          return () => `drag-${(n += 1)}`
        })()
      }
    )
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
    expect(settled).toEqual([
      {
        method: 'sessionOrganization.settle',
        params: {
          phase: 'applied',
          change: {
            opId: 'drag-1',
            kind: 'folder.move',
            targets: [{ folderId: payouts }],
            value: { parentId: affiliates, section: 'active' },
            executor: { kind: 'person', via: 'sidebar' }
          },
          before: [{ parentId: null, section: 'saved' }],
          after: [{ parentId: affiliates, section: 'active' }]
        }
      },
      {
        method: 'sessionOrganization.settle',
        params: {
          phase: 'applied',
          change: {
            opId: 'drag-2',
            kind: 'move',
            targets: [{ sessionKey: 'loose' }, { sessionKey: 'unfiled-one' }],
            value: affiliates,
            executor: { kind: 'person', via: 'sidebar' }
          },
          before: [SAVED_SESSIONS_FOLDER_ID, null],
          after: [affiliates, affiliates]
        }
      }
    ])
  })
})
