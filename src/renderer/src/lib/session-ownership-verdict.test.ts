import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import type { Tab } from '../../../shared/tab-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  sessionRowDetailNotes,
  sessionRowStatus
} from '@/components/sidebar/session-folders/session-row-status'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'
import { getSessionOwnershipUnverifiedReason } from './session-ownership-verdict'
import { emptySessionSidebarView } from './session-sidebar-view'
import {
  addSessionTestTab,
  SESSION_TEST_LEAF,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from './sidebar-session-test-fixtures'
import { buildSidebarSessions } from './sidebar-sessions'
import {
  markHostSessionMirrorWorktreeHydrated,
  resetHostSessionMirrorHydrationForTests
} from '@/runtime/host-session-mirror-hydration'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import {
  addMirrorTab,
  LEDGER_ENV,
  ledgerBucket,
  ledgerRecord,
  ledgerSlices,
  OWNER_PANE,
  pairedSource
} from './mirrored-conversation-test-fixtures'

vi.mock('@/lib/personal-view-storage', () => ({
  personalViewStorageKey: (key: string) => key,
  readPersonalView: () => null
}))

const WT = SESSION_TEST_WORKTREE

function unified(entityId: string, executionHostId: string): Tab {
  return {
    id: entityId,
    entityId,
    groupId: 'group',
    worktreeId: WT,
    executionHostId,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  } as Tab
}

/** A local-PTY tab stamped as a paired runtime's: the publisher quarantines it. */
function conflictingState(): AppState {
  const source = sessionTestSource()
  addSessionTestTab(source, 'tab-a')
  source.unifiedTabsByWorktree[WT] = [unified('tab-a', 'runtime:studio')]
  return source as unknown as AppState
}

const row = (tabId: string) => ({ kind: 'terminal', tabId, worktreeId: WT })

describe('conversations whose owning computer cannot be verified', () => {
  beforeEach(() => {
    useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
  })

  it('names the reason for quarantined and conflicting rows, and nothing for ordinary ones', () => {
    expect(getSessionOwnershipUnverifiedReason(conflictingState(), row('tab-a'))).toBe(
      'conflicting-provenance'
    )

    const shared = sessionTestSource()
    shared.repos = [
      { id: 'repo-a', executionHostId: 'local' } as unknown as Repo,
      { id: 'repo-a', executionHostId: 'runtime:studio' } as unknown as Repo
    ]
    shared.worktreesByRepo = {}
    addSessionTestTab(shared, 'tab-b').ptyId = null
    expect(getSessionOwnershipUnverifiedReason(shared, row('tab-b'))).toBe('unresolved-workspace')

    const mirrors = sessionTestSource()
    const alias = toWebTerminalSurfaceTabId('host-alias')
    const mirror = toWebTerminalSurfaceTabId('host-mirror')
    addSessionTestTab(mirrors, alias).ptyId = 'remote:env-a@@handle'
    addSessionTestTab(mirrors, mirror).ptyId = 'remote:env-a@@handle-2'
    addSessionTestTab(mirrors, 'local-tab')
    mirrors.unifiedTabsByWorktree[WT] = [
      unified(alias, 'runtime:env-b'),
      unified(mirror, 'runtime:env-a')
    ]
    expect(getSessionOwnershipUnverifiedReason(mirrors, row(alias))).toBe('conflicting-provenance')
    expect(getSessionOwnershipUnverifiedReason(mirrors, row(mirror))).toBeNull()
    expect(getSessionOwnershipUnverifiedReason(mirrors, row('local-tab'))).toBeNull()
  })

  it('keeps the row listed with a cannot-verify caption and note', () => {
    const state = conflictingState()
    const session = buildSidebarSessions(state).find((candidate) => candidate.tabId === 'tab-a')!
    expect(session).toBeDefined()
    const input = {
      session,
      ownershipUnverified: 'conflicting-provenance' as const,
      chain: null,
      pursuitChain: null,
      run: null,
      attention: null,
      returned: false,
      waitingUntil: null,
      locked: null,
      queued: false,
      completed: null,
      archived: false
    }
    const status = sessionRowStatus(input)
    expect(status).toEqual({ kind: 'awaiting', text: "Can't verify which computer owns this" })
    expect(sessionRowDetailNotes(input, status).unavailable).toContain('more than one computer')
  })

  it('reports the row to `omni session list` as unverifiable, never dropping it', () => {
    const rows = buildSessionManageSidebarRows(conflictingState(), 1_000)
    expect(rows.find((candidate) => candidate.tabId === 'tab-a')).toMatchObject({
      ownershipUnverified: 'conflicting-provenance'
    })
  })
})

describe('rows a paired owner’s ledger vouches for (session parity, step 6)', () => {
  beforeEach(() => {
    useSessionSidebarView.setState({ loaded: true, view: emptySessionSidebarView(), archived: [] })
    resetHostSessionMirrorHydrationForTests()
  })

  it("names no doubt for a mirror row its owner lists, which it otherwise labels can't verify", () => {
    const source = pairedSource()
    const tab = addMirrorTab(source, undefined, null)
    tab.ptyId = toRemoteRuntimePtyId('term-1', LEDGER_ENV)
    const paneKey = makePaneKey(tab.id, SESSION_TEST_LEAF)
    // This computer's record is the row's only conversation evidence (A4) once the owner answered.
    source.sleepingAgentSessionsByPaneKey[paneKey] = {
      paneKey,
      tabId: tab.id,
      worktreeId: WT,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 's1' },
      prompt: '',
      state: 'working',
      capturedAt: 100,
      updatedAt: 100,
      origin: 'live'
    }
    markHostSessionMirrorWorktreeHydrated(LEDGER_ENV, WT)
    const before = buildSidebarSessions(source).find((session) => session.paneKey === paneKey)!
    expect(getSessionOwnershipUnverifiedReason(source, before)).toBe('absence-unverified')

    Object.assign(
      source,
      ledgerSlices([ledgerBucket([ledgerRecord('s1', { paneKey: OWNER_PANE })])])
    )
    const vouched = buildSidebarSessions(source).find((session) => session.paneKey === paneKey)!
    expect(vouched.mirroredConversation?.listed).toBe(true)
    expect(getSessionOwnershipUnverifiedReason(source, vouched)).toBeNull()
  })
})
