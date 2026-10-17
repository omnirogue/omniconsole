// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { MirroredSidebarConversation } from '@/lib/mirrored-conversation-row-types'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { GroupPutAwayItem, groupPutAwayFolderRows } from './GroupPutAwayItem'
import type { SidebarCleanupGroup } from './sidebar-cleanup-rows'

const mocks = vi.hoisted(() => ({
  deleteSessions: vi.fn(async (_sessions: readonly unknown[], _extra?: unknown) => true)
}))
vi.mock('./session-delete', () => ({ useDeleteSidebarSessions: () => mocks.deleteSessions }))
vi.mock('./use-sidebar-sessions', () => ({ useSidebarSessions: () => [] }))

const MIRRORED: MirroredSidebarConversation = {
  environmentId: 'env-studio',
  conversation: '0123456789abcdef01234567',
  ownerPaneKey: null,
  ownerTabId: null,
  rest: 'dormant',
  listed: true,
  stale: false,
  ownerState: 'ready'
}
const LEDGER_KEY = JSON.stringify(['runtime:env-studio', 'ledger', 'repo:/w', 'c:0123'])

function row(id: string, overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: `row-${id}`,
    sessionKey: `session-${id}`,
    worktreeId: 'repo:/w',
    hostId: 'local',
    tabId: null,
    paneKey: null,
    kind: 'terminal',
    label: `Conversation ${id}`,
    workspaceLabel: 'Website',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

const ledgerOnly = row('l', {
  rowKey: LEDGER_KEY,
  sessionKey: LEDGER_KEY,
  hostId: 'runtime:env-studio',
  mirroredConversation: MIRRORED
})
const joined = row('j', { hostId: 'runtime:env-studio', mirroredConversation: MIRRORED })

function archivedGroup(sessions: SidebarSession[]): SidebarCleanupGroup {
  return {
    key: 'archived',
    kind: 'archived',
    label: 'Archived',
    rows: sessions.map((session) => ({
      session,
      folderId: null,
      attention: null,
      state: null,
      waitingUntil: null,
      archived: true
    })),
    collapsed: false,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionSidebarView.setState({ view: emptySessionSidebarView(), archived: [], loaded: true })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
})

afterEach(cleanup)

// E1/F13 (session parity, Phase 1b): a row a paired owner's ledger created is deleted on its owner,
// so emptying Archived leaves it; a mirror row the ledger joined goes to the delete as before (step
// 7's guard then answers "Delete it on <Computer>").
describe('putting a group away with rows a paired owner’s ledger created', () => {
  it('neither counts nor deletes a ledger-only row; a joined mirror row goes as before', () => {
    render(
      <GroupPutAwayItem group={archivedGroup([row('a'), ledgerOnly, joined])} folders={[]} inline />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Empty archive' }))
    expect(mocks.deleteSessions).toHaveBeenCalledOnce()
    expect(mocks.deleteSessions.mock.calls[0]![0]).toEqual([row('a'), joined])
  })

  it('offers nothing when the group holds only ledger-only rows', () => {
    render(<GroupPutAwayItem group={archivedGroup([ledgerOnly])} folders={[]} inline />)
    expect(screen.queryByRole('button', { name: 'Empty archive' })).toBeNull()
  })
})

// A folder's "Archive all" selects by the placement the tree shows (C3): a paired owner's explicit
// folder places its row, so a stale local membership neither counts nor archives it on its owner.
describe('which rows a folder’s put-away selects', () => {
  const A = '00000000-0000-4000-8000-00000000000a'
  const B = '00000000-0000-4000-8000-00000000000b'
  const metadata = {
    ...emptySessionFolderMetadata(),
    folders: [
      { id: A, name: 'A' },
      { id: B, name: 'B' }
    ],
    membership: { 'session-l': A, 'session-o': A, 'session-u': A }
  }
  const local = row('l')
  // Filed in A here, but the owner files it in B: the tree shows it in B.
  const ownerFiled = row('o', {
    hostId: 'runtime:env-studio',
    mirroredConversation: { ...MIRRORED, folderIdByOwner: B }
  })
  // Filed in A here, explicitly unfiled on its owner: the tree shows it under Active.
  const ownerUnfiled = row('u', {
    hostId: 'runtime:env-studio',
    mirroredConversation: { ...MIRRORED, folderIdByOwner: null }
  })
  // Nothing filed here, but the owner files it in A: the tree shows it in A.
  const ownerInA = row('a', {
    hostId: 'runtime:env-studio',
    mirroredConversation: { ...MIRRORED, folderIdByOwner: A }
  })
  const all = [local, ownerFiled, ownerUnfiled, ownerInA]

  it('takes the rows the tree shows in the folder, not the ones only a local membership names', () => {
    expect(groupPutAwayFolderRows(all, metadata, new Set([A]), new Set())).toEqual([
      local,
      ownerInA
    ])
    expect(groupPutAwayFolderRows(all, metadata, new Set([B]), new Set())).toEqual([ownerFiled])
  })

  it('leaves out a deleted tab-less row and a ledger-only row', () => {
    const deleted = new Set(['session-l'])
    expect(groupPutAwayFolderRows([local, ledgerOnly], metadata, new Set([A]), deleted)).toEqual([])
  })
})
