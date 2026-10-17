import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { Worktree } from '../../../shared/worktree/types'
import {
  markHostSessionMirrorWorktreeHydrated,
  resetHostSessionMirrorHydrationForTests
} from '@/runtime/host-session-mirror-hydration'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'
import { getSessionOwnershipUnverifiedReason } from './session-ownership-verdict'
import { emptySessionSidebarView } from './session-sidebar-view'
import {
  addSessionTestRecord,
  addSessionTestTab,
  SESSION_TEST_LEAF,
  sessionTestSource
} from './sidebar-session-test-fixtures'
import { buildSidebarSessions, type SidebarSessionSource } from './sidebar-sessions'
import { isRecordOnlyMirrorRow, recordOnlyMirrorRowFlags } from './mirror-row-owner-evidence'
import { sessionConversationIdentity } from '../../../shared/session-conversation-ledger'
import {
  ledgerBucket,
  ledgerOwner,
  ledgerRecord,
  ledgerSlices
} from './mirrored-conversation-test-fixtures'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

// Live shapes (6 Oct): the MacBook's worktree on the Studio, and a deleted one nobody lists.
const MACBOOK = '93513683-3ff0-4499-bd79-3c03122c7365'
const REPO = 'c1438ef4-1bb1-4b73-a5f2-cf72b9924c5f'
const MB_WT = `${REPO}::/Users/maintainer/omni-ide-worktrees/omni-ide/rel-review-1004`
const GONE_WT =
  '6bd8d6fa-78dc-452c-b6e3-b8b00d1ab4f9::/Users/maintainer/omnirogue-worktrees/review-1411-1412-opus'

function macbookSource(): SidebarSessionSource {
  const source = sessionTestSource()
  source.repos = [{ id: REPO, executionHostId: `runtime:${MACBOOK}` } as unknown as Repo]
  source.worktreesByRepo = {
    [REPO]: [{ id: MB_WT, repoId: REPO, hostId: `runtime:${MACBOOK}` } as unknown as Worktree]
  }
  return source
}

function addMirrorRecord(
  source: SidebarSessionSource,
  hostTabId: string,
  worktreeId: string
): string {
  const tabId = toWebTerminalSurfaceTabId(hostTabId)
  const paneKey = makePaneKey(tabId, SESSION_TEST_LEAF)
  source.sleepingAgentSessionsByPaneKey[paneKey] = {
    paneKey,
    tabId,
    worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${hostTabId}` },
    prompt: '',
    terminalTitle: 'worker-task_711b442636b5',
    state: 'working',
    capturedAt: 100,
    updatedAt: 100,
    connectionId: null,
    origin: 'live'
  }
  return paneKey
}

function rowFor(source: SidebarSessionSource, paneKey: string) {
  return buildSidebarSessions(source).find((session) => session.paneKey === paneKey)!
}

describe("mirror rows the owner does not vouch for are labelled can't verify (A4)", () => {
  beforeEach(() => {
    useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
    resetHostSessionMirrorHydrationForTests()
  })
  afterEach(() => {
    resetHostSessionMirrorHydrationForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  it('labels a record-only row of another computer’s pane, never a local record-only row', () => {
    const source = macbookSource()
    const mirror = addMirrorRecord(source, '9526cd53-8dc2-43b3-9ee2-4054a8a372fb', MB_WT)
    const local = addSessionTestTab(sessionTestSource(), 'local-tab')
    addSessionTestRecord(source, local)

    const mirrorRow = rowFor(source, mirror)
    expect(mirrorRow.tabId).toBeNull()
    expect(getSessionOwnershipUnverifiedReason(source, mirrorRow)).toBe('absence-unverified')
    const localRow = buildSidebarSessions(source).find(
      (session) => session.tabId === null && session.paneKey !== mirror
    )
    expect(getSessionOwnershipUnverifiedReason(source, localRow!)).toBeNull()
  })

  it('labels a listed shell whose only conversation evidence is this computer’s, once the owner answered', () => {
    const source = macbookSource()
    const tab = addSessionTestTab(source, toWebTerminalSurfaceTabId('84583445-shell'), MB_WT)
    tab.ptyId = `remote:${MACBOOK}@@term_13efc6a4`
    tab.launchAgent = undefined
    const record = addSessionTestRecord(source, tab)
    const session = rowFor(source, record.paneKey)

    // Before the owner answers, a restored row is simply waiting.
    expect(getSessionOwnershipUnverifiedReason(source, session)).toBeNull()
    markHostSessionMirrorWorktreeHydrated(MACBOOK, MB_WT)
    expect(getSessionOwnershipUnverifiedReason(source, session)).toBe('absence-unverified')

    // The owner's own evidence (a live agent status, or the tab's launch agent) clears it.
    source.agentStatusByPaneKey[record.paneKey] = {
      paneKey: record.paneKey,
      state: 'done'
    } as AppState['agentStatusByPaneKey'][string]
    expect(getSessionOwnershipUnverifiedReason(source, session)).toBeNull()
    delete source.agentStatusByPaneKey[record.paneKey]
    tab.launchAgent = 'codex'
    expect(getSessionOwnershipUnverifiedReason(source, session)).toBeNull()
  })

  it('flags only a record nobody can speak for as stranded, so only tidy --unverified offers it', () => {
    const source = macbookSource()
    const gone = addMirrorRecord(source, 'b8fa480c-cd79-4cb2-a1a5-6fcb1945ae70', GONE_WT)
    const owned = addMirrorRecord(source, '9526cd53-8dc2-43b3-9ee2-4054a8a372fb', MB_WT)

    const rows = buildSessionManageSidebarRows(source as unknown as AppState, 1_000)
    expect(rows.find((row) => row.paneKey === gone)).toMatchObject({
      hostId: null,
      ownershipUnverified: 'absence-unverified',
      strandedMirrorRecord: true
    })
    // The MacBook's own record-only row has a host that can retire it: not stranded.
    const ownedRow = rows.find((row) => row.paneKey === owned)
    expect(ownedRow?.ownershipUnverified).toBe('absence-unverified')
    expect(ownedRow?.strandedMirrorRecord).toBeUndefined()
    // Both are record-only, so `omni session delete --unverified` may drop either record here.
    expect(ownedRow?.recordOnlyMirror).toBe(true)
    expect(rows.find((row) => row.paneKey === gone)?.recordOnlyMirror).toBe(true)
  })
})

// evidence/sidebar-counts-macbook-0725.json: one of the MacBook's 10 record rows under the Studio's
// runtime, re-keyed onto a plain-UUID tab by a resume sweep (C4), listed with no "can't verify".
const STUDIO = '550d5f62-153f-4a6f-ae56-8aba4fc6dd42'
const STUDIO_REPO = '323b2cb4-9c16-42db-9870-0f878a953a69'
const ADS_WT = `${STUDIO_REPO}::/Users/maintainer/Work/Shared/Advertising`
const C4_PANE = '4c3e6035-ce3a-41cd-a874-7d9d1341abb2:0d3bfdb5-fb72-4fa7-8335-4099f5857ebb'
const C4_SESSION = { key: 'session_id' as const, id: '5113024f-d028-4cb8-89f5-58f76373fc39' }

function studioSource(hostId = `runtime:${STUDIO}`): SidebarSessionSource {
  const source = sessionTestSource()
  source.repos = [{ id: STUDIO_REPO, executionHostId: hostId } as unknown as Repo]
  source.worktreesByRepo = {
    [STUDIO_REPO]: [{ id: ADS_WT, repoId: STUDIO_REPO, hostId } as unknown as Worktree]
  }
  source.sleepingAgentSessionsByPaneKey[C4_PANE] = {
    paneKey: C4_PANE,
    tabId: C4_PANE.split(':')[0],
    worktreeId: ADS_WT,
    agent: 'claude',
    providerSession: C4_SESSION,
    prompt: '',
    terminalTitle: '◐ Advertising check OmniRogue and BetaCorp',
    // Why not done: passive completed evidence lists no row; these ten were listed.
    state: 'working',
    capturedAt: 100,
    updatedAt: 100,
    connectionId: null,
    origin: 'live'
  }
  return source
}

describe('record-only mirror rows by execution owner (session parity, step 6, C4)', () => {
  beforeEach(() => {
    useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
  })

  it("labels the C4 plain-UUID record under the Studio's runtime, as it does a web-terminal record", () => {
    const source = studioSource()
    const row = rowFor(source, C4_PANE)
    expect(row).toMatchObject({ hostId: `runtime:${STUDIO}`, tabId: null })
    expect(isRecordOnlyMirrorRow(row)).toBe(true)
    expect(getSessionOwnershipUnverifiedReason(source, row)).toBe('absence-unverified')
    expect(recordOnlyMirrorRowFlags(source, row)).toEqual({ recordOnlyMirror: true })
    const web = addMirrorRecord(source, '9526cd53-8dc2-43b3-9ee2-4054a8a372fb', ADS_WT)
    expect(isRecordOnlyMirrorRow(rowFor(source, web))).toBe(true)
  })

  it('never labels a local or direct-SSH record, whatever its pane id', () => {
    for (const hostId of ['local', 'ssh:box']) {
      const source = studioSource(hostId)
      const row = rowFor(source, C4_PANE)
      expect(row.hostId).toBe(hostId)
      expect(isRecordOnlyMirrorRow(row)).toBe(false)
      expect(getSessionOwnershipUnverifiedReason(source, row)).toBeNull()
      expect(recordOnlyMirrorRowFlags(source, row)).toEqual({})
    }
  })

  // Steps 6 + 7 together: what main's `omni session delete --unverified` reads off the relay row.
  it('hands main the C4 capture as record-only, and a vouched one as its owner’s, for --unverified', () => {
    const source = studioSource()
    const manageRows = () => buildSessionManageSidebarRows(source as unknown as AppState, 1_000)
    const capture = () => manageRows().find((row) => row.paneKey === C4_PANE)
    // No ledger: only this computer's record, which the person may drop with --unverified (A4).
    expect(capture()).toMatchObject({ hostId: `runtime:${STUDIO}`, recordOnlyMirror: true })
    expect(capture()?.mirroredConversationOwner).toBeUndefined()

    const conversation = sessionConversationIdentity({
      worktreeId: ADS_WT,
      agent: 'claude',
      providerSession: C4_SESSION
    })
    const environment = { environmentId: STUDIO, worktreeId: ADS_WT }
    const owner = [ledgerOwner({ environmentId: STUDIO })]
    // Held by the owner (listed:false, G1): the owner shows no row of it, so this computer's own
    // copy stays record-only — the person may still drop it with --unverified (review A8).
    Object.assign(
      source,
      ledgerSlices(
        [ledgerBucket([ledgerRecord(C4_SESSION.id, { conversation, listed: false })], environment)],
        owner
      )
    )
    expect(capture()).toMatchObject({ bucket: 'heldByOwner', recordOnlyMirror: true })
    expect(capture()?.mirroredConversationOwner).toBeUndefined()

    // Listed by the owner: the capture folds into the owner's row, which main refuses as well.
    Object.assign(
      source,
      ledgerSlices(
        [ledgerBucket([ledgerRecord(C4_SESSION.id, { conversation })], environment)],
        owner
      )
    )
    expect(capture()).toBeUndefined()
    const [listed] = manageRows()
    expect(listed).toMatchObject({ paneKey: null, mirroredConversationOwner: STUDIO })
    expect(listed?.recordOnlyMirror).toBeUndefined()
  })

  it('treats a row the owner vouches for as its conversation: neither doubtful nor deletable', () => {
    const source = studioSource()
    const conversation = sessionConversationIdentity({
      worktreeId: ADS_WT,
      agent: 'claude',
      providerSession: C4_SESSION
    })
    const environment = { environmentId: STUDIO, worktreeId: ADS_WT }
    // Held by the owner (listed:false): the capture keeps its row, vouched.
    Object.assign(
      source,
      ledgerSlices(
        [
          ledgerBucket([ledgerRecord(C4_SESSION.id, { conversation, listed: false })], {
            ...environment
          })
        ],
        [ledgerOwner({ environmentId: STUDIO })]
      )
    )
    const held = rowFor(source, C4_PANE)
    expect(held.mirroredConversation?.listed).toBe(false)
    expect(isRecordOnlyMirrorRow(held)).toBe(false)
    expect(getSessionOwnershipUnverifiedReason(source, held)).toBeNull()
    expect(recordOnlyMirrorRowFlags(source, held)).toEqual({})

    // Listed by the owner: the capture folds into the owner's row, which is vouched too.
    Object.assign(
      source,
      ledgerSlices(
        [ledgerBucket([ledgerRecord(C4_SESSION.id, { conversation })], { ...environment })],
        [ledgerOwner({ environmentId: STUDIO })]
      )
    )
    const rows = buildSidebarSessions(source)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.paneKey).toBeNull()
    expect(getSessionOwnershipUnverifiedReason(source, rows[0]!)).toBeNull()
    expect(recordOnlyMirrorRowFlags(source, rows[0]!)).toEqual({})
  })
})
