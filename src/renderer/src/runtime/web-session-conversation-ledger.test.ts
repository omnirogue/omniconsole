import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  MIRRORED_CONVERSATION_DELETION_HISTORY_GAP,
  isMirroredConversationBucketAuthoritative,
  mirroredConversationBucketKey,
  mirroredConversationOwnerLedgers,
  mirroredConversationTaggedIdentity,
  ownerPublishesMirroredConversationLedger
} from '@/store/slices/mirrored-conversation-ledger'
import { mirroredWorkflowBucketKey } from '@/store/slices/mirrored-workflow-records'
import { SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { SessionFrameLogRecord } from '../../../shared/session-frame-log'
import type {
  RuntimeSessionConversationLedger,
  RuntimeSessionConversationLedgerDelta,
  RuntimeSessionConversationRecord
} from '../../../shared/session-conversation-ledger'
import type { RuntimeSessionWorkflowRecordSet } from '../../../shared/session-workflow-records'
import {
  noteMirroredOwnerReachability,
  restoreMirroredOwnerSnapshots
} from './mirrored-conversation-ledger-receiver'
import { resetMirroredOwnerSnapshotPersistenceForTests } from './mirrored-owner-snapshot-persistence'
import {
  _flushSessionFrameLogForTests,
  _resetSessionFrameLogForTests,
  setSessionFrameLogEnabled
} from './session-frame-log'
import {
  MIRRORED_CONVERSATION_DELETION_HISTORY_MS,
  applyMirroredConversationLedger,
  retractMirroredConversationEnvironment,
  seedMirroredConversationLedger
} from './web-session-conversation-ledger'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'
import { applyMirroredWorkflowRecords } from './web-session-workflow-records'

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const WT = 'repo::/work'
const OTHER_WT = 'repo::/other'
const T0 = 1_700_000_000_000

/** A 24-hex conversation digest, as the owner sends it. */
function digest(n: number): string {
  return n.toString(16).padStart(24, '0')
}

function conversation(n: number, overrides: Partial<RuntimeSessionConversationRecord> = {}) {
  return {
    conversation: digest(n),
    agent: 'claude',
    providerSession: { key: 'session_id' as const, id: `session-${n}` },
    title: `conversation ${n}`,
    titleSource: 'custom' as const,
    surface: 'record' as const,
    rest: 'asleep' as const,
    listed: true,
    updatedAt: n,
    ...overrides
  }
}

/** A provider-less dormant tab: identified by its pane only. */
function pane(name: string): RuntimeSessionConversationRecord {
  return {
    conversation: null,
    paneIdentity: `pane:${name}`,
    paneKey: name,
    agent: 'codex',
    providerSession: null,
    title: name,
    titleSource: 'terminal',
    surface: 'tab',
    tabId: name.split(':')[0],
    rest: 'dormant',
    listed: true,
    updatedAt: 1
  }
}

function set(
  revision: number,
  recordsByWorktree: Record<string, RuntimeSessionConversationRecord[]>,
  overrides: Partial<RuntimeSessionConversationLedger> = {}
): RuntimeSessionConversationLedger {
  return {
    generation: 'gen-1',
    revision,
    source: 'window',
    listedAt: T0 + revision,
    coverage: Object.keys(recordsByWorktree).map((worktreeId) => ({ worktreeId, complete: true })),
    omitted: { unknownHost: 0, unverified: 0 },
    folders: [],
    projects: [],
    recordsByWorktree,
    removals: [],
    ...overrides
  }
}

function delta(
  revision: number,
  baseRevision: number,
  changedByWorktree: Record<string, RuntimeSessionConversationRecord[]>,
  overrides: Partial<RuntimeSessionConversationLedgerDelta> = {}
): RuntimeSessionConversationLedgerDelta {
  return {
    generation: 'gen-1',
    revision,
    baseRevision,
    source: 'window',
    coverage: Object.keys(changedByWorktree).map((worktreeId) => ({ worktreeId, complete: true })),
    changedByWorktree,
    ...overrides
  }
}

/** The initial listAll (or a subscribeAll inventory) of a fresh connection. */
function listed(environmentId: string, value: unknown): void {
  applyMirroredConversationLedger(environmentId, value, { fresh: true, source: 'listAll' })
}

/** A later event on a running subscribeAll stream. */
function streamed(environmentId: string, value: unknown): void {
  applyMirroredConversationLedger(environmentId, value, { fresh: false, source: 'subscribeAll' })
}

function bucket(environmentId = ENV_A, worktreeId = WT) {
  return useAppStore.getState().mirroredConversationLedgerByOwner[
    mirroredConversationBucketKey(environmentId, worktreeId)
  ]
}

function ids(environmentId = ENV_A, worktreeId = WT): string[] | undefined {
  return bucket(environmentId, worktreeId)?.records.map(mirroredConversationTaggedIdentity)
}

/** A bucket's membership, order aside (A5/C1 define membership; the merge's order is not a contract). */
function members(environmentId = ENV_A, worktreeId = WT): string[] | undefined {
  return ids(environmentId, worktreeId)?.slice().sort()
}

function owner(environmentId = ENV_A) {
  return useAppStore.getState().mirroredConversationOwnersByEnvironment[environmentId]
}

const c = (n: number): string => `c:${digest(n)}`

/** Runtime statuses naming the ledger capability, as a desktop owner's does (never orcad's). */
function advertising(...environmentIds: string[]): AppState['runtimeStatusByEnvironmentId'] {
  return new Map(
    environmentIds.map((environmentId) => [
      environmentId,
      {
        status: { capabilities: [SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY] },
        checkedAt: 1
      }
    ])
  ) as AppState['runtimeStatusByEnvironmentId']
}

let now = T0
const remember = vi.fn(async (_request: unknown) => {})
const appended: SessionFrameLogRecord[] = []

describe('the owner conversation ledger on the receiver (session parity, step 5)', () => {
  beforeEach(() => {
    now = T0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    remember.mockClear()
    appended.length = 0
    resetWebSessionTabsSyncTestState()
    resetMirroredOwnerSnapshotPersistenceForTests()
    _resetSessionFrameLogForTests()
    vi.stubGlobal('window', {
      api: {
        runtime: { rememberConversationLedger: remember },
        sessionFrameLog: { append: (records: SessionFrameLogRecord[]) => appended.push(...records) }
      }
    })
    useAppStore.setState({
      mirroredConversationLedgerByOwner: {},
      mirroredConversationOwnersByEnvironment: {},
      mirroredWorkflowRecordsByOwner: {},
      runtimeStatusByEnvironmentId: advertising(ENV_A, ENV_B)
    })
  })

  afterEach(() => {
    _resetSessionFrameLogForTests()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('takes a ledger only from an owner whose status names the capability (never orcad)', () => {
    setSessionFrameLogEnabled(true)
    useAppStore.setState({ runtimeStatusByEnvironmentId: advertising(ENV_B) })
    // orcad answers a negotiated client with a set from a store nothing publishes to.
    listed(ENV_A, set(1, { [WT]: [conversation(1)] }))
    expect(bucket()).toBeUndefined()
    expect(owner()).toMatchObject({ state: 'older', generation: null })
    expect(ownerPublishesMirroredConversationLedger(owner())).toBe(false)
    _flushSessionFrameLogForTests()
    expect(appended.find((entry) => entry.decision === 'retained')).toMatchObject({
      reason: 'owner-without-ledger-capability'
    })
    streamed(ENV_A, delta(2, 1, { [WT]: [conversation(1), conversation(2)] }))
    expect(bucket()).toBeUndefined()
    expect(owner()?.state).toBe('older')
    // The same answer from an owner that advertises it is today's ledger path.
    listed(ENV_B, set(1, { [WT]: [conversation(1)] }))
    expect(ids(ENV_B)).toEqual([c(1)])
    expect(owner(ENV_B)?.state).toBe('ready')
  })

  it('reads a revision-0 set as no ledger yet and takes the first publication on base 0', () => {
    setSessionFrameLogEnabled(true)
    listed(ENV_A, set(0, {}, { source: 'main' }))
    expect(bucket()).toBeUndefined()
    expect(owner()).toMatchObject({ state: 'older', generation: null })
    _flushSessionFrameLogForTests()
    expect(appended.find((entry) => entry.decision === 'retained')).toMatchObject({
      reason: 'owner-ledger-revision-zero'
    })
    streamed(ENV_A, delta(1, 0, { [WT]: [conversation(1), conversation(2)] }))
    expect(ids()).toEqual([c(1), c(2)])
    expect(owner()).toMatchObject({ state: 'ready', generation: 'gen-1', revision: 1 })
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(true)
  })

  it('replaces a workspace whole on a live window set with complete coverage, else only adds', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1), conversation(2)] }))
    expect(ids()).toEqual([c(1), c(2)])
    expect(bucket()).toMatchObject({
      source: 'window',
      coverage: { complete: true },
      ownerState: 'ready'
    })
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(true)

    streamed(ENV_A, set(2, { [WT]: [conversation(1)] }))
    expect(ids()).toEqual([c(1)])

    streamed(
      ENV_A,
      set(3, { [WT]: [conversation(3)] }, { coverage: [{ worktreeId: WT, complete: false }] })
    )
    expect(ids()).toEqual([c(1), c(3)])
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(false)
  })

  it('takes a main-authored set as add, update and vouch only, even with complete coverage', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1), conversation(2)] }))
    streamed(
      ENV_A,
      set(2, { [WT]: [conversation(1, { title: 'renamed', rest: 'live' })] }, { source: 'main' })
    )
    expect(members()).toEqual([c(1), c(2)])
    expect(bucket()?.records.find((record) => record.conversation === digest(1))).toMatchObject({
      title: 'renamed',
      rest: 'live'
    })
    expect(bucket()).toMatchObject({ source: 'main', coverage: { complete: true } })
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(false)
  })

  it('resets only ordering on a new generation: rows stay until a live window-complete set omits them', () => {
    listed(
      ENV_A,
      set(5, { [WT]: [conversation(1), conversation(2)], [OTHER_WT]: [conversation(4)] })
    )
    // The owner restarted with its window still loading: incomplete, OTHER_WT not covered at all.
    listed(
      ENV_A,
      set(
        1,
        { [WT]: [conversation(1)] },
        { generation: 'gen-2', coverage: [{ worktreeId: WT, complete: false }] }
      )
    )
    expect(members()).toEqual([c(1), c(2)])
    expect(ids(ENV_A, OTHER_WT)).toEqual([c(4)])
    expect(bucket(ENV_A, OTHER_WT)?.coverage.complete).toBe(false)
    // A late set from the old incarnation is fenced, fresh or not.
    listed(ENV_A, set(9, { [WT]: [] }))
    expect(members()).toEqual([c(1), c(2)])
    // The new incarnation's window lists WT completely: only now does conversation 2 go.
    streamed(ENV_A, set(2, { [WT]: [conversation(1)] }, { generation: 'gen-2' }))
    expect(ids()).toEqual([c(1)])
    expect(ids(ENV_A, OTHER_WT)).toEqual([c(4)])
  })

  it('applies a delta to the workspaces it changes, by their coverage, and nothing else', () => {
    listed(
      ENV_A,
      set(3, { [WT]: [conversation(1), conversation(2)], [OTHER_WT]: [conversation(4)] })
    )
    now = T0 + 5_000
    streamed(ENV_A, delta(4, 3, { [WT]: [conversation(1)] }))
    expect(ids()).toEqual([c(1)])
    expect(bucket()).toMatchObject({ revision: 4, listedAt: T0 + 3, asOf: T0 + 5_000 })
    expect(owner()).toMatchObject({ revision: 4, listedAt: T0 + 3, asOf: T0 + 5_000 })
    streamed(
      ENV_A,
      delta(
        5,
        4,
        { [OTHER_WT]: [conversation(5)] },
        { coverage: [{ worktreeId: OTHER_WT, complete: false }] }
      )
    )
    expect(ids(ENV_A, OTHER_WT)).toEqual([c(4), c(5)])
    // A base this receiver never reached, and a late copy, are ignored.
    streamed(ENV_A, delta(9, 7, { [WT]: [] }))
    streamed(ENV_A, delta(5, 4, { [OTHER_WT]: [] }))
    expect(ids()).toEqual([c(1)])
    expect(ids(ENV_A, OTHER_WT)).toEqual([c(4), c(5)])
  })

  // The owner's real delta shape: coverage for EVERY workspace, but only the workspaces whose
  // lists changed are named (rpc/methods/session-conversation-ledger.ts). A workspace holding
  // rows this receiver retained can therefore read "window, complete" without the owner ever
  // having listed it again, so such a delta must never raise its authority.
  it('never lets a delta that does not name a workspace raise it: retained rows stay unproven', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1), conversation(2)] }))
    // The owner restarted and conversation 2 did not survive; main lists only 1 (never removes).
    listed(ENV_A, set(1, { [WT]: [conversation(1)] }, { generation: 'gen-2', source: 'main' }))
    expect(members()).toEqual([c(1), c(2)])
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(false)
    // The window attaches with the same list: a delta naming nothing, covering WT complete.
    streamed(
      ENV_A,
      delta(2, 1, {}, { generation: 'gen-2', coverage: [{ worktreeId: WT, complete: true }] })
    )
    expect(members()).toEqual([c(1), c(2)])
    expect(bucket()).toMatchObject({ source: 'main', revision: 1 })
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(false)
    // Only a message naming the workspace proves its list: conversation 2 goes now.
    streamed(ENV_A, delta(3, 2, { [WT]: [conversation(1)] }, { generation: 'gen-2' }))
    expect(ids()).toEqual([c(1)])
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(true)
  })

  it('drops the kept record of an owner pane once a listed record runs that pane (one pane, one row)', () => {
    const at = (n: number, pane: string) =>
      conversation(n, {
        surface: 'tab',
        paneIdentity: `pane:${pane}`,
        paneKey: pane,
        tabId: pane.split(':')[0],
        rest: 'live'
      })
    const incomplete = { coverage: [{ worktreeId: WT, complete: false }] }
    // The workspace never reads complete (a quarantined row there), so an omission proves nothing.
    listed(ENV_A, set(1, { [WT]: [at(1, 'tab-1:leaf'), at(2, 'tab-2:leaf')] }, incomplete))
    expect(ids()).toEqual([c(1), c(2)])
    // Pane tab-1 switched from conversation 1 to 3 (/clear); conversation 2 is retained as before.
    streamed(ENV_A, delta(2, 1, { [WT]: [at(3, 'tab-1:leaf')] }, incomplete))
    expect(members()).toEqual([c(2), c(3)])
    // A kept record with no pane (a slept conversation) is not in any pane's slot: it stays.
    streamed(ENV_A, delta(3, 2, { [WT]: [conversation(4)] }, incomplete))
    streamed(ENV_A, delta(4, 3, { [WT]: [at(5, 'tab-2:leaf')] }, incomplete))
    expect(members()).toEqual([c(3), c(4), c(5)])
  })

  it('keeps an incomplete window workspace unproven through an unnamed complete delta', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1), conversation(2)] }))
    streamed(
      ENV_A,
      set(2, { [WT]: [conversation(1)] }, { coverage: [{ worktreeId: WT, complete: false }] })
    )
    expect(members()).toEqual([c(1), c(2)])
    streamed(ENV_A, delta(3, 2, {}, { coverage: [{ worktreeId: WT, complete: true }] }))
    expect(members()).toEqual([c(1), c(2)])
    expect(bucket()).toMatchObject({ coverage: { complete: false }, revision: 2 })
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(false)
    streamed(ENV_A, set(4, { [WT]: [conversation(1)] }))
    expect(ids()).toEqual([c(1)])
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(true)
  })

  it('lets an unnamed delta keep or lower a workspace already proven in this generation', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1)] }))
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(true)
    now = T0 + 1_000
    streamed(ENV_A, delta(2, 1, {}, { coverage: [{ worktreeId: WT, complete: true }] }))
    expect(bucket()).toMatchObject({ revision: 2, asOf: T0 + 1_000 })
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(true)
    // The window closed: main republishes every workspace incomplete, lists unchanged.
    streamed(
      ENV_A,
      delta(3, 2, {}, { source: 'main', coverage: [{ worktreeId: WT, complete: false }] })
    )
    expect(ids()).toEqual([c(1)])
    expect(bucket()).toMatchObject({ source: 'main', coverage: { complete: false } })
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(false)
    // The window is back with the same list: still nothing names WT, so it stays unproven.
    streamed(ENV_A, delta(4, 3, {}, { coverage: [{ worktreeId: WT, complete: true }] }))
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(false)
  })

  it('removes a row on a tombstone from a set or a delta, whatever the source or coverage (F15)', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1), conversation(2), pane('t1:a'), pane('t2:b')] }))
    streamed(
      ENV_A,
      set(
        2,
        { [WT]: [conversation(1)] },
        {
          source: 'main',
          coverage: [{ worktreeId: WT, complete: false }],
          removals: [{ conversation: digest(2), worktreeId: WT, at: T0 }]
        }
      )
    )
    expect(members()).toEqual([c(1), 'p:pane:t1:a', 'p:pane:t2:b'].sort())
    // Deleting one of several provider-less panes removes only that one (F21).
    streamed(
      ENV_A,
      delta(
        3,
        2,
        {},
        {
          source: 'main',
          coverage: [],
          removals: [{ paneIdentity: 'pane:t1:a', worktreeId: WT, at: T0 }]
        }
      )
    )
    expect(members()).toEqual([c(1), 'p:pane:t2:b'].sort())
    // The owner never tombstones a row the same message lists; if it did, the listing wins.
    streamed(
      ENV_A,
      set(
        4,
        { [WT]: [conversation(1)] },
        {
          coverage: [{ worktreeId: WT, complete: false }],
          removals: [{ conversation: digest(1), worktreeId: WT, at: T0 }]
        }
      )
    )
    expect(members()).toEqual([c(1), 'p:pane:t2:b'].sort())
    // The tombstones stay on the owner entry for capture retirement (step 7).
    expect(owner()?.removals).toEqual([{ conversation: digest(1), worktreeId: WT, at: T0 }])
  })

  it('joins a delta’s tombstones to the retained list and keeps them apart per owner (F8)', () => {
    listed(
      ENV_A,
      set(
        1,
        { [WT]: [conversation(1), conversation(2)] },
        { removals: [{ conversation: digest(7), worktreeId: WT, at: 1 }] }
      )
    )
    listed(ENV_B, set(1, { [WT]: [conversation(1), conversation(2)] }, { generation: 'gen-b' }))
    streamed(
      ENV_A,
      delta(
        2,
        1,
        {},
        { coverage: [], removals: [{ conversation: digest(2), worktreeId: WT, at: 2 }] }
      )
    )
    expect(owner(ENV_A)?.removals.map((removal) => removal.at)).toEqual([1, 2])
    expect(ids(ENV_A)).toEqual([c(1)])
    expect(ids(ENV_B)).toEqual([c(1), c(2)])
  })

  it('hides a deleted workflow in the workflow slice until the owner withdraws the tombstone (F24)', () => {
    const workflows = (revision: number, tabIds: string[]): RuntimeSessionWorkflowRecordSet => ({
      generation: 'wf-1',
      revision,
      complete: true,
      recordsByWorktree: {
        [WT]: tabIds.map((tabId) => ({
          tabId,
          preset: 'council',
          title: tabId,
          status: 'running',
          runId: `run-${tabId}`
        }))
      }
    })
    const shown = () =>
      useAppStore
        .getState()
        .mirroredWorkflowRecordsByOwner[mirroredWorkflowBucketKey(ENV_A, WT)]?.records.map(
          (record) => record.tabId
        )
    applyMirroredWorkflowRecords(ENV_A, workflows(1, ['flow', 'other']), {
      fresh: true,
      source: 'listAll'
    })
    listed(ENV_A, set(1, {}, { removals: [{ workflowTabId: 'flow', worktreeId: WT, at: T0 }] }))
    expect(shown()).toEqual(['other'])
    // The controller still lists it (owner-side workflow publication is unchanged): still hidden.
    applyMirroredWorkflowRecords(ENV_A, workflows(2, ['flow', 'other']), {
      fresh: false,
      source: 'subscribeAll'
    })
    expect(shown()).toEqual(['other'])
    // Undo on the owner: the next set no longer carries the tombstone.
    streamed(ENV_A, set(2, {}))
    expect(shown()).toEqual(['flow', 'other'])
  })

  it('marks buckets unverified on a cut deletion history until window-complete coverage proves them', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1)], [OTHER_WT]: [conversation(4)] }))
    streamed(
      ENV_A,
      set(
        2,
        { [WT]: [conversation(1)], [OTHER_WT]: [conversation(4)] },
        {
          coverage: [
            { worktreeId: WT, complete: true },
            { worktreeId: OTHER_WT, complete: false }
          ],
          removalsTruncated: true
        }
      )
    )
    expect(bucket()?.unverified).toBeUndefined()
    expect(bucket(ENV_A, OTHER_WT)?.unverified).toBe(MIRRORED_CONVERSATION_DELETION_HISTORY_GAP)
    expect(isMirroredConversationBucketAuthoritative(bucket(ENV_A, OTHER_WT)!)).toBe(false)
    streamed(ENV_A, set(3, { [WT]: [conversation(1)], [OTHER_WT]: [conversation(4)] }))
    expect(bucket(ENV_A, OTHER_WT)?.unverified).toBeUndefined()
  })

  it('marks retained buckets unverified after a reconnect past the deletion history', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1), conversation(2)] }))
    now = T0 + MIRRORED_CONVERSATION_DELETION_HISTORY_MS + 1
    listed(
      ENV_A,
      set(2, { [WT]: [conversation(1)] }, { coverage: [{ worktreeId: WT, complete: false }] })
    )
    expect(members()).toEqual([c(1), c(2)])
    expect(bucket()?.unverified).toBe(MIRRORED_CONVERSATION_DELETION_HISTORY_GAP)
  })

  it('keeps an older owner’s rows and states, and retires nothing (F25)', () => {
    // An owner that never advertised the ledger: today's behaviour, no rows, state older.
    listed(ENV_B, undefined)
    expect(owner(ENV_B)).toMatchObject({ state: 'older', generation: null })
    expect(Object.keys(useAppStore.getState().mirroredConversationLedgerByOwner)).toEqual([])
    // A downgraded owner: rows stay as last known, labelled older, never authoritative.
    listed(ENV_A, set(1, { [WT]: [conversation(1)] }))
    listed(ENV_A, undefined)
    expect(owner()?.state).toBe('older')
    expect(ids()).toEqual([c(1)])
    expect(bucket()?.ownerState).toBe('older')
    expect(isMirroredConversationBucketAuthoritative(bucket()!)).toBe(false)
    // A running stream's event without a set is no evidence either way.
    streamed(ENV_A, undefined)
    expect(owner()?.state).toBe('older')
    expect(
      mirroredConversationOwnerLedgers(
        useAppStore.getState().mirroredConversationOwnersByEnvironment
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: `runtime:${ENV_B}`, state: 'older' })
      ])
    )
  })

  it('marks an owner unreachable when its connection drops, and ready on its next live set', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1)] }))
    const down = new Map([
      [ENV_A, { status: null, checkedAt: T0 }]
    ]) as AppState['runtimeStatusByEnvironmentId']
    noteMirroredOwnerReachability({ ...useAppStore.getState(), runtimeStatusByEnvironmentId: down })
    expect(owner()?.state).toBe('unreachable')
    expect(bucket()).toMatchObject({
      ownerState: 'unreachable',
      records: [expect.objectContaining({ conversation: digest(1) })]
    })
    // The reconnect's inventory carries the same revision: live contact again.
    now = T0 + 60_000
    listed(ENV_A, set(1, { [WT]: [conversation(1)] }))
    expect(owner()).toMatchObject({ state: 'ready', asOf: T0 + 60_000 })
    expect(bucket()).toMatchObject({ ownerState: 'ready', asOf: T0 + 60_000 })
  })

  it('keeps a restored owner stale and an older one older when their runtime is down', () => {
    seedMirroredConversationLedger(ENV_A, {
      set: set(1, { [WT]: [conversation(1)] }),
      asOf: T0 - 1
    })
    listed(ENV_B, set(1, { [WT]: [conversation(2)] }, { generation: 'gen-b' }))
    listed(ENV_B, undefined)
    const down = new Map([
      [ENV_A, { status: null, checkedAt: T0 }],
      [ENV_B, { status: null, checkedAt: T0 }]
    ]) as AppState['runtimeStatusByEnvironmentId']
    noteMirroredOwnerReachability({ ...useAppStore.getState(), runtimeStatusByEnvironmentId: down })
    expect(owner(ENV_A)?.state).toBe('stale')
    expect(owner(ENV_B)?.state).toBe('older')
    // F9: a restored owner still publishes the ledger; an older one does not.
    expect(ownerPublishesMirroredConversationLedger(owner(ENV_A))).toBe(true)
    expect(ownerPublishesMirroredConversationLedger(owner(ENV_B))).toBe(false)
  })

  it('retracts only an environment that left the saved list', () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1)] }))
    listed(ENV_B, set(4, { [WT]: [conversation(1)] }, { generation: 'gen-b' }))
    retractMirroredConversationEnvironment(ENV_B)
    expect(bucket(ENV_B)).toBeUndefined()
    expect(owner(ENV_B)).toBeUndefined()
    expect(ids(ENV_A)).toEqual([c(1)])
    // Its ordering went with it: the same environment id starts over.
    listed(ENV_B, set(1, { [WT]: [conversation(2)] }, { generation: 'gen-b' }))
    expect(ids(ENV_B)).toEqual([c(2)])
  })

  it('restores a snapshot stale, never retiring anything, until the first live set replaces it', () => {
    const snapshot = set(7, {
      [WT]: [conversation(1), conversation(2)],
      [OTHER_WT]: [conversation(4)]
    })
    listed(ENV_A, set(1, { [WT]: [conversation(9)] }))
    // A live owner is never overwritten by its snapshot.
    expect(seedMirroredConversationLedger(ENV_A, { set: snapshot, asOf: T0 - 1 })).toBe(false)
    expect(ids(ENV_A)).toEqual([c(9)])

    expect(
      seedMirroredConversationLedger(ENV_B, {
        set: snapshot,
        asOf: T0 - 50,
        asOfByWorktree: { [OTHER_WT]: T0 - 90 }
      })
    ).toBe(true)
    expect(owner(ENV_B)).toMatchObject({ state: 'stale', asOf: T0 - 50 })
    expect(bucket(ENV_B)).toMatchObject({
      stale: true,
      ownerState: 'stale',
      asOf: T0 - 50,
      coverage: { complete: false }
    })
    expect(bucket(ENV_B, OTHER_WT)?.asOf).toBe(T0 - 90)
    expect(isMirroredConversationBucketAuthoritative(bucket(ENV_B)!)).toBe(false)

    listed(ENV_B, set(8, { [WT]: [conversation(1)] }))
    expect(ids(ENV_B)).toEqual([c(1)])
    expect(bucket(ENV_B)).toMatchObject({ ownerState: 'ready', asOf: T0 })
    expect(bucket(ENV_B)?.stale).toBeUndefined()
    // A workspace the live set did not speak for stays restored.
    expect(bucket(ENV_B, OTHER_WT)).toMatchObject({
      stale: true,
      ownerState: 'stale',
      asOf: T0 - 90
    })
    expect(owner(ENV_B)?.state).toBe('ready')
  })

  // Review B3: a restored workflow stays "as of" until the controller lists it again.
  it('keeps restored workflows stale, each as of its own time, through incomplete sets naming none of them', async () => {
    const flow = (tabId: string) => ({
      tabId,
      preset: 'council',
      title: tabId,
      status: 'running' as const,
      runId: `run-${tabId}`
    })
    const workflowBucket = (worktreeId: string) =>
      useAppStore.getState().mirroredWorkflowRecordsByOwner[
        mirroredWorkflowBucketKey(ENV_A, worktreeId)
      ]
    const saved = {
      runtimeEnvironments: [{ id: ENV_A, createdAt: 100 }] as PublicKnownRuntimeEnvironment[],
      removedRuntimeEnvironmentIds: new Set<string>()
    }
    restoreMirroredOwnerSnapshots(
      [
        {
          environmentId: ENV_A,
          savedAt: T0 - 1_000,
          workflowRecords: {
            generation: 'wf-1',
            revision: 4,
            complete: false,
            recordsByWorktree: { [WT]: [flow('a')], [OTHER_WT]: [flow('b')] }
          },
          workflowsAsOf: T0 - 5_000,
          workflowsAsOfByWorktree: { [OTHER_WT]: T0 - 9_000 }
        }
      ],
      saved
    )
    expect(workflowBucket(WT)).toMatchObject({ stale: true, asOf: T0 - 5_000 })
    expect(workflowBucket(OTHER_WT)).toMatchObject({ stale: true, asOf: T0 - 9_000 })

    // The controller runs without a window: its live set is incomplete and names no workflow.
    now = T0 + 100
    applyMirroredWorkflowRecords(
      ENV_A,
      { generation: 'wf-2', revision: 1, complete: false, recordsByWorktree: {} },
      { fresh: true, source: 'listAll' }
    )
    expect(workflowBucket(WT)).toMatchObject({ stale: true, asOf: T0 - 5_000 })
    expect(workflowBucket(OTHER_WT)).toMatchObject({ stale: true, asOf: T0 - 9_000 })
    await Promise.resolve()
    expect(remember.mock.calls.at(-1)![0]).toMatchObject({
      environmentId: ENV_A,
      workflowsAsOf: T0 + 100,
      workflowsAsOfByWorktree: { [WT]: T0 - 5_000, [OTHER_WT]: T0 - 9_000 }
    })

    // A set listing records in a workspace confirms that workspace only.
    applyMirroredWorkflowRecords(
      ENV_A,
      {
        generation: 'wf-2',
        revision: 2,
        complete: false,
        recordsByWorktree: { [WT]: [flow('a')] }
      },
      { fresh: false, source: 'subscribeAll' }
    )
    expect(workflowBucket(WT)?.stale).toBeUndefined()
    expect(workflowBucket(WT)?.asOf).toBeUndefined()
    expect(workflowBucket(OTHER_WT)).toMatchObject({ stale: true, asOf: T0 - 9_000 })
    await Promise.resolve()
    expect(remember.mock.calls.at(-1)![0]).toMatchObject({
      workflowsAsOfByWorktree: { [OTHER_WT]: T0 - 9_000 }
    })
  })

  it('restores only owners still in the saved list', () => {
    const snapshot = {
      environmentId: ENV_B,
      set: set(3, { [WT]: [conversation(1)] }),
      asOf: T0,
      savedAt: T0
    }
    const saved = {
      runtimeEnvironments: [{ id: ENV_A, createdAt: 100 }] as PublicKnownRuntimeEnvironment[],
      removedRuntimeEnvironmentIds: new Set<string>()
    }
    expect(restoreMirroredOwnerSnapshots([snapshot], saved)).toEqual([])
    expect(owner(ENV_B)).toBeUndefined()
    expect(restoreMirroredOwnerSnapshots([{ ...snapshot, environmentId: ENV_A }], saved)).toEqual([
      ENV_A
    ])
    expect(owner(ENV_A)?.state).toBe('stale')
  })

  it('keeps the reconciled result durably after every applied set and delta (C1)', async () => {
    listed(ENV_A, set(1, { [WT]: [conversation(1), conversation(2)] }))
    await Promise.resolve()
    expect(remember).toHaveBeenCalledTimes(1)
    expect(remember.mock.calls[0]![0]).toMatchObject({
      environmentId: ENV_A,
      asOf: T0,
      set: {
        generation: 'gen-1',
        revision: 1,
        coverage: [{ worktreeId: WT, complete: false }],
        recordsByWorktree: {
          [WT]: [
            expect.objectContaining({ conversation: digest(1) }),
            expect.objectContaining({ conversation: digest(2) })
          ]
        }
      }
    })
    streamed(
      ENV_A,
      delta(
        2,
        1,
        {},
        { coverage: [], removals: [{ conversation: digest(2), worktreeId: WT, at: T0 }] }
      )
    )
    await Promise.resolve()
    expect(remember).toHaveBeenCalledTimes(2)
    const kept = remember.mock.calls[1]![0] as { set: RuntimeSessionConversationLedger }
    expect(kept.set.recordsByWorktree[WT]?.map((record) => record.conversation)).toEqual([
      digest(1)
    ])
    // A restored snapshot alone says nothing new: nothing is sent for it.
    seedMirroredConversationLedger(ENV_B, { set: set(1, { [WT]: [conversation(3)] }), asOf: T0 })
    await Promise.resolve()
    expect(remember).toHaveBeenCalledTimes(2)
  })

  it('logs every decision as receiver.ledger with its generation and revision', () => {
    setSessionFrameLogEnabled(true)
    listed(ENV_A, set(2, { [WT]: [conversation(1), conversation(2)] }))
    streamed(ENV_A, set(1, { [WT]: [] }))
    streamed(ENV_A, set(3, { [WT]: [conversation(1)] }))
    listed(ENV_A, undefined)
    _flushSessionFrameLogForTests()
    const ledger = appended.filter((entry) => entry.kind === 'receiver.ledger')
    expect(ledger).toEqual([
      expect.objectContaining({
        decision: 'applied',
        reason: 'first-set',
        generation: 'gen-1',
        revision: 2
      }),
      expect.objectContaining({
        decision: 'ignored',
        reason: 'older-revision',
        generation: 'gen-1',
        revision: 1
      }),
      expect.objectContaining({ decision: 'applied', reason: 'newer-revision', revision: 3 }),
      expect.objectContaining({
        decision: 'removed',
        reason: 'owner-window-complete-coverage-omits',
        revision: 3,
        identities: [c(2)]
      }),
      expect.objectContaining({
        decision: 'retained',
        reason: 'owner-sends-no-ledger',
        revision: 3
      })
    ])
  })
})
