import { describe, expect, it } from 'vitest'
import {
  foldersToAutoCollapse,
  groupKeysHoldingRow,
  groupsOpenedByHand,
  hoveredGroupProtectedKeys,
  protectedFolderGroupKeys
} from './session-folder-auto-collapse'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from './session-folders'
import {
  emptySessionSidebarView,
  isSessionGroupCollapsed,
  sessionFolderGroupKey
} from './session-sidebar-view'

const sales = '00000000-0000-4000-8000-000000000001'
const leads = '00000000-0000-4000-8000-000000000002'
const folders: SessionFolder[] = [
  { id: sales, name: 'Sales', section: 'saved' },
  { id: leads, name: 'Leads', section: 'saved', parentId: sales }
]
const group = (key: string, attentionCount = 0) => ({
  key,
  kind: 'folder' as const,
  collapsed: false,
  attentionCount
})

describe('idle folder auto-collapse', () => {
  it('folds an open folder after the idle wait, and not before', () => {
    const idleSince = new Map<string, number>()
    const groups = [group(sessionFolderGroupKey(sales))]
    const tick = (now: number) =>
      foldersToAutoCollapse({ groups, protectedKeys: new Set(), idleSince, now, seconds: 15 })
    expect(tick(0)).toEqual([])
    expect(tick(14_000)).toEqual([])
    expect(tick(15_000)).toEqual([sessionFolderGroupKey(sales)])
  })

  it('keeps a folder open while something in it needs you, restarting its clock', () => {
    const idleSince = new Map<string, number>()
    const key = sessionFolderGroupKey(sales)
    foldersToAutoCollapse({
      groups: [group(key)],
      protectedKeys: new Set(),
      idleSince,
      now: 0,
      seconds: 15
    })
    const busy = foldersToAutoCollapse({
      groups: [group(key, 1)],
      protectedKeys: new Set(),
      idleSince,
      now: 20_000,
      seconds: 15
    })
    expect(busy).toEqual([])
    expect(idleSince.get(key)).toBe(20_000)
  })

  it('protects the folder holding the open session and every folder above it', () => {
    expect(protectedFolderGroupKeys(folders, [leads])).toEqual(
      new Set([
        sessionFolderGroupKey(leads),
        sessionFolderGroupKey(sales),
        SAVED_SESSIONS_FOLDER_ID
      ])
    )
  })

  it('does nothing when turned off', () => {
    const idleSince = new Map([[sessionFolderGroupKey(sales), 0]])
    expect(
      foldersToAutoCollapse({
        groups: [group(sessionFolderGroupKey(sales))],
        protectedKeys: new Set(),
        idleSince,
        now: 999_000,
        seconds: 0
      })
    ).toEqual([])
  })
})

describe('idle status groups and the row on screen', () => {
  const session = (sessionKey: string) =>
    ({ session: { sessionKey, rowKey: `row-${sessionKey}` } }) as unknown as Parameters<
      typeof groupKeysHoldingRow
    >[0][number]['rows'][number]

  it('folds an idle Active or Done group too, but never Needs you', () => {
    const idleSince = new Map<string, number>()
    const groups = [
      { key: 'workspace:other', kind: 'workspace' as const, collapsed: false, attentionCount: 0 },
      { key: 'completed', kind: 'completed' as const, collapsed: false, attentionCount: 0 },
      { key: 'attention', kind: 'attention' as const, collapsed: false, attentionCount: 0 }
    ]
    const tick = (now: number) =>
      foldersToAutoCollapse({ groups, protectedKeys: new Set(), idleSince, now, seconds: 5 })
    expect(tick(0)).toEqual([])
    expect(tick(5_000)).toEqual(['workspace:other', 'completed'])
  })

  it('keeps the group listing the open row open', () => {
    const idleSince = new Map<string, number>()
    const groups = [
      { key: 'workspace:other', kind: 'workspace' as const, collapsed: false, attentionCount: 0 }
    ]
    const protectedKeys = new Set(
      groupKeysHoldingRow([{ key: 'workspace:other', rows: [session('open')] }], 'open')
    )
    foldersToAutoCollapse({ groups, protectedKeys, idleSince, now: 0, seconds: 5 })
    expect(
      foldersToAutoCollapse({ groups, protectedKeys, idleSince, now: 60_000, seconds: 5 })
    ).toEqual([])
  })

  it('finds a routine row by its key', () => {
    expect(
      groupKeysHoldingRow(
        [
          { key: 'a', rows: [session('x')] },
          { key: 'b', rows: [], routineRows: [{ key: 'routine:local:1' }] }
        ],
        'routine:local:1'
      )
    ).toEqual(['b'])
  })
})

describe('nested folders while you work in them', () => {
  const salesKey = sessionFolderGroupKey(sales)
  const leadsKey = sessionFolderGroupKey(leads)

  it('keeps an open subfolder open while the pointer is over its parent', () => {
    const idleSince = new Map<string, number>()
    const groups = [group(SAVED_SESSIONS_FOLDER_ID), group(salesKey), group(leadsKey)]
    const protectedKeys = hoveredGroupProtectedKeys(folders, salesKey)
    const tick = (now: number) =>
      foldersToAutoCollapse({ groups, protectedKeys, idleSince, now, seconds: 5 })
    expect(tick(0)).toEqual([])
    expect(tick(60_000)).toEqual([])
    expect(protectedKeys).toEqual(new Set([SAVED_SESSIONS_FOLDER_ID, salesKey, leadsKey]))
  })

  it('keeps every saved folder open while the pointer is over Saved Sessions', () => {
    expect(hoveredGroupProtectedKeys(folders, SAVED_SESSIONS_FOLDER_ID)).toEqual(
      new Set([SAVED_SESSIONS_FOLDER_ID, salesKey, leadsKey])
    )
    expect(hoveredGroupProtectedKeys(folders, null)).toEqual(new Set())
  })

  it('never folds a folder opened by hand (its folder:<id>:open mark in the view)', () => {
    const view = { ...emptySessionSidebarView(), collapsed: [`${leadsKey}:open`] }
    const groups = [salesKey, leadsKey].map((key) => ({
      ...group(key),
      collapsed: isSessionGroupCollapsed(view, key)
    }))
    const byHand = groupsOpenedByHand({
      groups,
      revealing: new Set(),
      autoOpened: new Set(),
      seenOpen: new Set()
    })
    expect(byHand).toEqual(new Set([leadsKey]))
    const idleSince = new Map<string, number>()
    const tick = (now: number) =>
      foldersToAutoCollapse({ groups, protectedKeys: byHand, idleSince, now, seconds: 5 })
    tick(0)
    expect(tick(60_000)).toEqual([])
  })

  it('still folds folders a drag or the row on screen opened', () => {
    const autoOpened = new Set([salesKey])
    const seenOpen = new Set<string>()
    const groups = [group(salesKey), group(leadsKey)]
    const byHand = groupsOpenedByHand({
      groups,
      revealing: new Set([leadsKey]),
      autoOpened,
      seenOpen
    })
    expect(byHand).toEqual(new Set())
    const idleSince = new Map<string, number>()
    const tick = (now: number) =>
      foldersToAutoCollapse({ groups, protectedKeys: byHand, idleSince, now, seconds: 5 })
    tick(0)
    expect(tick(5_000)).toEqual([salesKey, leadsKey])
  })

  it('counts a folder as opened by hand once it was folded and opened again', () => {
    const autoOpened = new Set([salesKey])
    const seenOpen = new Set<string>()
    const tick = (collapsed: boolean) =>
      groupsOpenedByHand({
        groups: [{ ...group(salesKey), collapsed }],
        revealing: new Set(),
        autoOpened,
        seenOpen
      })
    expect(tick(false)).toEqual(new Set())
    tick(true)
    expect(tick(false)).toEqual(new Set([salesKey]))
  })

  it('keeps a drag-opened folder automatic until the open shows up', () => {
    const autoOpened = new Set([salesKey])
    const seenOpen = new Set<string>()
    const tick = (collapsed: boolean) =>
      groupsOpenedByHand({
        groups: [{ ...group(salesKey), collapsed }],
        revealing: new Set(),
        autoOpened,
        seenOpen
      })
    tick(true)
    expect(tick(false)).toEqual(new Set())
  })
})
