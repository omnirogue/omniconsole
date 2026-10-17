import { beforeEach, describe, expect, it } from 'vitest'
import { setRuntimeEnvironmentConnectionGenerationForTests } from '@/store/slices/runtime-status'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { SessionTabsInventoryOrder } from '../../../shared/session-tabs-inventory-order'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  applyFreshWebSessionTabsSnapshot,
  clearWebSessionTabsTrackingForEnvironment,
  decideWebSessionTabsSnapshot,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import { decideOrderedSessionTabsFrame } from './session-tabs-inventory-order-fence'
import {
  LEAF_ID,
  NOW,
  WT,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const ENV = 'env-studio'
const G1 = { generation: 'gen-1' }
const G2 = { generation: 'gen-2' }

type FrameOptions = {
  epoch?: string
  version?: number
  order?: (typeof G1 & { revision: number; projectionRevision?: number }) | null
  titles?: Record<string, string>
  worktree?: string
}

function frame(
  hostTabIds: readonly string[],
  options: FrameOptions = {}
): RuntimeMobileSessionTabsResult {
  const worktree = options.worktree ?? WT
  const order: SessionTabsInventoryOrder | undefined = options.order ?? undefined
  return {
    worktree,
    publicationEpoch: options.epoch ?? 'renderer:a',
    snapshotVersion: options.version ?? 1,
    activeGroupId: null,
    activeTabId: hostTabIds[0] ? `${hostTabIds[0]}::${LEAF_ID}` : null,
    activeTabType: hostTabIds.length > 0 ? 'terminal' : null,
    tabs: hostTabIds.map((hostTabId, index) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF_ID}`,
      parentTabId: hostTabId,
      leafId: LEAF_ID,
      title: options.titles?.[hostTabId] ?? `Session ${hostTabId}`,
      isActive: index === 0,
      status: 'ready' as const,
      terminal: `${hostTabId}-handle`
    })),
    ...(order ? { inventoryOrder: order } : {})
  }
}

function removal(options: FrameOptions = {}): RuntimeMobileSessionTabsResult {
  return {
    ...frame([], { epoch: 'removed:x', version: 0, ...options }),
    removed: true
  } as RuntimeMobileSessionTabsResult
}

function send(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return { ...state, ...applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, NOW) }
}

function rows(state: WebSessionTabsSyncState, worktree = WT): string[] {
  return (state.tabsByWorktree[worktree] ?? []).map((tab) => tab.id).sort()
}

function titles(state: WebSessionTabsSyncState): string[] {
  return (state.tabsByWorktree[WT] ?? []).map((tab) => tab.title).sort()
}

const tabRow = (hostTabId: string): string => toWebTerminalSurfaceTabId(hostTabId)

describe('receiver ordering by inventory generation and revision (step 3)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    setRuntimeEnvironmentConnectionGenerationForTests(ENV, 1)
  })

  it('rejects a delayed, older, different-content frame even under a newer-looking epoch', () => {
    let state = send(makeState(), frame(['a', 'b'], { order: { ...G1, revision: 5 } }))
    // The owner's headless merge minted a new epoch; content changed (b gone, c added).
    state = send(
      state,
      frame(['a', 'c'], { epoch: 'renderer:a:headless-merge:1', order: { ...G1, revision: 7 } })
    )
    expect(rows(state)).toEqual([tabRow('a'), tabRow('c')])

    // The delayed frame from revision 6 arrives last with yet another epoch (legacy accepts it).
    const delayed = frame(['a', 'b'], {
      epoch: 'headless-hydrated:x',
      order: { ...G1, revision: 6 },
      titles: { a: 'stale title' }
    })
    state = send(state, delayed)
    expect(rows(state)).toEqual([tabRow('a'), tabRow('c')])
    expect(titles(state)).not.toContain('stale title')
  })

  it('keeps today’s epoch/version ordering for an owner that sends no metadata', () => {
    let state = send(makeState(), frame(['a', 'b'], { version: 5 }))
    state = send(state, frame(['a', 'c'], { epoch: 'renderer:a:headless-merge:1', version: 7 }))
    // Same epoch, older version: still rejected.
    state = send(state, frame(['a'], { epoch: 'renderer:a:headless-merge:1', version: 6 }))
    expect(rows(state)).toEqual([tabRow('a'), tabRow('c')])
    // A new epoch is accepted by arrival, exactly as before (the weakness step 3 fixes when negotiated).
    state = send(state, frame(['a', 'b'], { epoch: 'headless-hydrated:x', version: 6 }))
    expect(rows(state)).toEqual([tabRow('a'), tabRow('b')])
  })

  it('orders across renderer reload, headless creation, activation and promotion epochs', () => {
    const epochs = [
      'renderer:first',
      'headless:pty-backed:1',
      'headless-hydrated:2',
      'renderer:after-reload',
      'renderer:after-reload:headless-merge:abc'
    ]
    let state = makeState()
    epochs.forEach((epoch, index) => {
      state = send(state, frame([`t${index}`], { epoch, order: { ...G1, revision: index + 1 } }))
      expect(rows(state)).toEqual([tabRow(`t${index}`)])
    })
    // Every earlier epoch's frame, delivered late, is outranked.
    epochs.slice(0, -1).forEach((epoch, index) => {
      state = send(state, frame(['late'], { epoch, order: { ...G1, revision: index + 1 } }))
    })
    expect(rows(state)).toEqual([tabRow('t4')])
  })

  it('fences remove/recreate interleavings with the shared revision and tombstones', () => {
    let state = send(makeState(), frame(['a'], { order: { ...G1, revision: 10 } }))
    state = send(state, removal({ order: { ...G1, revision: 11 } }))
    expect(rows(state)).toEqual([])

    // A frame from before the removal arrives late: it must not resurrect the workspace.
    state = send(state, frame(['a'], { order: { ...G1, revision: 9 } }))
    expect(rows(state)).toEqual([])

    // Re-added within the same generation: newer than the tombstone.
    state = send(state, frame(['b'], { epoch: 'renderer:b', order: { ...G1, revision: 12 } }))
    expect(rows(state)).toEqual([tabRow('b')])

    // The old removal, replayed late, is outranked by the re-addition.
    state = send(state, removal({ order: { ...G1, revision: 11 } }))
    expect(rows(state)).toEqual([tabRow('b')])

    // A genuinely newer removal still removes.
    state = send(state, removal({ order: { ...G1, revision: 13 } }))
    expect(rows(state)).toEqual([])
  })

  it('retires a restarted owner’s previous generation for every workspace', () => {
    const other = 'repo::/other'
    let state = send(makeState(), frame(['a'], { order: { ...G1, revision: 40 } }))
    state = send(state, frame(['o'], { worktree: other, order: { ...G1, revision: 41 } }))
    // Restart: the owner's new runtime id arrives on a fresh connection; revisions start over.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV, 2)
    state = send(state, frame(['n'], { order: { ...G2, revision: 1 } }))
    expect(rows(state)).toEqual([tabRow('n')])

    // A delayed list response from the retired generation, for either workspace, is fenced.
    state = send(state, frame(['a'], { order: { ...G1, revision: 99 } }))
    state = send(state, frame(['stale'], { worktree: other, order: { ...G1, revision: 99 } }))
    expect(rows(state)).toEqual([tabRow('n')])
    expect(rows(state, other)).toEqual([tabRow('o')])
  })

  it('keeps a restarted owner flowing when its clock stepped backwards', () => {
    // The new incarnation's clock is earlier than the old one's; generations carry no time, so
    // nothing reads it as "older", and its frames keep advancing after the restart.
    let state = send(
      makeState(),
      frame(['a'], { order: { generation: 'started-at-T', revision: 9 } })
    )
    setRuntimeEnvironmentConnectionGenerationForTests(ENV, 2)
    const restarted = { generation: 'started-at-T-minus-an-hour' }
    state = send(state, frame(['b'], { order: { ...restarted, revision: 1 } }))
    state = send(state, frame(['b', 'c'], { order: { ...restarted, revision: 2 } }))
    expect(rows(state)).toEqual([tabRow('b'), tabRow('c')])
    state = send(state, frame(['a'], { order: { generation: 'started-at-T', revision: 10 } }))
    expect(rows(state)).toEqual([tabRow('b'), tabRow('c')])
  })

  it('never freezes the live generation out over an anomalous frame on the same connection', () => {
    let state = send(makeState(), frame(['a'], { order: { ...G2, revision: 5 } }))
    // A frame from another incarnation on the same connection: accepted, but nothing retired.
    state = send(state, frame(['x'], { order: { ...G1, revision: 50 } }))
    state = send(state, frame(['a', 'b'], { order: { ...G2, revision: 6 } }))
    expect(rows(state)).toEqual([tabRow('a'), tabRow('b')])
  })

  it('never orders the unpublished placeholder or a receiver-synthesized removal', () => {
    let state = send(makeState(), frame(['a'], { order: { ...G1, revision: 5 } }))
    // Even carrying copied metadata with a newer revision, these stay on the legacy path, so
    // they neither advance the order nor read as a newer normal frame.
    const synthesized: [string, boolean][] = [
      ['none:client-navigation', false],
      ['visibility-inventory-removal', true],
      ['environment-retired', true]
    ]
    synthesized.forEach(([epoch, removed], index) => {
      const forged = {
        ...frame([], { epoch, version: 0, order: { ...G1, revision: 99 } }),
        ...(removed ? { removed: true } : {})
      } as RuntimeMobileSessionTabsResult
      expect(decideOrderedSessionTabsFrame(ENV, forged)).toBeNull()
      // Whatever the legacy (removal/unknown) path does with it, it records no order.
      state = send(state, forged)
      state = send(state, frame(['a'], { order: { ...G1, revision: 6 + index } }))
    })
    // The owner's real frames were still accepted: nothing recorded revision 99.
    expect(rows(state)).toEqual([tabRow('a')])
    expect(
      decideWebSessionTabsSnapshot(
        frame(['a', 'z'], { order: { ...G1, revision: 9 } }),
        ENV,
        undefined,
        undefined,
        null
      ).apply
    ).toBe(true)
  })

  it('orders a client’s navigation separately so it is never discarded', () => {
    const decide = (snapshot: RuntimeMobileSessionTabsResult): boolean =>
      decideWebSessionTabsSnapshot(snapshot, ENV, undefined, undefined, null).apply
    const at = (revision: number, projectionRevision: number) => ({
      order: { ...G1, revision, projectionRevision }
    })
    expect(decide(frame(['a', 'b'], at(3, 0)))).toBe(true)
    // Navigation only: same inventory revision, newer projection revision.
    expect(decide(frame(['b', 'a'], at(3, 1)))).toBe(true)
    // A stale navigation frame (older projection revision) is outranked.
    expect(decide(frame(['a', 'b'], at(3, 0)))).toBe(false)
    // An inventory change carries the client's projection with it and advances even where the
    // legacy folded version reads as older (4 + 0 <= 3 + 1).
    expect(decide(frame(['b', 'a', 'c'], { version: 4, ...at(4, 0) }))).toBe(true)
    // Legacy, the same pair is dropped: same epoch, version 4 <= 4.
    resetWebSessionTabsSyncTestState()
    expect(decide(frame(['a', 'b'], { version: 4 }))).toBe(true)
    expect(decide(frame(['b', 'a', 'c'], { version: 4 }))).toBe(false)
  })

  it('propagates each legitimate change exactly once (a frozen inventory fails)', () => {
    let state = makeState()
    const applied: string[][] = []
    const changes = [['a'], ['a', 'b'], ['b'], ['b', 'c'], ['c']]
    changes.forEach((tabs, index) => {
      const before = state
      state = send(
        state,
        frame(tabs, { epoch: `epoch-${index % 2}`, order: { ...G1, revision: index + 1 } })
      )
      if (state.tabsByWorktree !== before.tabsByWorktree) {
        applied.push(rows(state))
      }
      // The same frame again is a replay, not a second change.
      const replayed = state
      state = send(
        state,
        frame(tabs, { epoch: `epoch-${index % 2}`, order: { ...G1, revision: index + 1 } })
      )
      expect(state.tabsByWorktree).toBe(replayed.tabsByWorktree)
    })
    expect(applied).toEqual(changes.map((tabs) => tabs.map(tabRow).sort()))
  })

  it('reads an environment reset as first frames again, as the epoch/version freshness does', () => {
    let state = send(makeState(), frame(['a'], { order: { ...G1, revision: 8 } }))
    clearWebSessionTabsTrackingForEnvironment(ENV)
    state = { ...state, tabsByWorktree: {}, unifiedTabsByWorktree: {} }
    // A delayed frame from before the reset is still older than what was accepted.
    state = send(state, frame(['stale'], { order: { ...G1, revision: 7 } }))
    expect(rows(state)).toEqual([])
    // Reconnect to the same incarnation: the unchanged workspace comes back at the same revision.
    state = send(state, frame(['a'], { order: { ...G1, revision: 8 } }))
    expect(rows(state)).toEqual([tabRow('a')])
  })

  it('falls back to epoch/version ordering when an owner stops sending metadata', () => {
    let state = send(makeState(), frame(['a'], { order: { ...G1, revision: 8 } }))
    // An older build after a downgrade: new epoch, no metadata.
    state = send(state, frame(['b'], { epoch: 'renderer:old-build', version: 1, order: null }))
    expect(rows(state)).toEqual([tabRow('b')])
  })
})
