// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionFolderMetadata, SAVED_SESSIONS_FOLDER_ID } from '@/lib/session-folders'
import { sessionLensGroupKey } from '@/lib/session-sidebar-lens'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SessionSidebarGroup as GroupModel } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { MirroredSidebarConversation } from '@/lib/mirrored-conversation-row-types'
import { mirroredConversationRowKey } from '@/lib/mirrored-conversation-rows'
import type * as PersonChanges from '@/lib/session-organization-person-changes'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/runtime-environments'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/terminal-surface-id'
import { SessionSidebarGroup } from './SessionSidebarGroup'

const mocks = vi.hoisted(() => ({
  archive: vi.fn(async (_keys: readonly string[], _archived: boolean) => true),
  open: vi.fn()
}))
vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))
vi.mock('@/components/next-action/up-next-composer-flag', () => ({
  UP_NEXT_COMPOSER_ENABLED: true
}))
vi.mock('@/components/next-action/UpNextSubject', () => ({ UpNextSubject: () => null }))
vi.mock('@/lib/open-sidebar-session', () => ({ openSidebarSession: mocks.open }))
vi.mock('@/lib/session-organization-person-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof PersonChanges>()),
  archiveSessionsByPerson: mocks.archive
}))

const ENV = 'env-studio'
const STUDIO = `runtime:${ENV}` as const
const WT = 'repo:/workspace'
const LEAF = 'cf50cc26-0360-45ed-9a19-3f94e3d56068'
const OPEN_ON = 'Open it on Mac Studio.'
const initialState = useAppStore.getInitialState()

function mirrored(
  conversation: string,
  rest: MirroredSidebarConversation['rest']
): MirroredSidebarConversation {
  return {
    environmentId: ENV,
    conversation,
    ownerPaneKey: null,
    ownerTabId: null,
    rest,
    listed: true,
    stale: false,
    ownerState: 'ready'
  }
}

function row(overrides: Partial<SidebarSession>): SidebarSession {
  return {
    rowKey: 'row',
    sessionKey: 'row',
    worktreeId: WT,
    hostId: STUDIO,
    tabId: null,
    paneKey: null,
    kind: 'terminal',
    label: 'Owner conversation',
    workspaceLabel: 'Website',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

/** A row the ledger created: tab- and pane-less, or on a pending-handle mirror tab (step 6). */
function ledgerRow(rest: MirroredSidebarConversation['rest'], ownerTab?: string): SidebarSession {
  const conversation = ownerTab ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : '0123456789abcdef01234567'
  const key = mirroredConversationRowKey(ENV, WT, { conversation })
  const tabId = ownerTab ? toWebTerminalSurfaceTabId(ownerTab) : null
  return row({
    rowKey: key,
    sessionKey: key,
    tabId,
    paneKey: tabId ? makePaneKey(tabId, LEAF) : null,
    label: ownerTab ? 'Owner dormant tab' : 'Owner record',
    mirroredConversation: mirrored(conversation, rest)
  })
}

/** A live mirror row this window built, which the ledger joined: it keeps its frame key (F14). */
function joinedRow(rest: MirroredSidebarConversation['rest']): SidebarSession {
  const tabId = toWebTerminalSurfaceTabId('9526cd53-8dc2-43b3-9ee2-4054a8a372fb')
  const paneKey = makePaneKey(tabId, LEAF)
  const key = JSON.stringify([STUDIO, 'pane', WT, paneKey])
  return row({
    rowKey: key,
    sessionKey: key,
    tabId,
    paneKey,
    label: 'Owner live tab',
    mirroredConversation: mirrored('fedcba9876543210fedcba98', rest)
  })
}

function renderRow(session: SidebarSession, archived = false): void {
  const group: GroupModel = {
    key: sessionLensGroupKey('computer', STUDIO),
    kind: 'computer',
    label: 'Mac Studio',
    rows: [{ session, folderId: null, attention: null, state: null, waitingUntil: null, archived }],
    collapsed: false,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false
  }
  render(
    <TooltipProvider>
      <SessionSidebarGroup
        group={group}
        folders={[]}
        activeTabId={null}
        activeWorktreeId={null}
        queuedRowKeys={new Set<string>()}
        onToggle={vi.fn()}
        onHide={vi.fn()}
        onMoveGroup={vi.fn()}
        onRenameFolder={vi.fn()}
        onDeleteFolder={vi.fn()}
        onOpen={vi.fn()}
        onMoveSessionKey={vi.fn()}
        onCancelQueue={vi.fn()}
        onRename={vi.fn()}
        onSelect={() => false}
      />
    </TooltipProvider>
  )
}

const rowElement = () => document.querySelector<HTMLElement>('[data-session-row]')!
const checkbox = (label: string) =>
  screen.getByRole('checkbox', { name: `Select ${label}` }) as HTMLButtonElement
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
const menuItem = (name: string) => screen.getByRole('menuitem', { name }) as HTMLButtonElement
const openMenu = () => fireEvent.click(button('More options'))

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState(initialState, true)
  useAppStore.setState({
    runtimeEnvironments: [{ id: ENV, name: 'Mac Studio' } as PublicKnownRuntimeEnvironment]
  })
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('a row the owner’s ledger created keeps only Show/Open here (E1)', () => {
  it('turns off archive, selection, drag and rename on a record row, saying where it runs', () => {
    renderRow(ledgerRow('asleep'))
    const archive = button('Archive Owner record')
    expect(archive.disabled).toBe(true)
    expect(archive.title).toBe(OPEN_ON)
    expect(checkbox('Owner record').disabled).toBe(true)
    expect(checkbox('Owner record').title).toBe(OPEN_ON)
    expect(rowElement().getAttribute('draggable')).toBeNull()
    expect(button(/^Open session Owner record/).getAttribute('aria-keyshortcuts')).toBeNull()
    openMenu()
    // Why disabled, not run: its owner resumes it (the row click still says "Resume it on …").
    expect(menuItem('Resume session').disabled).toBe(true)
    expect(menuItem('Resume session').title).toBe(OPEN_ON)
    fireEvent.click(menuItem('Resume session'))
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('also turns off rename, close and up next on a row placed on a pending-handle mirror tab', () => {
    renderRow(ledgerRow('asleep', '0b5f2ac1-55aa-4c2e-9d5e-0c1d2e3f4a5b'))
    expect(button(/^Open session Owner dormant tab/).getAttribute('aria-keyshortcuts')).toBeNull()
    expect(rowElement().getAttribute('draggable')).toBeNull()
    openMenu()
    for (const name of ['Close conversation', 'Resume session', 'Up next']) {
      expect(menuItem(name).disabled).toBe(true)
      expect(menuItem(name).title).toBe(OPEN_ON)
    }
  })

  it('turns off Delete under Archived', () => {
    renderRow(ledgerRow('dormant'), true)
    const remove = button('Delete Owner record')
    expect(remove.disabled).toBe(true)
    expect(remove.title).toBe(OPEN_ON)
  })
})

describe('a live mirror row the ledger joined keeps every action it had (F13)', () => {
  it('keeps the owner-routed archive, selection, drag, rename, close and up next', () => {
    const joined = joinedRow('live')
    renderRow(joined)
    const archive = button('Archive Owner live tab')
    expect(archive.disabled).toBe(false)
    fireEvent.click(archive)
    expect(mocks.archive).toHaveBeenCalledWith([joined.sessionKey], true)
    expect(checkbox('Owner live tab').disabled).toBe(false)
    expect(rowElement().getAttribute('draggable')).toBe('true')
    expect(button(/^Open session Owner live tab/).getAttribute('aria-keyshortcuts')).toBe('F2')
    openMenu()
    for (const name of ['Close conversation', 'Up next']) {
      expect(menuItem(name).disabled).toBe(false)
      expect(menuItem(name).title).toBe('')
    }
  })

  it('keeps Resume on a paused joined tab, which opens the tab where its Resume banner is', () => {
    const joined = joinedRow('asleep')
    renderRow(joined)
    openMenu()
    expect(menuItem('Resume session').disabled).toBe(false)
    fireEvent.click(menuItem('Resume session'))
    expect(mocks.open).toHaveBeenCalledWith(joined)
  })

  it('keeps Delete under Archived (step 7 answers it with "Delete it on <Computer>")', () => {
    renderRow(joinedRow('dormant'), true)
    expect(button('Delete Owner live tab').disabled).toBe(false)
  })
})

// E1 for filing (1b): the owner's explicit folder places the row (sessionRowFolderId), so a move
// made here could never show; drag and unfile are off until Phase 2b routes moves to the owner.
describe('a joined row its owner places is not dragged or unfiled here', () => {
  function placedRow(): SidebarSession {
    const joined = joinedRow('live')
    return {
      ...joined,
      mirroredConversation: { ...joined.mirroredConversation!, folderIdByOwner: null }
    }
  }

  it('turns off drag and "Remove from Saved Sessions", keeping archive and selection', () => {
    const placed = placedRow()
    useSessionFolders.setState((state) => ({
      metadata: {
        ...state.metadata,
        membership: { [placed.sessionKey!]: SAVED_SESSIONS_FOLDER_ID }
      }
    }))
    renderRow(placed)
    expect(rowElement().getAttribute('draggable')).toBeNull()
    expect(button('Archive Owner live tab').disabled).toBe(false)
    expect(checkbox('Owner live tab').disabled).toBe(false)
    openMenu()
    const unfile = menuItem('Remove from Saved Sessions')
    expect(unfile.disabled).toBe(true)
    expect(unfile.title).toBe(OPEN_ON)
  })

  it('still drags a joined row whose owner did not say where it is filed', () => {
    renderRow(joinedRow('live'))
    expect(rowElement().getAttribute('draggable')).toBe('true')
  })
})
