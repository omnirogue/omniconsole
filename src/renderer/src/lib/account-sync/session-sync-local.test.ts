import { describe, expect, it } from 'vitest'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolderMetadata } from '@/lib/session-folders'
import { localKeyDigest } from '../../../../shared/account-sync-session-keys'
import { applySynced, survivingFolder } from './session-sync-apply'
import {
  adoptSyncedFolderIds,
  authorLocalEdits,
  projectLocal,
  type LocalSyncInput
} from './session-sync-local'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const LOCAL_B = '33333333-3333-4333-8333-333333333333'
const KEY = JSON.stringify(['local', 'provider', 'repo::/app\0codex\0codex\0s1'])
const OTHER = JSON.stringify(['local', 'provider', 'repo::/app\0codex\0codex\0s2'])
const DIGEST = localKeyDigest(KEY)!

const input = (metadata: Partial<SessionFolderMetadata>, extra: Partial<LocalSyncInput> = {}) => ({
  metadata: { version: 1 as const, folders: [], membership: {}, ...metadata },
  archived: [],
  archivedAt: {},
  present: [],
  folderPaths: {},
  ...extra
})

describe('projectLocal and authorLocalEdits', () => {
  const none = {
    filed: new Set<string>(),
    archived: new Set<string>(),
    folders: new Set<string>(),
    gone: new Map()
  }
  const counter = () => {
    let time = 100
    return () => ++time
  }
  const empty = { sessions: {}, folders: {} }
  const filedInA = () =>
    projectLocal(input({ folders: [{ id: A, name: 'A' }], membership: { [KEY]: A } }))

  it('fills in only what the account lacks, unless the person made the change', () => {
    const first = authorLocalEdits({
      merged: empty,
      now: filedInA(),
      intent: none,
      stamp: counter()
    })
    expect(first.sessions[DIGEST]).toEqual({ f: [A, 101] })
    expect(first.folders[A]).toEqual({ n: 'A', t: 102 })
    // The account files it elsewhere: this computer's own filing (lost storage, a reload, a change
    // the sync applied but never recorded) is the account's to set, not an edit.
    const known = {
      sessions: { [DIGEST]: { f: [B, 5] as [string, number] } },
      folders: { [A]: { n: 'A', t: 1 } }
    }
    expect(
      authorLocalEdits({ merged: known, now: filedInA(), intent: none, stamp: counter() })
    ).toEqual({ sessions: {}, folders: {} })
    expect(
      authorLocalEdits({
        merged: known,
        now: filedInA(),
        intent: { ...none, filed: new Set([KEY]) },
        stamp: counter()
      }).sessions[DIGEST]
    ).toEqual({ f: [A, 101] })
  })

  it('clears and deletes only for the person, and a deleted folder as it was when deleted', () => {
    const known = {
      sessions: { [DIGEST]: { f: [A, 5] as [string, number], a: [7, 5] as [number, number] } },
      folders: { [A]: { n: 'A', s: 'saved' as const, t: 1 } }
    }
    const cleared = projectLocal(input({}, { present: [KEY] }))
    expect(
      authorLocalEdits({ merged: known, now: cleared, intent: none, stamp: counter() })
    ).toEqual({ sessions: {}, folders: {} })
    const edits = authorLocalEdits({
      merged: known,
      now: cleared,
      intent: {
        filed: new Set([KEY]),
        archived: new Set([KEY]),
        folders: new Set([A]),
        // Moved out of Saved, then deleted, before this computer synced the move.
        gone: new Map([[A, { n: 'A' }]])
      },
      stamp: counter()
    })
    expect(edits.sessions[DIGEST]).toEqual({ f: [null, 101], a: [null, 102] })
    expect(edits.folders[A]).toEqual({ n: 'A', t: 103, x: 1 })
    // Without a record of how it was, the account's copy is what gets deleted.
    expect(
      authorLocalEdits({
        merged: known,
        now: cleared,
        intent: { ...none, folders: new Set([A]) },
        stamp: counter()
      }).folders[A]
    ).toEqual({ n: 'A', s: 'saved', t: 101, x: 1 })
  })
})

describe('adoptSyncedFolderIds', () => {
  it('gives a folder the id of the synced folder with its name and place', () => {
    const adopted = adoptSyncedFolderIds(
      {
        version: 1,
        folders: [
          { id: LOCAL_B, name: 'B' },
          { id: '44444444-4444-4444-8444-444444444444', name: 'Kid', parentId: LOCAL_B }
        ],
        membership: { [KEY]: LOCAL_B },
        finishActions: { [OTHER]: { action: 'save', folderId: LOCAL_B } }
      },
      { [B]: { n: 'B', t: 1 }, '55555555-5555-4555-8555-555555555555': { n: 'Kid', p: B, t: 1 } }
    )!
    expect(adopted.folders).toEqual([
      { id: B, name: 'B' },
      { id: '55555555-5555-4555-8555-555555555555', name: 'Kid', parentId: B }
    ])
    expect(adopted.membership).toEqual({ [KEY]: B })
    // A session set to be saved into the folder when it finishes still goes there.
    expect(adopted.finishActions).toEqual({ [OTHER]: { action: 'save', folderId: B } })
    expect(adoptSyncedFolderIds(input({ folders: [{ id: A, name: 'A' }] }).metadata, {})).toBeNull()
  })
})

describe('applySynced', () => {
  it('corrects an old key it no longer shows, but gives it no new state', () => {
    const OLD = JSON.stringify(['local', 'provider', 'repo-old::/app\0codex\0codex\0s1'])
    const STALE = JSON.stringify(['local', 'provider', 'repo-gone::/app\0codex\0codex\0s1'])
    const local = input(
      { folders: [{ id: A, name: 'A' }], membership: { [OLD]: B } },
      {
        present: [KEY],
        archived: [STALE]
      }
    )
    const filedAndArchived = applySynced(local, projectLocal(local), {
      folders: { [A]: { n: 'A', t: 1 } },
      sessions: { [DIGEST]: { f: [A, 3], a: [9, 4] } }
    })
    // The shown key and the old key that had a folder follow; the stale one gets no folder.
    expect(filedAndArchived.metadata!.membership).toEqual({ [OLD]: A, [KEY]: A })
    expect(filedAndArchived.archive).toEqual([KEY])
    const cleared = applySynced(local, projectLocal(local), {
      folders: { [A]: { n: 'A', t: 1 } },
      sessions: { [DIGEST]: { f: [null, 3], a: [null, 4] } }
    })
    expect(cleared.metadata!.membership).toEqual({})
    expect(cleared.unarchive).toEqual([STALE])
  })

  it('follows deleted folders to where their sessions went, and keeps a valid tree', () => {
    const C = '66666666-6666-4666-8666-666666666666'
    const synced = {
      [A]: { n: 'Saved', s: 'saved' as const, t: 1, x: 1 as const },
      [B]: { n: 'Kid', p: C, t: 2, x: 1 as const },
      [C]: { n: 'Parent', t: 3 },
      [LOCAL_B]: { n: 'Grandkid', p: B, t: 4 }
    }
    expect(survivingFolder(synced, A)).toBe(SAVED_SESSIONS_FOLDER_ID)
    expect(survivingFolder(synced, B)).toBe(C)
    expect(survivingFolder(synced, null)).toBeNull()
    const local = input({}, { present: [KEY, OTHER] })
    const applied = applySynced(local, projectLocal(local), {
      folders: synced,
      sessions: {
        [DIGEST]: { f: [A, 5] },
        [localKeyDigest(OTHER)!]: { f: [B, 6] }
      }
    })
    expect(applied.metadata!.membership).toEqual({ [KEY]: SAVED_SESSIONS_FOLDER_ID, [OTHER]: C })
    expect(applied.metadata!.folders).toEqual([
      { id: C, name: 'Parent' },
      { id: LOCAL_B, name: 'Grandkid', parentId: C }
    ])
    // Two computers nested two folders in each other at once: both go to the top.
    const looped = applySynced(input({}), projectLocal(input({})), {
      sessions: {},
      folders: { [A]: { n: 'A', p: B, t: 1 }, [B]: { n: 'B', p: A, t: 2 } }
    })
    expect(looped.metadata!.folders).toEqual([
      { id: A, name: 'A' },
      { id: B, name: 'B' }
    ])
  })

  it('brings this computer in line: folders, filing under every key it has, and archive', () => {
    const local = input({}, { present: [KEY, OTHER] })
    const projection = projectLocal(local)
    const applied = applySynced(local, projection, {
      folders: { [A]: { n: 'A', t: 1 }, [B]: { n: 'Gone', t: 2, x: 1 } },
      sessions: { [DIGEST]: { f: [A, 3], a: [9, 4] } }
    })
    expect(applied.metadata!.folders).toEqual([{ id: A, name: 'A' }])
    expect(applied.metadata!.membership).toEqual({ [KEY]: A })
    expect(applied.archive).toEqual([KEY])
    expect(applied.unarchive).toEqual([])
    // Nothing to change: no new metadata.
    const settled = input({ folders: [{ id: A, name: 'A' }], membership: { [KEY]: A } })
    expect(
      applySynced(settled, projectLocal(settled), {
        folders: { [A]: { n: 'A', t: 1 } },
        sessions: { [DIGEST]: { f: [A, 3] } }
      }).metadata
    ).toBeNull()
  })
})
