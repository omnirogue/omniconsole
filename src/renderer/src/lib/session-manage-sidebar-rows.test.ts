import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { emptyProjectSettings } from '../../../shared/project-settings'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { conversationViewKey } from './conversation-view'
import { readConversationLedgerEligibility } from './session-parity-population'
import { buildSessionManageSidebarRows, matchManagedSession } from './session-manage-sidebar-rows'
import { emptySessionSidebarView } from './session-sidebar-view'
import {
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from './sidebar-session-test-fixtures'
import { buildSidebarSessions, type SidebarSession } from './sidebar-sessions'
import { useRoutineSessionCatalog } from '@/components/sidebar/routines/routine-session-catalog'
import type { Automation } from '../../../shared/automations-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  conversationDigest,
  ledgerBucket,
  ledgerOwner,
  ledgerRecord,
  ledgerSlices,
  pairedSource,
  providerSession
} from './mirrored-conversation-test-fixtures'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const FOLDER = '00000000-0000-4000-8000-00000000000a'

function appState() {
  const source = sessionTestSource()
  const tab = addSessionTestTab(source, 'tab-a')
  addSessionTestRecord(source, tab, 'provider-a')
  const closedTab = addSessionTestTab(source, 'tab-b')
  addSessionTestRecord(source, closedTab, 'provider-b')
  // A closed tab: its row lives on from the sleeping record alone.
  source.tabsByWorktree[SESSION_TEST_WORKTREE] = [tab]
  delete source.terminalLayoutsByTabId['tab-b']
  source.unifiedTabsByWorktree[SESSION_TEST_WORKTREE] = [
    { id: 'u-a', entityId: 'tab-a', contentType: 'terminal', isPinned: true } as never
  ]
  const state = {
    ...source,
    paneForegroundAgentByPaneKey: {
      [makePaneKey('tab-a', SESSION_TEST_LEAF)]: { agent: null, shellForeground: true }
    }
  } as unknown as AppState
  const [open, closed] = buildSidebarSessions(state)
  return { state, openKey: conversationViewKey(open!), closedKey: conversationViewKey(closed!) }
}

beforeEach(() => {
  useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildSessionManageSidebarRows', () => {
  it('addresses a paired mirror by its owner pane and uses the owner archive placement', () => {
    const { state } = appState()
    state.repos[0]!.executionHostId = 'runtime:laptop'
    state.worktreesByRepo['repo-a']![0]!.hostId = 'runtime:laptop'
    const tab = state.tabsByWorktree[SESSION_TEST_WORKTREE]![0]!
    tab.runtimeOwnerTabId = 'owner-tab'
    tab.runtimeOwnerArchiveByLeafId = { [SESSION_TEST_LEAF]: { archived: true, byHand: true } }
    useSessionFolders.setState({
      loaded: true,
      metadata: { version: 1, folders: [], membership: {} }
    })
    const row = buildSessionManageSidebarRows(state, 1_000).find(
      (entry) => entry.tabId === 'tab-a'
    )!
    expect(row.ownerTarget).toEqual({
      tabId: 'owner-tab',
      paneKey: makePaneKey('owner-tab', SESSION_TEST_LEAF)
    })
    expect(row).toMatchObject({
      hostId: 'runtime:laptop',
      archived: true,
      archiveKind: 'manual',
      archivedByHand: true
    })
    useSessionSidebarView.setState({ archived: [row.viewKey] })
    tab.runtimeOwnerArchiveByLeafId = { [SESSION_TEST_LEAF]: { archived: false, byHand: false } }
    const updated = buildSessionManageSidebarRows(state, 1_000).find(
      (entry) => entry.tabId === 'tab-a'
    )!
    expect(updated).toMatchObject({ archived: false, archiveKind: null, archivedByHand: false })
  })

  it('lists each conversation with its folder, archive, pin and resume placement', () => {
    const { state, openKey } = appState()
    useSessionFolders.setState({
      loaded: true,
      metadata: {
        version: 1,
        folders: [{ id: FOLDER, name: 'Ads' }],
        membership: { [openKey]: FOLDER }
      }
    })
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), archived: [openKey] },
      archived: [openKey]
    })
    const rows = buildSessionManageSidebarRows(state, 1_000)
    const open = rows.find((row) => row.tabId === 'tab-a')!
    expect(open).toMatchObject({
      paneKey: makePaneKey('tab-a', SESSION_TEST_LEAF),
      kind: 'terminal',
      worktreeId: SESSION_TEST_WORKTREE,
      hostId: 'local',
      folderId: FOLDER,
      folder: 'Ads',
      saved: false,
      archived: true,
      archivedByHand: true,
      pinned: true,
      resumable: true,
      shellForeground: true,
      workspaceKind: 'git',
      repoId: 'repo-a',
      repoLabel: 'Project A'
    })
    const closed = rows.find((row) => row.tabId === null)!
    expect(closed).toMatchObject({ folder: null, pinned: false, shellForeground: false })
  })

  it('marks the conversation a routine owns, so agents never route other work into it', () => {
    const { state } = appState()
    useRoutineSessionCatalog.setState({
      owners: [
        {
          automation: {
            id: 'routine-1',
            executionTargetType: 'local',
            conversation: { tabId: 'tab-a', paneKey: null }
          } as unknown as Automation,
          sourceTarget: { kind: 'local' }
        }
      ]
    })
    try {
      const rows = buildSessionManageSidebarRows(state, 1_000)
      expect(rows.find((row) => row.tabId === 'tab-a')?.routine).toBe(true)
      expect(rows.find((row) => row.tabId === null)?.routine).toBe(false)
    } finally {
      useRoutineSessionCatalog.setState({ owners: [] })
    }
  })

  it('names the provider conversation and why each row is archived, for the CLI join', () => {
    const { state, openKey, closedKey } = appState()
    useSessionFolders.setState({
      loaded: true,
      metadata: { version: 1, folders: [], membership: {} }
    })
    useSessionSidebarView.setState({
      view: {
        ...emptySessionSidebarView(),
        archived: [openKey, closedKey],
        autoArchiveLog: [{ key: closedKey, proof: 'seal', at: 1 }]
      },
      archived: [openKey, closedKey]
    })
    const rows = buildSessionManageSidebarRows(state, 1_000)
    expect(rows.find((row) => row.tabId === 'tab-a')).toMatchObject({
      providerSessionId: 'provider-a',
      transcriptPath: null,
      archiveKind: 'manual'
    })
    expect(rows.find((row) => row.tabId === null)).toMatchObject({
      providerSessionId: 'provider-b',
      archiveKind: 'automatic'
    })
  })

  it('says which conversations the person brought back from the archive', () => {
    const { state, openKey } = appState()
    useSessionFolders.setState({
      loaded: true,
      metadata: { version: 1, folders: [], membership: {} }
    })
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), autoArchiveKeep: [openKey] },
      archived: []
    })
    const rows = buildSessionManageSidebarRows(state, 1_000)
    expect(rows.find((row) => row.tabId === 'tab-a')?.autoArchiveKeep).toBe(true)
    expect(rows.find((row) => row.tabId === null)?.autoArchiveKeep).toBe(false)
  })

  it('leaves out a conversation the person deleted, unless its tab is open again', () => {
    const { state, openKey, closedKey } = appState()
    useSessionFolders.setState({
      loaded: true,
      metadata: { version: 1, folders: [], membership: {} }
    })
    useSessionSidebarView.setState({
      view: { ...emptySessionSidebarView(), deleted: [openKey, closedKey] },
      archived: []
    })
    const rows = buildSessionManageSidebarRows(state, 1_000)
    expect(rows.map((row) => row.tabId)).toEqual(['tab-a'])
  })

  // Session parity (addendum F2): rows.json keeps where a title came from for the main ledger.
  it('says where each title came from, marking a prompt-named record as agent', () => {
    const { state } = appState()
    useSessionFolders.setState({
      loaded: true,
      metadata: { version: 1, folders: [], membership: {} }
    })
    const closed = state.sleepingAgentSessionsByPaneKey[makePaneKey('tab-b', SESSION_TEST_LEAF)]!
    delete closed.terminalTitle
    const rows = buildSessionManageSidebarRows(state, 1_000)
    expect(rows.find((row) => row.tabId === 'tab-a')).toMatchObject({
      title: 'Session tab-a',
      titleSource: 'terminal'
    })
    expect(rows.find((row) => row.tabId === null)).toMatchObject({
      title: 'Work',
      titleSource: 'agent'
    })
  })

  it("marks a named project's threads, and nothing when no project is named", () => {
    const { state, openKey } = appState()
    useSessionFolders.setState({
      loaded: true,
      metadata: {
        version: 1,
        folders: [{ id: FOLDER, name: 'Ads' }],
        membership: { [openKey]: FOLDER }
      }
    })
    const rows = buildSessionManageSidebarRows(state, 1_000, { projectFolderId: FOLDER })
    expect(rows.find((row) => row.tabId === 'tab-a')?.projectThread).toEqual({
      status: expect.any(String),
      coordinator: false
    })
    expect(rows.find((row) => row.tabId === null)).not.toHaveProperty('projectThread')
    expect(
      buildSessionManageSidebarRows(state, 1_000).some((row) => row.projectThread !== undefined)
    ).toBe(false)
  })

  it("marks the project's recorded coordinator as its chat, though it is filed nowhere", () => {
    const { state, closedKey } = appState()
    useSessionFolders.setState({
      loaded: true,
      metadata: {
        version: 1,
        folders: [{ id: FOLDER, name: 'Ads' }],
        membership: {},
        projects: {
          [FOLDER]: {
            ...emptyProjectSettings(1),
            coordinator: { launch: { agent: 'claude' }, sessionKey: closedKey }
          }
        }
      }
    })
    const rows = buildSessionManageSidebarRows(state, 1_000, { projectFolderId: FOLDER })
    expect(rows.find((row) => row.tabId === null)?.projectThread).toMatchObject({
      coordinator: true
    })
    expect(rows.find((row) => row.tabId === 'tab-a')).not.toHaveProperty('projectThread')
  })
})

describe('matchManagedSession', () => {
  const pane = (tabId: string, leaf: string) =>
    ({ kind: 'terminal', tabId, paneKey: `${tabId}:${leaf}` }) as unknown as SidebarSession
  const sessions = [pane('tab-a', 'leaf-1'), pane('tab-a', 'leaf-2'), pane('tab-b', 'leaf-1')]

  it('finds a named pane exactly and never substitutes a sibling of its tab', () => {
    expect(matchManagedSession(sessions, { paneKey: 'tab-a:leaf-2', tabId: 'tab-a' })).toBe(
      sessions[1]
    )
    // The split a --terminal named closed; tab-a still has leaf-1, which must not be acted on.
    expect(matchManagedSession(sessions, { paneKey: 'tab-a:leaf-3', tabId: 'tab-a' })).toBeNull()
    expect(matchManagedSession(sessions, { paneKey: 'tab-a:leaf-1', tabId: 'tab-b' })).toBeNull()
  })

  it('resolves a bare tab to its own row', () => {
    expect(matchManagedSession(sessions, { tabId: 'tab-b' })).toBe(sessions[2])
    expect(matchManagedSession(sessions, {})).toBeNull()
  })
  it('reaches a row with no pane by its tab only when asked (delete)', () => {
    const tabOnly = { kind: 'terminal', tabId: 'tab-c', paneKey: null } as unknown as SidebarSession
    const all = [...sessions, tabOnly]
    expect(matchManagedSession(all, { tabId: 'tab-c' })).toBeNull()
    expect(matchManagedSession(all, { tabId: 'tab-c' }, { tabOnly: true })).toBe(tabOnly)
    // A tab with a pane still resolves to that pane's row, tabOnly or not.
    expect(matchManagedSession(all, { tabId: 'tab-b' }, { tabOnly: true })).toBe(sessions[2])
  })

  // Why (C6): tidy --apply archives or closes a finished workflow anchor, which has no pane.
  it('finds a pane-less workflow anchor by its controller and run, in archive and delete alike', () => {
    const anchor = {
      kind: 'terminal',
      tabId: 'tab-w',
      paneKey: null,
      workflow: { preset: 'council', status: 'done', runId: 'execution-1' }
    } as unknown as SidebarSession
    const all = [...sessions, anchor]
    const workflow = { controller: 'local' as const, runId: 'execution-1' }
    expect(matchManagedSession(all, { tabId: 'tab-w', workflow })).toBe(anchor)
    expect(matchManagedSession(all, { tabId: 'tab-w', workflow }, { tabOnly: true })).toBe(anchor)
    // Another run in that tab, or another tab, is never taken in its place.
    expect(
      matchManagedSession(all, { tabId: 'tab-w', workflow: { ...workflow, runId: 'execution-2' } })
    ).toBeNull()
    expect(matchManagedSession(all, { tabId: 'tab-a', workflow })).toBeNull()
    // Without the anchor identity, archive still never reaches a pane-less row.
    expect(matchManagedSession(all, { tabId: 'tab-w' })).toBeNull()
  })
})

describe('workflow anchors on management rows', () => {
  function workflowState(
    localWorkflow: NonNullable<TerminalTab['localWorkflow']>,
    extra: Partial<AppState> = {}
  ): AppState {
    const source = sessionTestSource()
    source.tabsByWorktree[SESSION_TEST_WORKTREE] = [
      {
        id: 'tab-w',
        worktreeId: SESSION_TEST_WORKTREE,
        ptyId: null,
        title: 'Which cache?',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 10,
        localWorkflow
      }
    ]
    return {
      ...source,
      localWorkflowStatusByTabId: {},
      localWorkflowHydrationByTabId: {},
      buildReview: { pipelinesById: {}, pipelinesListed: false },
      ...extra
    } as unknown as AppState
  }
  const started = { preset: 'council' as const, prompt: 'Q', executionId: 'execution-1' }

  it.each([
    [
      'a draft',
      { preset: 'council' as const, prompt: '' },
      {},
      { runId: null, status: 'draft' },
      true
    ],
    [
      'a Start in flight',
      {
        preset: 'council' as const,
        prompt: 'Q',
        startRequest: { requestId: 'r', draft: {} as never }
      },
      {},
      { runId: null, status: 'starting' },
      false
    ],
    [
      'a failed read',
      started,
      {
        localWorkflowHydrationByTabId: {
          'tab-w': { runId: 'execution-1', outcome: 'failed', attempts: 3 }
        }
      },
      { runId: 'execution-1', status: 'unavailable' },
      false
    ],
    [
      'a run not found',
      started,
      {
        localWorkflowHydrationByTabId: {
          'tab-w': { runId: 'execution-1', outcome: 'missing', attempts: 1 }
        }
      },
      { runId: 'execution-1', status: 'missing' },
      false
    ],
    [
      'a finished run',
      started,
      {
        localWorkflowStatusByTabId: {
          'tab-w': {
            conversationId: 'tab-w',
            executionId: 'execution-1',
            preset: 'council',
            state: 'completed',
            running: 0,
            completed: 4,
            total: 4
          }
        }
      },
      { runId: 'execution-1', status: 'done' },
      false
    ]
  ] as const)(
    'carries %s with its controller, and launch-pending only for a draft',
    (_label, workflow, extra, anchor, pending) => {
      const rows = buildSessionManageSidebarRows(
        workflowState(workflow, extra as Partial<AppState>),
        1_000
      )
      const row = rows.find((entry) => entry.tabId === 'tab-w')!
      expect(row.paneKey).toBeNull()
      expect(row.workflow).toEqual({ controller: 'local', preset: 'council', ...anchor })
      expect(row.launchPending).toBe(pending)
    }
  )
})

describe('rows a paired owner’s ledger lists (session parity, step 6)', () => {
  const OWNER_ONLY = '00000000-0000-4000-8000-00000000000b'

  function ledgerState(record = ledgerRecord('s1')): AppState {
    const source = pairedSource()
    Object.assign(
      source,
      ledgerSlices(
        [ledgerBucket([record])],
        [ledgerOwner({ folders: [{ id: OWNER_ONLY, name: 'Studio only' }] })]
      )
    )
    return source as unknown as AppState
  }

  beforeEach(() => {
    useSessionFolders.setState({
      loaded: true,
      metadata: { version: 1, folders: [{ id: FOLDER, name: 'Ads' }], membership: {} }
    })
  })

  it("reports an owner-archived, owner-filed record row as archived in the owner's folder", () => {
    const state = ledgerState(
      ledgerRecord('s1', { archived: { archived: true, byHand: true }, folderId: FOLDER })
    )
    const [row] = buildSessionManageSidebarRows(state, 1_000)
    expect(row).toMatchObject({
      hostId: 'runtime:env-studio',
      tabId: null,
      paneKey: null,
      title: 'Owner s1',
      titleSource: 'custom',
      providerSessionId: 's1',
      folderId: FOLDER,
      folder: 'Ads',
      archived: true,
      archivedByHand: true,
      archiveKind: 'manual',
      ownershipUnverified: null,
      // Why: its owner resumes it; this computer never does (C4/F10).
      resumable: false
    })
    expect(row?.recordOnlyMirror).toBeUndefined()
  })

  it("lets the owner's explicit unarchive and unfiling win over stale marks made here (C3)", () => {
    const state = ledgerState(ledgerRecord('s1', { archived: { archived: false }, folderId: null }))
    const [listed] = buildSessionManageSidebarRows(state, 1_000)
    useSessionSidebarView.setState({ archived: [listed!.viewKey] })
    useSessionFolders.setState({
      loaded: true,
      metadata: {
        version: 1,
        folders: [{ id: FOLDER, name: 'Ads' }],
        membership: { [listed!.viewKey]: FOLDER }
      }
    })
    expect(buildSessionManageSidebarRows(state, 1_000)[0]).toMatchObject({
      archived: false,
      archiveKind: null,
      folderId: null,
      folder: null
    })
  })

  it("names an owner folder this computer has not received yet by the owner's name", () => {
    const state = ledgerState(ledgerRecord('s1', { folderId: OWNER_ONLY }))
    expect(buildSessionManageSidebarRows(state, 1_000)[0]).toMatchObject({
      folderId: OWNER_ONLY,
      folder: 'Studio only',
      saved: false
    })
  })

  it('reports each row’s parity bucket under the names sidebar-counts uses (session parity, step 8)', () => {
    const state = ledgerState(ledgerRecord('s1', { listed: true }))
    const stray = makePaneKey('7e0f2a9b-1c3d-4e5f-8a9b-0c1d2e3f4a5b', SESSION_TEST_LEAF)
    state.sleepingAgentSessionsByPaneKey[stray] = {
      paneKey: stray,
      tabId: stray.split(':')[0],
      worktreeId: SESSION_TEST_WORKTREE,
      agent: 'claude',
      providerSession: providerSession('stray'),
      prompt: '',
      state: 'working',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live'
    }
    const rows = buildSessionManageSidebarRows(state, 1_000)
    const listed = rows.find((row) => row.providerSessionId === 's1')
    expect(listed).toMatchObject({
      bucket: 'ownerListed',
      ownerListed: true,
      verification: 'verified',
      identity: `c:${conversationDigest('s1')}`,
      conversation: conversationDigest('s1'),
      rest: 'asleep'
    })
    // This computer's own record the owner never listed: only here, and can't be verified.
    expect(rows.find((row) => row.paneKey === stray)).toMatchObject({
      bucket: 'receiverOnly',
      ownerListed: false,
      verification: 'unverified',
      identity: `c:${conversationDigest('stray')}`,
      bucketReason: 'absence-unverified'
    })
  })

  it("files the owner's own rows by its ledger's eligibility rule (F7)", () => {
    const { state } = appState()
    const rows = buildSessionManageSidebarRows(state, 1_000)
    expect(rows.find((row) => row.tabId === 'tab-a')).toMatchObject({
      bucket: 'ownerListed',
      ownerListed: true,
      verification: 'verified',
      hostId: 'local'
    })
  })

  // Review C1: the rule is consulted, not assumed — a row the selector quarantines reads so here.
  it("quarantines an own row the ledger's rule refuses, through the real selector (F7)", () => {
    const { state } = appState()
    // A record of a paired computer's pane (a web-terminal id) left in this computer's workspace.
    const peerPane = makePaneKey(
      toWebTerminalSurfaceTabId('0b5f2ac1-55aa-4c2e-9d5e-0c1d2e3f4a5b'),
      SESSION_TEST_LEAF
    )
    state.sleepingAgentSessionsByPaneKey = {
      ...state.sleepingAgentSessionsByPaneKey,
      [peerPane]: {
        paneKey: peerPane,
        tabId: peerPane.split(':')[0]!,
        worktreeId: SESSION_TEST_WORKTREE,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'peer-record' },
        prompt: '',
        state: 'working',
        capturedAt: 100,
        updatedAt: 100,
        origin: 'live'
      }
    }
    const eligibility = readConversationLedgerEligibility(state)
    expect(eligibility).not.toBeNull()
    const rows = buildSessionManageSidebarRows(state, 1_000)
    const peer = rows.find((row) => row.paneKey === peerPane)!
    expect(eligibility!.quarantined.get(peer.rowKey)).toBe('peer-provenance')
    expect(peer).toMatchObject({
      bucket: 'receiverOnly',
      ownerListed: false,
      verification: 'unverified',
      bucketReason: 'peer-provenance'
    })
    expect(rows.find((row) => row.tabId === 'tab-a')?.bucket).toBe('ownerListed')
  })

  it("never offers this computer's record of a paired owner's pane as resumable here", () => {
    const state = ledgerState()
    const paneKey = makePaneKey('4c3e6035-ce3a-41cd-a874-7d9d1341abb2', SESSION_TEST_LEAF)
    state.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: paneKey.split(':')[0],
      worktreeId: SESSION_TEST_WORKTREE,
      agent: 'claude',
      providerSession: providerSession('other'),
      prompt: '',
      state: 'working',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live'
    }
    const capture = buildSessionManageSidebarRows(state, 1_000).find(
      (row) => row.paneKey === paneKey
    )
    expect(capture).toMatchObject({ resumable: false, ownershipUnverified: 'absence-unverified' })
  })
})
