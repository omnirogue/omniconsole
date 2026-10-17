import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { SessionFrameLogRecord } from '../../../shared/session-frame-log'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  markAgentStartInFlight,
  resetAgentStartsInFlightForTests
} from '@/lib/agent-start-in-flight'
import { notePersonRevealedTab, resetPersonRevealsForTests } from '@/lib/restore-flood-guard'
import {
  markDeferredTabsRevealed,
  resetDeferredStartupMountStateForTests,
  selectRevealDeferredTabIds
} from '@/components/terminal/deferred-startup-mount'
import { recordWebAgentSessionHandoff } from './web-agent-session-handoff'
import {
  applyFreshWebSessionTabsSnapshot,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  _flushSessionFrameLogForTests,
  _resetSessionFrameLogForTests,
  setSessionFrameLogEnabled
} from './session-frame-log'
import {
  LEAF_ID,
  NOW,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

// The live A4 case (5 Oct): the MacBook's own Work folder, which the saved catalog assigns to the
// MacBook, held 23 client-minted conversation copies on the Studio that no MacBook frame claimed.
const ENV_A = 'env-a'
const ENV_B = 'env-b'
const FOLDER_ID = 'macbook-work-folder'
const W = `folder:${FOLDER_ID}`
const STALE = ['stale-1', 'stale-2', 'stale-3'] as const
const REAL = ['real-1', 'real-2'] as const

function terminalFrame(
  hostTabIds: readonly string[],
  options: Partial<RuntimeMobileSessionTabsResult> & { membershipUnverified?: true } = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: W,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 2,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: hostTabIds.length > 0 ? 'terminal' : null,
    tabs: hostTabIds.map((hostTabId, index) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF_ID}`,
      parentTabId: hostTabId,
      leafId: LEAF_ID,
      title: `Session ${hostTabId}`,
      launchAgent: 'claude' as const,
      isActive: index === 0,
      status: 'ready' as const,
      terminal: `${hostTabId}-handle`
    })),
    ...options
  }
}

function row(id: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    worktreeId: W,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  }
}

function unifiedTerminal(entityId: string, executionHostId?: string): Tab {
  return {
    id: entityId,
    entityId,
    groupId: 'group',
    worktreeId: W,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(executionHostId ? { executionHostId } : {})
  } as Tab
}

function record(
  tabId: string,
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey(tabId, LEAF_ID),
    tabId,
    worktreeId: W,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${tabId}` },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit',
    resumeOnFirstReveal: true,
    ...overrides
  }
}

function layoutBinding(ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: ptyId }
  }
}

/**
 * Real mirrors of A, an evidence-less legacy mirror, and the receiver's stale copies. The activation
 * sweep re-keys a record onto its copy as-is, so the copies' records carry every origin.
 */
function liveCaseState(
  options: { folderOwners?: readonly string[] } = {}
): WebSessionTabsSyncState {
  const owners = options.folderOwners ?? [ENV_A]
  const realIds = REAL.map((id) => toWebTerminalSurfaceTabId(id))
  const legacyMirror = toWebTerminalSurfaceTabId('ended-on-owner')
  return makeState({
    folderWorkspaces: (owners.length > 0 ? owners : [null]).map((owner) => ({
      id: FOLDER_ID,
      projectGroupId: 'group',
      ...(owner ? { executionHostId: `runtime:${owner}` } : {})
    })),
    tabsByWorktree: {
      [W]: [
        ...realIds.map((id, index) =>
          row(id, { ptyId: toRemoteRuntimePtyId(`${REAL[index]}-handle`, ENV_A) })
        ),
        row(legacyMirror, { launchAgent: 'codex' }),
        ...STALE.map((id) => row(id, { launchAgent: 'claude' }))
      ]
    },
    unifiedTabsByWorktree: { [W]: STALE.map((id) => unifiedTerminal(id)) },
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      [
        record('stale-1', { origin: 'quit' }),
        record('stale-2', { origin: 'worktree-sleep', state: 'done' }),
        record('stale-3', { origin: undefined }),
        record(realIds[0]!, { origin: 'live' }),
        record(legacyMirror)
      ].map((entry) => [entry.paneKey, entry])
    )
  } as Partial<WebSessionTabsSyncState>)
}

/** `state` with extra rows, unified tabs and records in the workspace. */
function withRows(
  state: WebSessionTabsSyncState,
  extra: {
    rows?: TerminalTab[]
    unified?: Tab[]
    records?: SleepingAgentSessionRecord[]
  } & Partial<WebSessionTabsSyncState>
): WebSessionTabsSyncState {
  const { rows = [], unified = [], records = [], ...rest } = extra
  return {
    ...state,
    ...rest,
    tabsByWorktree: { ...state.tabsByWorktree, [W]: [...state.tabsByWorktree[W]!, ...rows] },
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [W]: [...(state.unifiedTabsByWorktree[W] ?? []), ...unified]
    },
    sleepingAgentSessionsByPaneKey: {
      ...state.sleepingAgentSessionsByPaneKey,
      ...Object.fromEntries(records.map((entry) => [entry.paneKey, entry]))
    }
  }
}

function send(
  state: WebSessionTabsSyncState,
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return { ...state, ...applyFreshWebSessionTabsSnapshot(state, snapshot, environmentId, NOW) }
}

function rowIds(state: WebSessionTabsSyncState): string[] {
  return (state.tabsByWorktree[W] ?? []).map((tab) => tab.id)
}

function recordTabIds(state: WebSessionTabsSyncState): string[] {
  return Object.values(state.sleepingAgentSessionsByPaneKey ?? {})
    .map((entry) => entry.tabId!)
    .sort()
}

describe('catalog-owned rows without owner evidence (session-count fix, A4)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    resetAgentStartsInFlightForTests()
    resetPersonRevealsForTests()
    resetDeferredStartupMountStateForTests()
  })

  it("removes stale copies in the owner's workspace that its complete frame omits", () => {
    const state = send(liveCaseState(), ENV_A, terminalFrame(REAL))

    // Before the fix the three client-minted copies (and their records) stayed through every frame.
    const realIds = REAL.map((id) => toWebTerminalSurfaceTabId(id))
    expect(rowIds(state)).toEqual(realIds)
    expect(state.unifiedTabsByWorktree[W]?.map((tab) => tab.entityId)).toEqual(realIds)
    // Why every origin goes (quit, worktree-sleep, none): a surviving record is still a sidebar
    // row and the next sweep would reopen it. The legacy mirror's record goes too: the owner's
    // complete membership omits its pane (web-session-mirror-sleeping-records).
    expect(recordTabIds(state)).toEqual([realIds[0]!])
  })

  it('keeps every copy in a workspace with no catalog owner or conflicting ones', () => {
    for (const folderOwners of [[], [ENV_A, ENV_B]]) {
      resetWebSessionTabsSyncTestState()
      const before = liveCaseState({ folderOwners })
      const state = send(before, ENV_A, terminalFrame(REAL))

      expect(rowIds(state)).toEqual(expect.arrayContaining([...STALE]))
      // Why only the copies' records: the evidence-less legacy mirror row this frame removed as
      // its own (no one else publishes the workspace) takes its record with it.
      expect(recordTabIds(state)).toEqual(expect.arrayContaining([...STALE]))
    }
  })

  it('ignores a frame from an environment that does not own the workspace', () => {
    const before = liveCaseState()
    const state = send(before, ENV_B, terminalFrame(['b-1']))

    expect(rowIds(state)).toEqual(rowIds(before))
    expect(state.sleepingAgentSessionsByPaneKey).toBe(before.sleepingAgentSessionsByPaneKey)
  })

  it("never removes a row whose evidence names another environment in A's workspace", () => {
    const peerMirror = toWebTerminalSurfaceTabId('peer-tab')
    // Why: 'peer-copy' looks exactly like a stale copy except for its stamp naming ENV_B.
    const owned = withRows(liveCaseState(), {
      rows: [
        row(peerMirror, { ptyId: toRemoteRuntimePtyId('peer-handle', ENV_B) }),
        row('peer-copy', { launchAgent: 'claude' })
      ],
      unified: [unifiedTerminal('peer-copy', `runtime:${ENV_B}`)],
      records: [record('peer-copy')]
    })

    const state = send(owned, ENV_A, terminalFrame(REAL))

    expect(rowIds(state)).toEqual(expect.arrayContaining([peerMirror, 'peer-copy']))
    expect(rowIds(state)).not.toContain('stale-1')
    expect(recordTabIds(state)).toContain('peer-copy')
  })

  it('keeps a copy and its record when the record names an SSH connection', () => {
    const owned = withRows(liveCaseState(), {
      rows: [row('ssh-copy', { launchAgent: 'claude' })],
      records: [record('ssh-copy', { connectionId: 'ssh-target-1' })]
    })

    const state = send(owned, ENV_A, terminalFrame(REAL))

    expect(rowIds(state)).toContain('ssh-copy')
    expect(recordTabIds(state)).toContain('ssh-copy')
  })

  it('keeps client-minted rows that carry any PTY', () => {
    const owned = withRows(liveCaseState(), {
      rows: [
        row('tab-pty', { launchAgent: 'claude', ptyId: 'local-pty-1' }),
        row('layout-pty', { launchAgent: 'claude' }),
        row('bound-pty', { launchAgent: 'claude' })
      ],
      terminalLayoutsByTabId: {
        'layout-pty': layoutBinding(toRemoteRuntimePtyId('exited-handle', ENV_A))
      },
      ptyIdsByTabId: { 'bound-pty': [toRemoteRuntimePtyId('bound-handle', ENV_A)] }
    })

    const state = send(owned, ENV_A, terminalFrame(REAL))

    expect(rowIds(state)).toEqual(expect.arrayContaining(['tab-pty', 'layout-pty', 'bound-pty']))
    expect(rowIds(state)).not.toContain('stale-1')
  })

  it('keeps a copy the owner lists under its own id, renamed into its mirror with its record', () => {
    const state = send(liveCaseState(), ENV_A, terminalFrame([...REAL, 'stale-1']))

    expect(rowIds(state)).toContain(toWebTerminalSurfaceTabId('stale-1'))
    expect(rowIds(state)).not.toContain('stale-1')
    expect(recordTabIds(state)).toContain('stale-1')
  })

  it("removes nothing on A's membership-unverified frame or unpublished placeholder", () => {
    const before = liveCaseState()
    const unverified = send(before, ENV_A, terminalFrame(REAL, { membershipUnverified: true }))
    expect(rowIds(unverified)).toEqual(expect.arrayContaining([...STALE]))
    // Why: kept and labelled "can't verify", so nothing wakes them on the owner either.
    expect(
      unverified.tabsByWorktree[W]
        ?.filter((tab) => STALE.includes(tab.id as (typeof STALE)[number]))
        .every((tab) => tab.mirrorAbsenceUnverified === true)
    ).toBe(true)
    expect(unverified.sleepingAgentSessionsByPaneKey).toBe(before.sleepingAgentSessionsByPaneKey)

    resetWebSessionTabsSyncTestState()
    const placeholder = send(
      before,
      ENV_A,
      terminalFrame([], { publicationEpoch: 'none', snapshotVersion: 0 })
    )
    expect(rowIds(placeholder)).toEqual(rowIds(before))
    expect(placeholder.sleepingAgentSessionsByPaneKey).toBe(before.sleepingAgentSessionsByPaneKey)
  })

  it('keeps client-minted rows that are being opened or created, and bare shells', () => {
    const owned = withRows(liveCaseState(), {
      rows: [
        row('first-shell'),
        row('desktop-opened', { launchAgent: 'claude' }),
        row('phone-opened', { launchAgent: 'claude' }),
        row('handed-off', { launchAgent: 'claude' })
      ],
      records: [record('desktop-opened')],
      pendingStartupByTabId: {
        'stale-1': { command: 'claude' },
        'stale-2': { command: 'claude --resume', deferUntilRevealed: true }
      }
    })
    const releaseStart = markAgentStartInFlight('stale-3')
    // Why the desktop path: Terminal.tsx marks a clicked deferred copy revealed here.
    markDeferredTabsRevealed(
      ['desktop-opened'],
      new Set(
        selectRevealDeferredTabIds({
          pendingStartupByTabId: owned.pendingStartupByTabId ?? {},
          sleepingAgentSessionsByPaneKey: owned.sleepingAgentSessionsByPaneKey ?? {},
          tabsByWorktree: owned.tabsByWorktree,
          ptyIdsByTabId: owned.ptyIdsByTabId
        })
      )
    )
    notePersonRevealedTab('phone-opened')
    recordWebAgentSessionHandoff({
      environmentId: ENV_A,
      worktreeId: W,
      provisionalTabId: 'handed-off',
      hostTabId: 'host-not-yet-published',
      hostTerminalHandle: 'pending-handle'
    })

    const state = send(owned, ENV_A, terminalFrame(REAL))
    releaseStart()

    // Why: a queued start, one waiting for its PTY, a copy opened on the desktop or phone, or a
    // recorded handoff is in flight; a reveal-deferred resume nobody has opened is not.
    expect(rowIds(state)).toEqual(
      expect.arrayContaining([
        'stale-1',
        'stale-3',
        'first-shell',
        'desktop-opened',
        'phone-opened',
        'handed-off'
      ])
    )
    expect(rowIds(state)).not.toContain('stale-2')
    expect(state.pendingStartupByTabId).toEqual({ 'stale-1': { command: 'claude' } })
    expect(recordTabIds(state)).toEqual(expect.arrayContaining(['stale-1', 'desktop-opened']))
  })

  it('never removes a conversation started here while it is live, nor after its PTY exits', () => {
    const ownId = 'started-here'
    const ownPty = toRemoteRuntimePtyId('own-handle', ENV_A)
    // Starting: a queued launch, no PTY yet.
    let state = send(
      withRows(liveCaseState(), {
        rows: [row(ownId, { launchAgent: 'claude' })],
        pendingStartupByTabId: { [ownId]: { command: 'claude' } }
      }),
      ENV_A,
      terminalFrame(REAL)
    )
    expect(rowIds(state)).toContain(ownId)

    // Attached: the start was spent and the owner's PTY is bound.
    state = send(
      {
        ...state,
        pendingStartupByTabId: {},
        tabsByWorktree: {
          [W]: state.tabsByWorktree[W]!.map((tab) =>
            tab.id === ownId ? { ...tab, ptyId: ownPty } : tab
          )
        },
        ptyIdsByTabId: { ...state.ptyIdsByTabId, [ownId]: [ownPty] },
        terminalLayoutsByTabId: { ...state.terminalLayoutsByTabId, [ownId]: layoutBinding(ownPty) }
      },
      ENV_A,
      terminalFrame(REAL, { snapshotVersion: 3 })
    )
    expect(rowIds(state)).toContain(ownId)

    // Exited: clearTabPtyId drops the tab binding; the layout keeps its (never pruned) leaf binding.
    state = send(
      {
        ...state,
        tabsByWorktree: {
          [W]: state.tabsByWorktree[W]!.map((tab) =>
            tab.id === ownId ? { ...tab, ptyId: null } : tab
          )
        },
        ptyIdsByTabId: { ...state.ptyIdsByTabId, [ownId]: [] }
      },
      ENV_A,
      terminalFrame(REAL, { snapshotVersion: 4 })
    )
    expect(rowIds(state)).toContain(ownId)
  })

  describe('frame log', () => {
    const appended: SessionFrameLogRecord[] = []
    beforeEach(() => {
      _resetSessionFrameLogForTests()
      appended.length = 0
      vi.stubGlobal('window', {
        api: {
          sessionFrameLog: {
            append: (records: SessionFrameLogRecord[]) => appended.push(...records)
          }
        }
      })
    })
    afterEach(() => {
      _resetSessionFrameLogForTests()
      vi.unstubAllGlobals()
    })

    it('names the catalog-owned removals and retracted hibernation records', () => {
      setSessionFrameLogEnabled(true)
      send(liveCaseState(), ENV_A, terminalFrame(REAL))
      _flushSessionFrameLogForTests()

      const apply = appended.find((entry) => entry.kind === 'receiver.apply')
      // Four rows (three copies and the legacy mirror); only the copies' records go with them.
      expect(apply).toMatchObject({
        removedRows: {
          count: 4,
          reasons: { 'catalog-owned-evidence-less-mirror': 4 }
        },
        retractedSleepingRecords: {
          reason: 'catalog-owned-evidence-less-mirror',
          count: 3,
          paneKeys: STALE.map((id) => makePaneKey(id, LEAF_ID))
        }
      })
    })
  })
})
