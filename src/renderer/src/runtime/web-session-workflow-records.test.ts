import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { mirroredWorkflowBucketKey } from '@/store/slices/mirrored-workflow-records'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type {
  RuntimeSessionWorkflowRecord,
  RuntimeSessionWorkflowRecordSet
} from '../../../shared/session-workflow-records'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'
import {
  applyMirroredWorkflowRecords,
  retractMirroredWorkflowEnvironment
} from './web-session-workflow-records'

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const WT = 'repo::/work'
const OTHER_WT = 'repo::/other'

function record(
  tabId: string,
  overrides: Partial<RuntimeSessionWorkflowRecord> = {}
): RuntimeSessionWorkflowRecord {
  return {
    tabId,
    preset: 'council',
    title: tabId,
    status: 'running',
    runId: `run-${tabId}`,
    ...overrides
  }
}

function set(
  revision: number,
  recordsByWorktree: Record<string, RuntimeSessionWorkflowRecord[]>,
  overrides: Partial<RuntimeSessionWorkflowRecordSet> = {}
): RuntimeSessionWorkflowRecordSet {
  return { generation: 'gen-1', revision, complete: true, recordsByWorktree, ...overrides }
}

/** A later change on a running subscribeAll stream. */
function streamed(environmentId: string, value: RuntimeSessionWorkflowRecordSet): void {
  applyMirroredWorkflowRecords(environmentId, value, { fresh: false, source: 'subscribeAll' })
}

/** The set a fresh connection's initial listAll (or subscribeAll inventory) carries. */
function listed(environmentId: string, value: unknown): void {
  applyMirroredWorkflowRecords(environmentId, value, { fresh: true, source: 'listAll' })
}

function frame(overrides: Partial<RuntimeMobileSessionTabsResult> = {}) {
  return {
    worktree: WT,
    publicationEpoch: 'renderer:1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    ...overrides
  } as RuntimeMobileSessionTabsResult
}

function mirrored(environmentId = ENV_A, worktreeId = WT): [string, string][] | undefined {
  return useAppStore
    .getState()
    .mirroredWorkflowRecordsByOwner[
      mirroredWorkflowBucketKey(environmentId, worktreeId)
    ]?.records.map((entry) => [entry.tabId, entry.status])
}

describe('mirrored workflow records on the receiver (step 9)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    useAppStore.setState({ mirroredWorkflowRecordsByOwner: {} })
  })

  it('takes each newer set and ignores an older or equal one', () => {
    listed(ENV_A, set(1, { [WT]: [record('flow', { status: 'unavailable' })] }))
    streamed(ENV_A, set(2, { [WT]: [record('flow', { status: 'done' })] }))
    streamed(ENV_A, set(2, { [WT]: [record('flow', { status: 'running' })] }))
    streamed(ENV_A, set(1, { [WT]: [record('flow', { status: 'running' })] }))
    expect(mirrored()).toEqual([['flow', 'done']])
  })

  it('never lets an initial listAll that raced a removal restore what the owner removed', () => {
    listed(ENV_A, set(4, { [WT]: [record('flow'), record('kept')] }))
    // The owner closed the workflow; the stream delivers the newer set first.
    streamed(ENV_A, set(5, { [WT]: [record('kept')] }))
    // The listAll was projected before the close and lands late, on a fresh connection.
    listed(ENV_A, set(4, { [WT]: [record('flow'), record('kept')] }))
    expect(mirrored()).toEqual([['kept', 'running']])
  })

  it('shows a workflow again when its workspace leaves and returns with unchanged records', () => {
    listed(ENV_A, set(1, { [WT]: [record('flow')], [OTHER_WT]: [record('other')] }))
    streamed(ENV_A, set(2, { [OTHER_WT]: [record('other')] }))
    expect(mirrored()).toBeUndefined()
    streamed(ENV_A, set(3, { [WT]: [record('flow')], [OTHER_WT]: [record('other')] }))
    expect(mirrored()).toEqual([['flow', 'running']])
  })

  it('removes nothing on an incomplete set (startup, headless, a closed window, a dropped record)', () => {
    listed(ENV_A, set(1, { [WT]: [record('flow')] }))
    streamed(ENV_A, set(2, {}, { complete: false }))
    expect(mirrored()).toEqual([['flow', 'running']])
    streamed(ENV_A, set(3, { [OTHER_WT]: [record('new')] }, { complete: false }))
    expect(mirrored()).toEqual([['flow', 'running']])
    expect(mirrored(ENV_A, OTHER_WT)).toEqual([['new', 'running']])
    // A record that moved workspace in an incomplete set is not left behind twice.
    streamed(ENV_A, set(4, { [OTHER_WT]: [record('flow')] }, { complete: false }))
    expect(mirrored()).toBeUndefined()
    // A malformed record makes the set incomplete, so it never removes the others.
    streamed(ENV_A, {
      ...set(5, { [OTHER_WT]: [record('new'), { tabId: 'broken' } as never] })
    })
    expect(mirrored(ENV_A, OTHER_WT)).toEqual([
      ['flow', 'running'],
      ['new', 'running']
    ])
  })

  // Minor (a): a workflow belongs to the window, so no process census decides its close.
  it('propagates a close while the workspace’s terminal membership is unverified', () => {
    listed(ENV_A, set(1, { [WT]: [record('flow'), record('kept')] }))
    decideWebSessionTabsSnapshot(frame({ membershipUnverified: true }), ENV_A, 'subscribeAll')
    streamed(ENV_A, set(2, { [WT]: [record('kept')] }))
    expect(mirrored()).toEqual([['kept', 'running']])
  })

  it('keeps workflows when the owner removes the workspace’s terminal snapshot', () => {
    listed(ENV_A, set(1, { [WT]: [record('flow')] }))
    decideWebSessionTabsSnapshot(
      { ...frame({ snapshotVersion: 0 }), removed: true } as RuntimeMobileSessionTabsResult,
      ENV_A,
      'subscribeAll'
    )
    expect(mirrored()).toEqual([['flow', 'running']])
  })

  // Minor (g): as step 3 orders generations, only a fresh connection switches and retires.
  it('switches controller generation only on a fresh connection, then fences the old one', () => {
    listed(ENV_A, set(7, { [WT]: [record('flow', { status: 'done' })] }))
    // A later event on a running stream cannot carry a new generation; it is ignored.
    streamed(ENV_A, set(1, { [WT]: [] }, { generation: 'gen-2' }))
    expect(mirrored()).toEqual([['flow', 'done']])
    // The old generation was not retired by that ignored set.
    streamed(ENV_A, set(8, { [WT]: [record('flow', { status: 'failed' })] }))
    expect(mirrored()).toEqual([['flow', 'failed']])

    // The owner restarted: the inventory a reconnect replays opens the stream, so it switches.
    applyMirroredWorkflowRecords(
      ENV_A,
      set(1, { [WT]: [record('flow', { status: 'needs-you' })] }, { generation: 'gen-2' }),
      { fresh: true, source: 'subscribeAll-inventory' }
    )
    expect(mirrored()).toEqual([['flow', 'needs-you']])
    // Later events of the new generation apply; late sets of the old one stay fenced.
    streamed(ENV_A, set(2, { [WT]: [record('flow', { status: 'done' })] }, { generation: 'gen-2' }))
    listed(ENV_A, set(9, { [WT]: [record('flow', { status: 'running' })] }))
    expect(mirrored()).toEqual([['flow', 'done']])
  })

  // Minor (m4): between complete sets the stream sends only the workspaces that changed.
  it('applies a delta on a complete base at least as new as its own, and nothing else', () => {
    listed(ENV_A, set(3, { [WT]: [record('flow')], [OTHER_WT]: [record('other')] }))
    const delta = (revision: number, baseRevision: number, changed: object) => ({
      generation: 'gen-1',
      revision,
      baseRevision,
      complete: true,
      changedByWorktree: changed
    })
    streamed(ENV_A, delta(4, 3, { [WT]: [record('flow', { archived: true })] }) as never)
    expect(mirrored()).toEqual([['flow', 'running']])
    expect(
      useAppStore.getState().mirroredWorkflowRecordsByOwner[mirroredWorkflowBucketKey(ENV_A, WT)]
        ?.records[0]?.archived
    ).toBe(true)
    expect(mirrored(ENV_A, OTHER_WT)).toEqual([['other', 'running']])
    // A workspace whose list empties leaves; a delta whose base this receiver never reached does not apply.
    streamed(ENV_A, delta(5, 4, { [OTHER_WT]: [] }) as never)
    expect(mirrored(ENV_A, OTHER_WT)).toBeUndefined()
    streamed(ENV_A, delta(9, 7, { [WT]: [] }) as never)
    expect(mirrored()).toEqual([['flow', 'running']])
    // A late delta (already covered) is ignored.
    streamed(ENV_A, delta(5, 4, { [OTHER_WT]: [record('other')] }) as never)
    expect(mirrored(ENV_A, OTHER_WT)).toBeUndefined()
  })

  // Minor (m3): an owner that sent sets and now answers a fresh connection with none.
  it('keeps a downgraded owner’s rows but stops vouching for them', () => {
    listed(ENV_A, set(2, { [WT]: [record('flow', { status: 'done' })] }))
    applyMirroredWorkflowRecords(ENV_A, undefined, {
      fresh: true,
      source: 'subscribeAll-inventory'
    })
    const bucket =
      useAppStore.getState().mirroredWorkflowRecordsByOwner[mirroredWorkflowBucketKey(ENV_A, WT)]
    expect(bucket).toMatchObject({ unverified: true, records: [{ tabId: 'flow', status: 'done' }] })
    // A later event without a set on a running stream is no downgrade evidence.
    listed(ENV_B, undefined)
    expect(mirrored(ENV_B)).toBeUndefined()
  })

  // Mixed versions, new receiver against an old owner: nothing new, nothing removed.
  it('shows nothing new for an owner that sends no set, and keeps what it has on one', () => {
    listed(ENV_A, undefined)
    expect(useAppStore.getState().mirroredWorkflowRecordsByOwner).toEqual({})
    listed(ENV_B, set(1, { [WT]: [record('flow')] }))
    listed(ENV_B, undefined)
    expect(mirrored(ENV_B)).toEqual([['flow', 'running']])
  })

  it('keeps owner buckets apart, and retracts only a removed environment', () => {
    listed(ENV_A, set(1, { [WT]: [record('a-flow')] }))
    listed(ENV_B, set(1, { [WT]: [record('b-flow')] }, { generation: 'gen-b' }))
    streamed(ENV_B, set(2, {}, { generation: 'gen-b' }))
    expect(mirrored(ENV_A)).toEqual([['a-flow', 'running']])
    expect(mirrored(ENV_B)).toBeUndefined()

    listed(ENV_B, set(3, { [WT]: [record('b-flow')] }, { generation: 'gen-b' }))
    retractMirroredWorkflowEnvironment(ENV_B)
    expect(mirrored(ENV_B)).toBeUndefined()
    expect(mirrored(ENV_A)).toEqual([['a-flow', 'running']])
  })
})
