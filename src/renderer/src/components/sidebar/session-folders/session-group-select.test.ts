import { describe, expect, it } from 'vitest'
import { conversationViewKey } from '@/lib/conversation-view'
import { SAVED_SESSIONS_FOLDER_ID } from '@/lib/session-folders'
import {
  sessionFolderGroupKey,
  type SessionSidebarGroup,
  type SessionSidebarTreeRow
} from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { ConversationRoutineRow } from '@/lib/conversation-routine-rows'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import { flattenSessionSidebarGroups } from './session-sidebar-virtual-rows'
import { visibleSessionSelection } from './session-multi-selection'
import {
  SESSION_ARCHIVED_OLDER_THAN_MS,
  sessionGroupSelectionKeys,
  sessionGroupSubtreeKeys
} from './use-session-group-select'

const CLIENTS = '00000000-0000-4000-8000-000000000001'
const ACME = '00000000-0000-4000-8000-000000000002'
const OTHER = '00000000-0000-4000-8000-000000000003'
const folders = [
  { id: CLIENTS, name: 'Clients', section: 'saved' as const },
  { id: ACME, name: 'Acme', section: 'saved' as const, parentId: CLIENTS },
  { id: OTHER, name: 'Other', section: 'saved' as const }
]

function row(key: string, completedAt?: number): SessionSidebarTreeRow {
  return {
    session: { rowKey: key, sessionKey: key, hostId: 'local', worktreeId: 'w1' } as SidebarSession,
    folderId: null,
    attention: null,
    state: null,
    waitingUntil: null,
    ...(completedAt === undefined ? {} : { completed: { reason: 'finished', at: completedAt } })
  }
}

function group(
  key: string,
  rows: SessionSidebarTreeRow[],
  extra: Partial<SessionSidebarGroup> = {}
): SessionSidebarGroup {
  return {
    key,
    kind: 'folder',
    label: key,
    rows,
    collapsed: false,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false,
    ...extra
  }
}

describe('select all in a group', () => {
  it('opens a saved folder with every folder nested under it, and Saved Sessions with all of them', () => {
    expect(
      sessionGroupSubtreeKeys(
        { key: sessionFolderGroupKey(CLIENTS), kind: 'folder', folder: folders[0] },
        folders
      ).sort()
    ).toEqual([sessionFolderGroupKey(CLIENTS), sessionFolderGroupKey(ACME)].sort())
    expect(
      sessionGroupSubtreeKeys({ key: SAVED_SESSIONS_FOLDER_ID, kind: 'saved' }, folders)
    ).toHaveLength(4)
    expect(sessionGroupSubtreeKeys({ key: 'archived', kind: 'archived' }, folders)).toEqual([
      'archived'
    ])
  })

  it('waits while any folder in the subtree is still folded, then takes all of their rows', () => {
    const subtreeKeys = [sessionFolderGroupKey(CLIENTS), sessionFolderGroupKey(ACME)]
    const folded = [
      group(subtreeKeys[0]!, [row('a')]),
      group(subtreeKeys[1]!, [row('b')], { collapsed: true })
    ]
    const args = { subtreeKeys, mode: 'all' as const, archivedAt: undefined, now: 0 }
    expect(sessionGroupSelectionKeys({ ...args, groups: folded })).toBeNull()
    const open = folded.map((entry) => ({ ...entry, collapsed: false }))
    expect(
      sessionGroupSelectionKeys({ ...args, groups: [...open, group('other', [row('c')])] })
    ).toEqual(['a', 'b'].map((key) => conversationViewKey(row(key).session)))
  })

  it('selects only what was archived more than a week ago, by stamp or else by finish time', () => {
    const now = SESSION_ARCHIVED_OLDER_THAN_MS * 3
    const old = now - SESSION_ARCHIVED_OLDER_THAN_MS - 1
    const key = (id: string): string => conversationViewKey(row(id).session)
    const archived = group(
      'archived',
      [row('stamped-old'), row('stamped-new'), row('legacy', old), row('unknown')],
      { kind: 'archived' }
    )
    expect(
      sessionGroupSelectionKeys({
        groups: [archived],
        subtreeKeys: ['archived'],
        mode: 'archived-older',
        archivedAt: { [key('stamped-old')]: old, [key('stamped-new')]: now - 1 },
        now
      })
    ).toEqual([key('stamped-old'), key('legacy')])
  })
})

describe('a folded group with peek rows', () => {
  it('flattens and selects only the peek rows under its heading', () => {
    const asking = row('asking')
    const folded = group('folder:x', [asking, row('quiet')], {
      collapsed: true,
      peekRows: [asking]
    })
    expect(flattenSessionSidebarGroups([folded]).map((entry) => entry.kind)).toEqual([
      'header',
      'row'
    ])
    expect(visibleSessionSelection([folded]).order).toHaveLength(1)
  })
})

describe('receipts from other computers', () => {
  const fleet = (id: string, source: SidebarSession | null = null) => ({
    run: {
      workflowId: `wf_${id}`,
      rowKey: `row-${id}`,
      sessionKey: source ? null : `remote-${id}`,
      title: id,
      machine: 'mw0002',
      jobs: [],
      admission: 'accepted',
      verified: true,
      error: null
    } as unknown as ConversationFleetView,
    source
  })

  it('selects after the sessions and before the routines, by the key their rows are filed under', () => {
    const local = row('local')
    const open = {
      ...group('completed', [local]),
      fleetRows: [fleet('remote'), fleet('sourced', local.session)],
      routineRows: [{ key: 'routine:host:r1' } as ConversationRoutineRow]
    }
    const visible = visibleSessionSelection([open])
    expect(visible.order).toEqual(['local', 'remote-remote', 'routine:host:r1'])
    expect(visible.fleetByKey.get('remote-remote')?.run.title).toBe('remote')
    expect(
      sessionGroupSelectionKeys({
        groups: [open],
        subtreeKeys: ['completed'],
        mode: 'all',
        archivedAt: undefined,
        now: 0
      })
    ).toEqual(['local', 'remote-remote', 'routine:host:r1'])
  })

  it('waits behind Show all with the rest of a folded group', () => {
    const folded = { ...group('done', [row('a')]), focusRows: [], fleetRows: [fleet('remote')] }
    expect(visibleSessionSelection([folded]).order).toEqual([])
  })

  it('takes only receipts archived over a week ago in the archived-older mode', () => {
    const now = 10 * SESSION_ARCHIVED_OLDER_THAN_MS
    const archived = { ...group('archived', []), fleetRows: [fleet('old'), fleet('new')] }
    expect(
      sessionGroupSelectionKeys({
        groups: [archived],
        subtreeKeys: ['archived'],
        mode: 'archived-older',
        archivedAt: { 'remote-old': now - 2 * SESSION_ARCHIVED_OLDER_THAN_MS, 'remote-new': now },
        now
      })
    ).toEqual(['remote-old'])
  })
})
