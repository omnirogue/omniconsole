import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  sessionConversationIdentity,
  type RuntimeSessionConversationLedger,
  type RuntimeSessionConversationRecord
} from '../../../shared/session-conversation-ledger'
import type { SessionFrameLogRecord } from '../../../shared/session-frame-log'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  toOwnerQualifiedWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
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
  NOW,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'
import {
  applyMirroredConversationLedger,
  seedMirroredConversationLedger
} from './web-session-conversation-ledger'
import { retireMirroredConversationCaptures } from './mirrored-conversation-capture-retirement'

// The live A4 shapes (6 Oct, Studio's saved session): the MacBook (93513683…) owns the
// omni-ide repo c1438ef4 and the Work folder; the Studio holds records of MacBook panes the MacBook
// closed (record only, no tab), and of panes it still lists.
const MACBOOK = '93513683-3ff0-4499-bd79-3c03122c7365'
const LAPTOP = '1d045bce-9849-4ceb-94b6-3e36aeca3513'
const REPO = 'c1438ef4-1bb1-4b73-a5f2-cf72b9924c5f'
const W = `${REPO}::/Users/maintainer/omni-ide-worktrees/omni-ide/rel-review-1004`
const OTHER_W = `${REPO}::/Users/maintainer/omni-ide-worktrees/omni-ide/discover-launch-fixes-1004`
const LEAF = 'cf50cc26-0360-45ed-9a19-3f94e3d56068'
const CLOSED_HOST_TAB = '9526cd53-8dc2-43b3-9ee2-4054a8a372fb'
const LISTED_HOST_TAB = '1717dc1c-f847-4ecc-991f-86f3a1404378'

function record(
  tabId: string,
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey(tabId, LEAF),
    tabId,
    worktreeId: W,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${tabId}` },
    prompt: '',
    state: 'working',
    capturedAt: 1791148901649,
    updatedAt: 1791148900303,
    terminalTitle: 'worker-task_711b442636b5',
    connectionId: null,
    origin: 'live',
    ...overrides
  }
}

function mirrorRow(hostTabId: string, extra: Partial<TerminalTab> = {}): TerminalTab {
  const id = toWebTerminalSurfaceTabId(hostTabId)
  return {
    id,
    worktreeId: W,
    ptyId: toRemoteRuntimePtyId(`term-${hostTabId}`, MACBOOK),
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...extra
  }
}

/** The owner's per-workspace frame as the Studio received it: complete membership, ordered. */
function ownerFrame(
  hostTabIds: readonly string[],
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: W,
    publicationEpoch: 'renderer:f0c59051-10fa-4798-9d60-104bb40e0e1a:client-navigation',
    snapshotVersion: 27,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: hostTabIds.length > 0 ? 'terminal' : null,
    tabs: hostTabIds.map((hostTabId) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF}`,
      parentTabId: hostTabId,
      leafId: LEAF,
      title: 'shell',
      isActive: false,
      status: 'ready' as const,
      terminal: `term-${hostTabId}`
    })),
    ...overrides
  }
}

function liveState(
  options: { repoHost?: string | null; extraRecords?: SleepingAgentSessionRecord[] } = {}
): WebSessionTabsSyncState {
  const repoHost = options.repoHost === undefined ? `runtime:${MACBOOK}` : options.repoHost
  const records = [
    record(toWebTerminalSurfaceTabId(CLOSED_HOST_TAB)),
    record(toWebTerminalSurfaceTabId(LISTED_HOST_TAB), { origin: 'quit' }),
    ...(options.extraRecords ?? [])
  ]
  return makeState({
    repos: [{ id: REPO, ...(repoHost ? { executionHostId: repoHost } : {}) }],
    tabsByWorktree: { [W]: [mirrorRow(LISTED_HOST_TAB)] },
    sleepingAgentSessionsByPaneKey: Object.fromEntries(records.map((r) => [r.paneKey, r]))
  } as Partial<WebSessionTabsSyncState>)
}

function send(
  state: WebSessionTabsSyncState,
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return { ...state, ...applyFreshWebSessionTabsSnapshot(state, snapshot, environmentId, NOW) }
}

function recordTabIds(state: WebSessionTabsSyncState): string[] {
  return Object.values(state.sleepingAgentSessionsByPaneKey ?? {})
    .map((entry) => entry.tabId!)
    .sort()
}

describe("an owner's complete membership retires this computer's records of its panes (A4)", () => {
  beforeEach(() => resetWebSessionTabsSyncTestState())

  it('drops the record of a pane the owner closed while it still publishes the workspace', () => {
    const state = send(liveState(), MACBOOK, ownerFrame([LISTED_HOST_TAB]))

    // Before the fix the closed pane's record stayed: a sidebar row through every MacBook frame.
    expect(recordTabIds(state)).toEqual([toWebTerminalSurfaceTabId(LISTED_HOST_TAB)])
  })

  it('drops every record of an emptied workspace, as the live rel-review-1004 frame (0 tabs)', () => {
    const state = send(liveState(), MACBOOK, ownerFrame([]))

    expect(recordTabIds(state)).toEqual([])
  })

  it('reads the same membership from a current (ordered) owner and an older (unordered) one', () => {
    // Mixed versions: the live MacBook frame carried step 3's order; an older owner's does not.
    const ordered = ownerFrame([LISTED_HOST_TAB], {
      inventoryOrder: {
        generation: 'ad251867-0869-43e8-bce2-d54bd7ccbf7c',
        revision: 27,
        projectionRevision: 0
      }
    } as Partial<RuntimeMobileSessionTabsResult>)
    const fromCurrent = send(liveState(), MACBOOK, ordered)
    resetWebSessionTabsSyncTestState()
    const fromOlder = send(liveState(), MACBOOK, ownerFrame([LISTED_HOST_TAB]))

    expect(recordTabIds(fromCurrent)).toEqual([toWebTerminalSurfaceTabId(LISTED_HOST_TAB)])
    expect(recordTabIds(fromOlder)).toEqual(recordTabIds(fromCurrent))
  })

  it('keeps records of other workspaces, SSH records and another owner’s qualified panes', () => {
    const laptopPane = toOwnerQualifiedWebTerminalSurfaceTabId(LAPTOP, CLOSED_HOST_TAB)
    const before = liveState({
      extraRecords: [
        record(toWebTerminalSurfaceTabId('elsewhere'), { worktreeId: OTHER_W }),
        record(toWebTerminalSurfaceTabId('over-ssh'), { connectionId: 'ssh-target-1' }),
        record(laptopPane)
      ]
    })

    const state = send(before, MACBOOK, ownerFrame([LISTED_HOST_TAB]))

    expect(recordTabIds(state)).toEqual(
      [
        toWebTerminalSurfaceTabId(LISTED_HOST_TAB),
        toWebTerminalSurfaceTabId('elsewhere'),
        toWebTerminalSurfaceTabId('over-ssh'),
        laptopPane
      ].sort()
    )
  })

  it('drops a record whose qualified pane id names the frame owner, whatever the catalog says', () => {
    const qualified = toOwnerQualifiedWebTerminalSurfaceTabId(MACBOOK, 'qualified-closed')
    const state = send(
      liveState({ repoHost: null, extraRecords: [record(qualified)] }),
      MACBOOK,
      ownerFrame([LISTED_HOST_TAB])
    )

    expect(recordTabIds(state)).not.toContain(qualified)
  })

  it('keeps legacy records in a workspace no catalog owner (or a non-owner) can speak for', () => {
    const uncredited = liveState({ repoHost: null })
    expect(
      send(uncredited, MACBOOK, ownerFrame([LISTED_HOST_TAB])).sleepingAgentSessionsByPaneKey
    ).toBe(uncredited.sleepingAgentSessionsByPaneKey)

    resetWebSessionTabsSyncTestState()
    const credited = liveState()
    // Why: laptop's frame for the MacBook's workspace is an echo; the catalog names the owner.
    expect(send(credited, LAPTOP, ownerFrame([])).sleepingAgentSessionsByPaneKey).toBe(
      credited.sleepingAgentSessionsByPaneKey
    )
  })

  it('keeps every record on a membership-unverified frame or the unpublished placeholder', () => {
    const before = liveState()
    expect(
      send(before, MACBOOK, ownerFrame([], { membershipUnverified: true }))
        .sleepingAgentSessionsByPaneKey
    ).toBe(before.sleepingAgentSessionsByPaneKey)

    resetWebSessionTabsSyncTestState()
    expect(
      send(before, MACBOOK, ownerFrame([], { publicationEpoch: 'none', snapshotVersion: 0 }))
        .sleepingAgentSessionsByPaneKey
    ).toBe(before.sleepingAgentSessionsByPaneKey)
  })

  it('drops the record with the row when the frame removes a mirror its evidence ties to it', () => {
    // Why no catalog owner: the removed row's remote PTY names the MacBook, so the record follows.
    const state = send(liveState({ repoHost: null }), MACBOOK, ownerFrame([]))

    expect(state.tabsByWorktree[W] ?? []).toEqual([])
    expect(recordTabIds(state)).toEqual([toWebTerminalSurfaceTabId(CLOSED_HOST_TAB)])
  })

  it('names the retired records in the frame log', () => {
    const appended: SessionFrameLogRecord[] = []
    _resetSessionFrameLogForTests()
    vi.stubGlobal('window', {
      api: {
        sessionFrameLog: { append: (records: SessionFrameLogRecord[]) => appended.push(...records) }
      }
    })
    setSessionFrameLogEnabled(true)
    send(liveState(), MACBOOK, ownerFrame([LISTED_HOST_TAB]))
    _flushSessionFrameLogForTests()

    expect(appended.find((entry) => entry.kind === 'receiver.apply')).toMatchObject({
      retractedMirrorSleepingRecords: {
        reason: 'owner-membership-omits-mirror-pane',
        count: 1,
        paneKeys: [makePaneKey(toWebTerminalSurfaceTabId(CLOSED_HOST_TAB), LEAF)]
      }
    })
  })

  afterEach(() => {
    _resetSessionFrameLogForTests()
    vi.unstubAllGlobals()
  })
})

describe('an omitted PTY the owner still calls live (the 2 dropped live frames)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    clearWebSessionTerminalOrphanRecoveryForTests()
  })

  it('applies the frame as unverified: listed tabs land, the omitted row stays labelled', async () => {
    const stale = mirrorRow('5ebc8fd1-da8e-45b8-9acd-e8dc15c94e40')
    const before = makeState({
      repos: [{ id: REPO, executionHostId: `runtime:${MACBOOK}` }],
      tabsByWorktree: { [W]: [stale] },
      terminalLayoutsByTabId: {
        [stale.id]: {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: stale.ptyId! }
        }
      },
      sleepingAgentSessionsByPaneKey: { [makePaneKey(stale.id, LEAF)]: record(stale.id) }
    } as Partial<WebSessionTabsSyncState>)
    // What the MacBook answered live: the handle is live, connected and not orphaned.
    const call = vi.fn(async () => ({
      ok: true as const,
      result: {
        terminals: [
          {
            handle: 'term-5ebc8fd1-da8e-45b8-9acd-e8dc15c94e40',
            ptyId: `${W}@@zKEtXula`,
            incarnationId: 'edc84f92-c7ae-4bad-8c66-029ec3906c12',
            orphaned: false,
            worktreeId: W,
            tabId: '5ebc8fd1-da8e-45b8-9acd-e8dc15c94e40',
            leafId: LEAF
          }
        ],
        topologyRevisions: { [W]: 194 },
        totalCount: 1,
        truncated: false
      }
    }))

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      before as never,
      ownerFrame([LISTED_HOST_TAB]),
      MACBOOK,
      call as never
    )
    // Before the fix: null, so the whole frame (and tab 1717dc1c) never reached the Studio.
    expect(recovered).toMatchObject({ membershipUnverified: true })
    const state = send(before, MACBOOK, recovered!)

    expect(state.tabsByWorktree[W]?.map((tab) => [tab.id, tab.mirrorAbsenceUnverified])).toEqual([
      [stale.id, true],
      [toWebTerminalSurfaceTabId(LISTED_HOST_TAB), undefined]
    ])
    expect(recordTabIds(state)).toEqual([stale.id])
  })

  /** A stale mirror row of this workspace bound to the owner's PTY `handle`. */
  function staleRowState(hostTabId: string, handle: string): WebSessionTabsSyncState {
    const stale = mirrorRow(hostTabId)
    return makeState({
      repos: [{ id: REPO, executionHostId: `runtime:${MACBOOK}` }],
      tabsByWorktree: { [W]: [stale] },
      terminalLayoutsByTabId: {
        [stale.id]: {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: toRemoteRuntimePtyId(handle, MACBOOK) }
        }
      }
    } as Partial<WebSessionTabsSyncState>)
  }

  it('does not ask about a PTY the frame still publishes under another tab', async () => {
    const before = staleRowState('old-host-tab', `term-${LISTED_HOST_TAB}`)
    const call = vi.fn()
    const frame = ownerFrame([LISTED_HOST_TAB])

    // Why: the frame publishes that very handle (as the listed tab's terminal), so nothing of
    // this workspace is omitted and its membership stays complete.
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(before as never, frame, MACBOOK, call as never)
    ).resolves.toBe(frame)
    expect(call).not.toHaveBeenCalled()
  })

  it('reads a PTY living on in another workspace as accounted for there', async () => {
    const before = staleRowState('moved-host-tab', 'term-moved')
    const call = vi.fn(async () => ({
      ok: true as const,
      result: {
        terminals: [
          {
            handle: 'term-moved',
            ptyId: `${OTHER_W}@@moved`,
            incarnationId: 'incarnation-moved',
            orphaned: false,
            worktreeId: OTHER_W,
            tabId: 'moved-host-tab',
            leafId: LEAF
          }
        ],
        totalCount: 1,
        truncated: false
      }
    }))
    const frame = ownerFrame([LISTED_HOST_TAB])

    // Before: membership-unverified forever, the moved row kept and labelled in this workspace.
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(before as never, frame, MACBOOK, call as never)
    ).resolves.toBe(frame)
  })
})

// Phase 0 check G3 (session parity): since PR #1084 the owner publishes dormant and untabbed
// terminal surfaces (no PTY) on the existing frames, ungated. They arrive in the pending-handle
// shape every receiver has read since v1.12.21; this pins what a receiver does with one.
describe('a dormant or untabbed owner surface without a PTY (#1084, Rule 3 check G3)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    clearWebSessionTerminalOrphanRecoveryForTests()
  })

  const DORMANT_HOST_TAB = 'b2c1d0e9-5a4f-4c3b-8d2e-1f0a9b8c7d6e'
  const HELD_HOST_TAB = 'c3d2e1f0-6b5a-4d4c-9e3f-2a1b0c9d8e7f'

  function dormantSurface(
    hostTabId: string,
    automaticActivationHold?: 'completed' | 'parked'
  ): RuntimeMobileSessionTabsResult['tabs'][number] {
    return {
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF}`,
      parentTabId: hostTabId,
      leafId: LEAF,
      title: 'claude',
      isActive: false,
      launchAgent: 'claude' as const,
      status: 'pending-handle' as const,
      terminal: null,
      ...(automaticActivationHold ? { automaticActivationHold } : {})
    }
  }

  it('applies as an inert pending-handle row: listed with no PTY, no record, no RPC, nothing launched', async () => {
    const before = makeState({
      repos: [{ id: REPO, executionHostId: `runtime:${MACBOOK}` }],
      tabsByWorktree: { [W]: [] },
      sleepingAgentSessionsByPaneKey: {}
    } as Partial<WebSessionTabsSyncState>)
    const listed = ownerFrame([LISTED_HOST_TAB])
    const frame = {
      ...listed,
      tabs: [
        ...listed.tabs,
        dormantSurface(DORMANT_HOST_TAB),
        dormantSurface(HELD_HOST_TAB, 'completed')
      ]
    }
    const call = vi.fn()

    // Why: the only RPC the apply path can make is the orphan census about a PTY the frame omits;
    // a listed surface without a PTY is a member, not an omission, so nothing is asked.
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(before as never, frame, MACBOOK, call as never)
    ).resolves.toBe(frame)
    expect(call).not.toHaveBeenCalled()
    expect(frame.membershipUnverified).toBeUndefined()

    const state = send(before, MACBOOK, frame)
    const rows = state.tabsByWorktree[W]!
    expect(rows.map((tab) => [tab.runtimeOwnerTabId, tab.ptyId])).toEqual([
      [LISTED_HOST_TAB, toRemoteRuntimePtyId(`term-${LISTED_HOST_TAB}`, MACBOOK)],
      [DORMANT_HOST_TAB, null],
      [HELD_HOST_TAB, null]
    ])
    for (const hostTabId of [DORMANT_HOST_TAB, HELD_HOST_TAB]) {
      const row = rows.find((tab) => tab.runtimeOwnerTabId === hostTabId)!
      // Why: only an explicit user activation sets a spawn intent; a frame never does.
      expect(row.pendingActivationSpawn).toBeUndefined()
      expect(row.mirrorAbsenceUnverified).toBeUndefined()
      expect(state.terminalLayoutsByTabId[row.id]?.ptyIdsByLeafId ?? {}).toEqual({})
    }
    expect(state.sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
  })
})

// Session parity, step 7: captures (this computer's records of a ledger owner's conversations,
// mirror-pane or plain-UUID) retire only through the owner's ledger — live window complete coverage
// that names them nowhere, or a tombstone — and that owner's frames retire none by themselves (F9).
describe("a ledger owner's captures retire through its conversation ledger (step 7)", () => {
  const CLIENT_MINTED = '7c2d9f1e-0a4b-4c6d-8e1f-2a3b4c5d6e7f'
  const closed = record(toWebTerminalSurfaceTabId(CLOSED_HOST_TAB))
  const listedTab = record(toWebTerminalSurfaceTabId(LISTED_HOST_TAB), { origin: 'quit' })
  const plain = record(CLIENT_MINTED)
  const logged: SessionFrameLogRecord[] = []

  /** The owner's record of `capture`'s conversation, as its window lists it. */
  function owned(
    capture: SleepingAgentSessionRecord,
    overrides: Partial<RuntimeSessionConversationRecord> = {}
  ): RuntimeSessionConversationRecord {
    return {
      conversation: sessionConversationIdentity(capture),
      agent: capture.agent,
      providerSession: { key: capture.providerSession.key, id: capture.providerSession.id },
      title: 'owner title',
      titleSource: 'custom',
      surface: 'record',
      rest: 'asleep',
      listed: true,
      updatedAt: 1,
      ...overrides
    }
  }

  function ledger(
    revision: number,
    records: RuntimeSessionConversationRecord[],
    overrides: Partial<RuntimeSessionConversationLedger> = {}
  ): RuntimeSessionConversationLedger {
    return {
      generation: 'gen-1',
      revision,
      source: 'window',
      listedAt: NOW + revision,
      coverage: [{ worktreeId: W, complete: true }],
      omitted: { unknownHost: 0, unverified: 0 },
      folders: [],
      projects: [],
      recordsByWorktree: { [W]: records },
      removals: [],
      ...overrides
    }
  }

  const listAll = (value: unknown): void =>
    applyMirroredConversationLedger(MACBOOK, value, { fresh: true, source: 'listAll' })
  const streamed = (value: unknown): void =>
    applyMirroredConversationLedger(MACBOOK, value, { fresh: false, source: 'subscribeAll' })
  const storeRecordTabIds = (): string[] =>
    recordTabIds(useAppStore.getState() as unknown as WebSessionTabsSyncState)

  /** The receiver's store as liveState shapes it, plus a plain-UUID capture of the same owner. */
  function seedStore(captures = [closed, listedTab, plain]): void {
    useAppStore.setState({
      repos: [{ id: REPO, executionHostId: `runtime:${MACBOOK}` }],
      // Why: a receiver takes a ledger only from an owner whose status advertises it.
      runtimeStatusByEnvironmentId: new Map([
        [
          MACBOOK,
          {
            status: { capabilities: [SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY] },
            checkedAt: 1
          }
        ]
      ]),
      tabsByWorktree: { [W]: [mirrorRow(LISTED_HOST_TAB)] },
      sleepingAgentSessionsByPaneKey: Object.fromEntries(captures.map((r) => [r.paneKey, r])),
      mirroredConversationLedgerByOwner: {},
      mirroredConversationOwnersByEnvironment: {}
    } as never)
  }

  /** A frame against the receiver's current store (its ledger slices included). */
  function frame(hostTabIds: readonly string[]): WebSessionTabsSyncState {
    const store = useAppStore.getState()
    const before = makeState({
      repos: store.repos,
      tabsByWorktree: store.tabsByWorktree,
      sleepingAgentSessionsByPaneKey: store.sleepingAgentSessionsByPaneKey,
      mirroredConversationLedgerByOwner: store.mirroredConversationLedgerByOwner,
      mirroredConversationOwnersByEnvironment: store.mirroredConversationOwnersByEnvironment
    } as Partial<WebSessionTabsSyncState>)
    const after = send(before, MACBOOK, ownerFrame(hostTabIds))
    useAppStore.setState({
      tabsByWorktree: after.tabsByWorktree,
      sleepingAgentSessionsByPaneKey: after.sleepingAgentSessionsByPaneKey ?? {}
    })
    return after
  }

  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    _resetSessionFrameLogForTests()
    logged.length = 0
    vi.stubGlobal('window', {
      api: {
        sessionFrameLog: { append: (records: SessionFrameLogRecord[]) => logged.push(...records) }
      }
    })
    setSessionFrameLogEnabled(true)
    seedStore()
  })

  afterEach(() => {
    _resetSessionFrameLogForTests()
    vi.unstubAllGlobals()
  })

  it('retires plain-UUID and web-terminal captures a live window-complete workspace omits', () => {
    listAll(ledger(4, [owned(listedTab, { surface: 'tab', rest: 'live' })]))

    // The listed pane's record stays with its tab; both tab-less captures go, whatever their id.
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])
    _flushSessionFrameLogForTests()
    expect(logged.find((entry) => entry.decision === 'retract-capture')).toMatchObject({
      kind: 'receiver.ledger',
      environmentId: MACBOOK,
      generation: 'gen-1',
      revision: 4,
      omitted: expect.arrayContaining([closed.paneKey, plain.paneKey])
    })
  })

  // Addendum F1/F14 (review B5): Pi and Prime Agent conversations can share a session id across
  // transcript files, so a sibling listed under the same session is not this capture.
  it('retires a Pi capture the owner tombstoned or omitted while a sibling transcript of its session stays listed', () => {
    const shared = { key: 'session_id' as const, id: 'shared' }
    const a = record(toWebTerminalSurfaceTabId(CLOSED_HOST_TAB), {
      agent: 'pi',
      providerSession: { ...shared, transcriptPath: '/notes/a.jsonl' }
    })
    const b = record(CLIENT_MINTED, {
      agent: 'pi',
      providerSession: { ...shared, transcriptPath: '/notes/b.jsonl' }
    })
    const live = owned(listedTab, { surface: 'tab', rest: 'live' })
    // Tombstoned: the owner deleted A; B, the same session's other transcript, stays listed.
    seedStore([a, listedTab])
    listAll(
      ledger(1, [owned(b), live], {
        removals: [{ conversation: sessionConversationIdentity(a)!, worktreeId: W, at: 10 }]
      })
    )
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])

    // Omitted: a live window-complete set lists B and not A.
    seedStore([a, listedTab])
    listAll(ledger(2, [owned(b), live]))
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])
  })

  it('keeps a Pi capture whose digest cannot be exact, or that matches several records (ambiguous)', () => {
    const shared = { key: 'session_id' as const, id: 'shared' }
    // No transcript path recorded here: the capture's digest can match no owner record exactly.
    const inexact = record(toWebTerminalSurfaceTabId(CLOSED_HOST_TAB), {
      agent: 'pi',
      providerSession: shared
    })
    const b = record(CLIENT_MINTED, {
      agent: 'pi',
      providerSession: { ...shared, transcriptPath: '/notes/b.jsonl' }
    })
    const live = owned(listedTab, { surface: 'tab', rest: 'live' })
    seedStore([inexact, listedTab])
    listAll(ledger(1, [owned(b), live]))
    expect(storeRecordTabIds()).toEqual([inexact.tabId, listedTab.tabId].sort())

    // An exact digest that matches no record but whose session matches two: kept, never merged.
    const c = record(toWebTerminalSurfaceTabId(CLOSED_HOST_TAB), {
      agent: 'pi',
      providerSession: { ...shared, transcriptPath: '/notes/c.jsonl' }
    })
    const d = record(CLIENT_MINTED, {
      agent: 'pi',
      providerSession: { ...shared, transcriptPath: '/notes/d.jsonl' }
    })
    seedStore([c, listedTab])
    listAll(ledger(2, [owned(b), owned(d), live]))
    expect(storeRecordTabIds()).toEqual([c.tabId, listedTab.tabId].sort())
  })

  it('keeps a capture its owner holds as passive listed:false evidence (G1, heldByOwner)', () => {
    listAll(ledger(1, [owned(closed, { listed: false }), owned(listedTab, { surface: 'tab' })]))

    expect(storeRecordTabIds()).toEqual([closed.tabId, listedTab.tabId].sort())
  })

  it('keeps a capture whose owner pane is listed without a session; not one naming another', () => {
    const paneIdentity = `pane:${CLOSED_HOST_TAB}:${LEAF}`
    const unknownThere = { conversation: null, providerSession: null, paneIdentity }
    listAll(ledger(1, [owned(closed, { ...unknownThere, surface: 'tab', rest: 'dormant' })]))
    expect(storeRecordTabIds()).toEqual([closed.tabId, listedTab.tabId].sort())

    // The owner's pane now runs another conversation: the capture is not vouched for any more.
    streamed(ledger(2, [owned(listedTab, { paneIdentity, surface: 'tab', rest: 'live' })]))
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])
  })

  it('retires nothing from main-authored, incomplete, uncovered or restored sets', () => {
    const all = [closed.tabId, listedTab.tabId, plain.tabId].sort()
    listAll(ledger(1, [], { source: 'main' }))
    expect(storeRecordTabIds()).toEqual(all)

    streamed(ledger(2, [], { coverage: [{ worktreeId: W, complete: false }] }))
    expect(storeRecordTabIds()).toEqual(all)

    streamed(ledger(3, [], { coverage: [{ worktreeId: OTHER_W, complete: true }] }))
    expect(storeRecordTabIds()).toEqual(all)

    resetWebSessionTabsSyncTestState()
    seedStore()
    seedMirroredConversationLedger(MACBOOK, { set: ledger(9, []), asOf: NOW })
    // Why a frame too: a restored owner publishes a ledger, so its frames defer to it (F9).
    frame([LISTED_HOST_TAB])
    expect(storeRecordTabIds()).toEqual(all)
  })

  // Review C2: a restored snapshot that LISTS something, and leaves a capture out, still retires
  // nothing — through a frame, a fresh set that does not cover the workspace, and a delta whose
  // coverage calls the workspace complete without naming it (the delta's base never held it).
  it('keeps a capture a non-empty restored snapshot leaves out, until a live set names its workspace', () => {
    const all = [closed.tabId, listedTab.tabId, plain.tabId].sort()
    resetWebSessionTabsSyncTestState()
    seedStore()
    seedMirroredConversationLedger(MACBOOK, {
      set: ledger(9, [owned(listedTab, { surface: 'tab' })]),
      asOf: NOW
    })
    frame([LISTED_HOST_TAB])
    expect(storeRecordTabIds()).toEqual(all)

    listAll(ledger(1, [], { coverage: [{ worktreeId: OTHER_W, complete: true }] }))
    expect(storeRecordTabIds()).toEqual(all)

    streamed({
      generation: 'gen-1',
      revision: 2,
      baseRevision: 1,
      source: 'window',
      coverage: [{ worktreeId: W, complete: true }],
      changedByWorktree: {}
    })
    expect(storeRecordTabIds()).toEqual(all)

    // Only a message naming the workspace speaks for it: the two unlisted captures go now.
    streamed({
      generation: 'gen-1',
      revision: 3,
      baseRevision: 2,
      source: 'window',
      coverage: [{ worktreeId: W, complete: true }],
      changedByWorktree: { [W]: [owned(listedTab, { surface: 'tab' })] }
    })
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])
  })

  it('retires a tombstoned capture by digest or by pane, whatever the source or coverage', () => {
    listAll(
      ledger(1, [], {
        source: 'main',
        coverage: [{ worktreeId: W, complete: false }],
        removals: [
          { conversation: sessionConversationIdentity(plain)!, worktreeId: W, at: NOW },
          { paneIdentity: `pane:${CLOSED_HOST_TAB}:${LEAF}`, worktreeId: W, at: NOW }
        ]
      })
    )

    expect(storeRecordTabIds()).toEqual([listedTab.tabId])
    _flushSessionFrameLogForTests()
    expect(logged.find((entry) => entry.decision === 'retract-capture')).toMatchObject({
      tombstoned: expect.arrayContaining([closed.paneKey, plain.paneKey])
    })
  })

  it('frame first: the owner frame omitting a pane retires nothing; its next ledger does', () => {
    listAll(ledger(1, [owned(closed), owned(listedTab, { surface: 'tab' }), owned(plain)]))
    // Legacy A4 would drop the closed pane's record here (the frame omits it).
    frame([LISTED_HOST_TAB])
    expect(storeRecordTabIds()).toEqual([closed.tabId, listedTab.tabId, plain.tabId].sort())

    streamed(ledger(2, [owned(listedTab, { surface: 'tab' })]))
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])
  })

  it('ledger first: retired at once, and a later frame closing a listed tab keeps its record', () => {
    listAll(ledger(1, [owned(listedTab, { surface: 'tab' })]))
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])

    const after = frame([])
    expect(after.tabsByWorktree[W] ?? []).toEqual([])
    // Why kept: the owner still lists the conversation; only its ledger may retire the record.
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])

    streamed(ledger(2, [owned(listedTab, { listed: false })]))
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])
    streamed(ledger(3, []))
    expect(storeRecordTabIds()).toEqual([])
  })

  it('retires in the frame pass a capture made after the ledger once its tab is gone', () => {
    listAll(ledger(1, []))
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])

    frame([])
    expect(storeRecordTabIds()).toEqual([])
    _flushSessionFrameLogForTests()
    expect(logged.find((entry) => entry.source === 'frame')).toMatchObject({
      decision: 'retract-capture',
      omitted: [listedTab.paneKey]
    })
  })

  it('returns an undo that puts the retired captures back', () => {
    seedStore([])
    listAll(ledger(1, [owned(listedTab, { surface: 'tab' })]))
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: Object.fromEntries(
        [closed, listedTab, plain].map((entry) => [entry.paneKey, entry])
      )
    })

    const undo = retireMirroredConversationCaptures(MACBOOK, 'listAll')
    expect(storeRecordTabIds()).toEqual([listedTab.tabId])
    undo()
    expect(storeRecordTabIds()).toEqual([closed.tabId, listedTab.tabId, plain.tabId].sort())
  })
})
