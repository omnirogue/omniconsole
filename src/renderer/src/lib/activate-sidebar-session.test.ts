import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sessionTestSource,
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_WORKTREE,
  SESSION_TEST_LEAF
} from './sidebar-session-test-fixtures'
import { buildSidebarSessions, type SidebarSession } from './sidebar-sessions'
import type * as SidebarSessionsModule from './sidebar-sessions'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { sessionConversationPaneIdentity } from '../../../shared/session-conversation-ledger'
import { mirroredConversationRowKey } from './mirrored-conversation-rows'
import type { MirroredSidebarConversation } from './mirrored-conversation-row-types'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  activate: vi.fn(),
  focus: vi.fn(),
  structured: vi.fn(),
  gate: vi.fn(),
  toast: vi.fn(),
  /** Rows the sidebar builds, when a test supplies them (ledger rows come from step 6's builder). */
  rows: null as SidebarSession[] | null
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('./sidebar-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof SidebarSessionsModule>()
  return {
    ...actual,
    buildSidebarSessions: (...args: Parameters<typeof actual.buildSidebarSessions>) =>
      mocks.rows ?? actual.buildSidebarSessions(...args)
  }
})
vi.mock('./worktree-activation', () => ({ activateAndRevealWorkspace: mocks.activate }))
vi.mock('./activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: mocks.focus }))
vi.mock('./structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: mocks.structured
}))
vi.mock('./worktree-agent-activation-gate', () => ({ gateWorktreeAgentActivation: mocks.gate }))
import { activateSidebarSession } from './activate-sidebar-session'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.rows = null
  mocks.activate.mockReturnValue({ primaryTabId: null })
})

describe('session sidebar navigation', () => {
  it('delegates folder-workspace navigation and pane focus to the existing services', async () => {
    const source = sessionTestSource()
    source.folderWorkspaces = [
      {
        id: 'notes',
        name: 'Notes',
        executionHostId: 'local'
      } as FolderWorkspace
    ]
    const tab = addSessionTestTab(source, 'tab-notes', 'folder:notes')
    addSessionTestRecord(source, tab)
    mocks.state = source
    expect(await activateSidebarSession(buildSidebarSessions(source)[0])).toEqual({
      handled: 'opened'
    })
    expect(mocks.activate).toHaveBeenCalledWith('folder:notes', {
      executionHostId: 'local',
      providesInitialSurface: true
    })
    expect(mocks.focus).toHaveBeenCalledWith('tab-notes', SESSION_TEST_LEAF, expect.any(Object))
    expect(mocks.gate).not.toHaveBeenCalled()
  })

  it('does not activate stale rows or unreachable hosts', async () => {
    const source = sessionTestSource()
    const tab = addSessionTestTab(source)
    const record = addSessionTestRecord(source, tab)
    const row = buildSidebarSessions(source)[0]
    mocks.state = source
    record.providerSession.id = 'replacement'
    expect(await activateSidebarSession(row)).toBe(false)
    source.worktreesByRepo['repo-a'][0].hostId = 'ssh:offline'
    expect(await activateSidebarSession(buildSidebarSessions(source)[0])).toBe(false)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.focus).not.toHaveBeenCalled()
  })

  it('focuses the same provider session after the existing resume gate creates a new tab', async () => {
    const source = sessionTestSource()
    const oldTab = addSessionTestTab(source)
    const record = addSessionTestRecord(source, oldTab)
    source.tabsByWorktree = {}
    mocks.state = { ...source, activeWorktreeId: SESSION_TEST_WORKTREE, activeView: 'terminal' }
    mocks.gate.mockImplementation(async () => {
      const newTab = addSessionTestTab(source, 'resumed')
      addSessionTestRecord(source, newTab, record.providerSession.id)
      delete source.sleepingAgentSessionsByPaneKey[record.paneKey]
    })
    expect(await activateSidebarSession(buildSidebarSessions(source)[0])).toEqual({
      handled: 'opened'
    })
    expect(mocks.focus).toHaveBeenCalledWith('resumed', SESSION_TEST_LEAF, expect.any(Object))
  })

  it('does not steal focus after the user selects another session during resume', async () => {
    const source = sessionTestSource()
    const sleepingTab = addSessionTestTab(source, 'sleeping')
    addSessionTestRecord(source, sleepingTab, 'sleeping-provider')
    source.tabsByWorktree = {}
    const active = addSessionTestTab(source, 'active')
    addSessionTestRecord(source, active, 'active-provider')
    mocks.state = { ...source, activeWorktreeId: SESSION_TEST_WORKTREE, activeView: 'terminal' }
    let release: () => void = () => {}
    mocks.gate.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const rows = buildSidebarSessions(source)
    const pending = activateSidebarSession(rows.find((row) => row.tabId === null)!)
    expect(await activateSidebarSession(rows.find((row) => row.tabId === 'active')!)).toEqual({
      handled: 'opened'
    })
    release()
    expect(await pending).toBe(false)
    expect(mocks.focus).toHaveBeenCalledOnce()
    expect(mocks.focus).toHaveBeenCalledWith('active', SESSION_TEST_LEAF, expect.any(Object))
  })
})

// Session parity, step 7 (OS#1): a conversation a paired owner's ledger lists runs there. A click on
// its row never reaches the resume sweep or the activation gate, and never opens a tab here.
describe('a row the paired owner’s conversation ledger lists', () => {
  const STUDIO = '1d045bce-9849-4ceb-94b6-3e36aeca3513'
  const WT = 'paired-repo::/Users/maintainer/Work'
  const LEAF = 'cf50cc26-0360-45ed-9a19-3f94e3d56068'
  const OWNER_TAB = '9526cd53-8dc2-43b3-9ee2-4054a8a372fb'
  const OWNER_PANE_KEY = `${OWNER_TAB}:${LEAF}`
  const MIRROR_TAB = toWebTerminalSurfaceTabId(OWNER_TAB)
  const DIGEST = '0123456789abcdef01234567'

  // Why step 6's key builder: the row key carries the tagged identity (`c:`/`p:`, F21) while
  // `mirroredConversation.conversation` stays the bare digest (null without a provider session).
  function ledgerRow(
    rest: 'live' | 'dormant' | 'asleep' | 'unknown',
    overrides: Partial<SidebarSession> = {},
    identity: Pick<MirroredSidebarConversation, 'conversation' | 'paneIdentity'> = {
      conversation: DIGEST
    }
  ): SidebarSession {
    const mirroredConversation: MirroredSidebarConversation = {
      environmentId: STUDIO,
      ...identity,
      ownerPaneKey: OWNER_PANE_KEY,
      ownerTabId: OWNER_TAB,
      rest,
      listed: true,
      stale: false,
      ownerState: 'ready'
    }
    const key = mirroredConversationRowKey(STUDIO, WT, mirroredConversation)
    return {
      rowKey: key,
      sessionKey: key,
      worktreeId: WT,
      hostId: `runtime:${STUDIO}`,
      tabId: null,
      paneKey: null,
      kind: 'terminal',
      label: 'Owner title',
      workspaceLabel: 'Work',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'owner-session' },
      unavailable: false,
      folderKeyMigration: null,
      mirroredConversation,
      ...overrides
    }
  }

  beforeEach(() => {
    mocks.state = { runtimeEnvironments: [{ id: STUDIO, name: 'Mac Studio' }] }
  })

  it('says where to resume a paused record row: no sweep, no gate, no tab', async () => {
    const row = ledgerRow('asleep')
    mocks.rows = [row]

    expect(await activateSidebarSession(row)).toEqual({ handled: 'explained' })
    expect(mocks.toast).toHaveBeenCalledWith('Resume it on Mac Studio.')
    // Why these: activation is what ran the C4 sweep; the gate resumes; createTab is on no store.
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.gate).not.toHaveBeenCalled()
    expect(mocks.focus).not.toHaveBeenCalled()
  })

  it('says where to open any other record row', async () => {
    for (const row of [
      ledgerRow('dormant'),
      ledgerRow(
        'asleep',
        { providerSession: undefined },
        { conversation: null, paneIdentity: sessionConversationPaneIdentity(OWNER_PANE_KEY) }
      )
    ]) {
      mocks.toast.mockClear()
      mocks.rows = [row]
      expect(await activateSidebarSession(row)).toEqual({ handled: 'explained' })
      expect(mocks.toast).toHaveBeenCalledWith('Open it on Mac Studio.')
    }
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.gate).not.toHaveBeenCalled()
  })

  it('still opens a joined dormant mirror tab, where its Resume banner lives (F13)', async () => {
    const paneKey = makePaneKey(MIRROR_TAB, LEAF)
    const row = ledgerRow('asleep', { tabId: MIRROR_TAB, paneKey })
    mocks.rows = [row]

    expect(await activateSidebarSession(row)).toEqual({ handled: 'opened' })
    expect(mocks.activate).toHaveBeenCalledWith(WT, {
      executionHostId: `runtime:${STUDIO}`,
      providesInitialSurface: true
    })
    expect(mocks.focus).toHaveBeenCalledWith(MIRROR_TAB, LEAF, expect.any(Object))
    expect(mocks.gate).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('never falls back to the gate when the mirror tab went away meanwhile', async () => {
    const joined = ledgerRow('asleep', {
      tabId: MIRROR_TAB,
      paneKey: makePaneKey(MIRROR_TAB, LEAF)
    })
    mocks.rows = [joined]
    mocks.activate.mockImplementation(() => {
      mocks.rows = [ledgerRow('asleep', { rowKey: joined.rowKey })]
      return { primaryTabId: null }
    })

    expect(await activateSidebarSession(joined)).toEqual({ handled: 'explained' })
    expect(mocks.gate).not.toHaveBeenCalled()
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledWith('Resume it on Mac Studio.')
  })
})
