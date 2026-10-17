// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tagRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import type {
  RuntimeSessionConversationLedger,
  RuntimeSessionConversationLedgerDelta,
  RuntimeSessionConversationRecord
} from '../../../shared/session-conversation-ledger'

const mocks = vi.hoisted(() => ({ runtimeSessionMirrorEnvironmentKey: vi.fn() }))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: mocks.runtimeSessionMirrorEnvironmentKey
}))
vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: async (_state: unknown, snapshot: unknown) =>
    snapshot
}))

import { useAppStore } from '@/store'
import { mirroredConversationBucketKey } from '@/store/slices/mirrored-conversation-ledger'
import type { AppState } from '@/store/types'
import { SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { resetMirroredOwnerSnapshotPersistenceForTests } from './mirrored-owner-snapshot-persistence'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'

const ENV = 'env-a'
const REVISION = 101
const WT = 'repo-a::/work'
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
const subscriptions: {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
}[] = []
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  subscriptions.push({ request, callbacks })
  return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
})
let listAllResult: Record<string, unknown> = { snapshots: [] }
const runtimeCall = vi.fn(async () => ({
  id: 'call',
  ok: true as const,
  result: listAllResult,
  _meta: { runtimeId: 'runtime-a' }
}))

function digest(n: number): string {
  return n.toString(16).padStart(24, '0')
}

function record(n: number): RuntimeSessionConversationRecord {
  return {
    conversation: digest(n),
    agent: 'claude',
    providerSession: { key: 'session_id', id: `session-${n}` },
    title: `conversation ${n}`,
    titleSource: 'custom',
    surface: 'record',
    rest: 'asleep',
    listed: true,
    updatedAt: n
  }
}

function ledger(
  generation: string,
  revision: number,
  conversations: number[],
  overrides: Partial<RuntimeSessionConversationLedger> = {}
): RuntimeSessionConversationLedger {
  return {
    generation,
    revision,
    source: 'window',
    listedAt: 1_000 + revision,
    coverage: [{ worktreeId: WT, complete: true }],
    omitted: { unknownHost: 0, unverified: 0 },
    folders: [],
    projects: [],
    recordsByWorktree: { [WT]: conversations.map(record) },
    removals: [],
    ...overrides
  }
}

function delta(
  revision: number,
  baseRevision: number,
  conversations: number[]
): RuntimeSessionConversationLedgerDelta {
  return {
    generation: 'gen-1',
    revision,
    baseRevision,
    source: 'window',
    coverage: [{ worktreeId: WT, complete: true }],
    changedByWorktree: { [WT]: conversations.map(record) }
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve()
    }
  })
}

async function publish(result: unknown, replayed = false): Promise<void> {
  const subscription = subscriptions.find(
    ({ request }) => request.method === 'session.tabs.subscribeAll' && request.selector === ENV
  )!
  await act(async () => {
    const response = { id: 'event', ok: true as const, result, _meta: { runtimeId: 'runtime-a' } }
    subscription.callbacks.onResponse(
      replayed ? tagRuntimeSubscriptionReplayResponse(response) : response
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

function mirrored(): string[] | undefined {
  return useAppStore
    .getState()
    .mirroredConversationLedgerByOwner[mirroredConversationBucketKey(ENV, WT)]?.records.map(
      (entry) => entry.conversation ?? ''
    )
}

/** The owner's runtime status: a desktop owner names the ledger capability, orcad never does. */
function ownerStatus(capabilities: string[]): AppState['runtimeStatusByEnvironmentId'] {
  return new Map([
    [ENV, { status: { runtimeId: 'runtime-a', capabilities }, connectionGeneration: 1 }]
  ]) as AppState['runtimeStatusByEnvironmentId']
}

describe('the owner conversation ledger on the session-tabs stream (session parity, step 5)', () => {
  beforeEach(() => {
    subscriptions.length = 0
    listAllResult = { snapshots: [] }
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(
      `${ENV}\u0001runtime-a\u00010\u0001${REVISION}`
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetMirroredOwnerSnapshotPersistenceForTests()
    const runtimeEnvironments = [
      { id: ENV, createdAt: 100, pairingRevision: REVISION }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        workspaceSessionReady: true,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId: ownerStatus([
          SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY
        ])
      },
      true
    )
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  it('takes the set from the initial listAll, then moves on the stream’s sets and deltas', async () => {
    listAllResult = { snapshots: [], conversationLedger: ledger('gen-1', 2, [1, 2]) }
    renderHook(() => useWebSessionTabsSync())
    await settle()
    expect(mirrored()).toEqual([digest(1), digest(2)])
    expect(useAppStore.getState().mirroredConversationOwnersByEnvironment[ENV]?.state).toBe('ready')

    await publish({
      type: 'snapshots',
      snapshots: [],
      conversationLedger: ledger('gen-1', 3, [1, 2, 3])
    })
    expect(mirrored()).toEqual([digest(1), digest(2), digest(3)])

    await publish({ type: 'conversationLedger', ...delta(4, 3, [1, 3]) })
    expect(mirrored()).toEqual([digest(1), digest(3)])

    // A whole set whose incomplete workspace removes only what a tombstone names.
    await publish({
      type: 'conversationLedger',
      ...ledger('gen-1', 5, [3], {
        coverage: [{ worktreeId: WT, complete: false }],
        removals: [{ conversation: digest(1), worktreeId: WT, at: 10 }]
      })
    })
    expect(mirrored()).toEqual([digest(3)])
  })

  it('survives a reconnect: a restarted owner’s replayed inventory reorders but removes nothing', async () => {
    listAllResult = { snapshots: [], conversationLedger: ledger('gen-1', 3, [1, 2]) }
    renderHook(() => useWebSessionTabsSync())
    await settle()
    expect(mirrored()).toEqual([digest(1), digest(2)])

    // The owner restarted with its window still loading; the connection resubscribes.
    await publish(
      {
        type: 'snapshots',
        snapshots: [],
        conversationLedger: ledger('gen-2', 1, [1], {
          coverage: [{ worktreeId: WT, complete: false }]
        })
      },
      true
    )
    // Membership, order aside: the merge's record order is no contract.
    expect([...(mirrored() ?? [])].sort()).toEqual([digest(1), digest(2)])

    await publish({ type: 'conversationLedger', ...ledger('gen-2', 2, [1]) })
    expect(mirrored()).toEqual([digest(1)])
    // A late set from the old incarnation stays fenced.
    await publish({ type: 'conversationLedger', ...ledger('gen-1', 9, [1, 2]) })
    expect(mirrored()).toEqual([digest(1)])
  })

  it('leaves an owner without the ledger as today, marked older', async () => {
    renderHook(() => useWebSessionTabsSync())
    await settle()
    await publish({ type: 'snapshots', snapshots: [] })
    expect(useAppStore.getState().mirroredConversationLedgerByOwner).toEqual({})
    expect(useAppStore.getState().mirroredConversationOwnersByEnvironment[ENV]).toMatchObject({
      state: 'older',
      generation: null
    })
  })

  // An orcad owner runs no ledger publisher, so its status never names the capability, yet it
  // answers a negotiated client with an empty revision-0 set from a store nothing publishes to.
  it('reads an owner whose status lacks the capability as older, whatever the field holds', async () => {
    useAppStore.setState({ runtimeStatusByEnvironmentId: ownerStatus([]) })
    listAllResult = { snapshots: [], conversationLedger: ledger('gen-1', 2, [1, 2]) }
    renderHook(() => useWebSessionTabsSync())
    await settle()
    expect(useAppStore.getState().mirroredConversationLedgerByOwner).toEqual({})
    expect(useAppStore.getState().mirroredConversationOwnersByEnvironment[ENV]).toMatchObject({
      state: 'older',
      generation: null
    })

    await publish({
      type: 'snapshots',
      snapshots: [],
      conversationLedger: ledger('gen-1', 0, [], { source: 'main', coverage: [] })
    })
    await publish({ type: 'conversationLedger', ...delta(1, 0, [1]) })
    expect(useAppStore.getState().mirroredConversationLedgerByOwner).toEqual({})
    expect(useAppStore.getState().mirroredConversationOwnersByEnvironment[ENV]?.state).toBe('older')
  })

  it('reads a revision-0 set as no ledger yet, then takes the first publication on base 0', async () => {
    listAllResult = {
      snapshots: [],
      conversationLedger: ledger('gen-1', 0, [], { source: 'main', coverage: [] })
    }
    renderHook(() => useWebSessionTabsSync())
    await settle()
    expect(useAppStore.getState().mirroredConversationOwnersByEnvironment[ENV]?.state).toBe('older')

    await publish({ type: 'conversationLedger', ...delta(1, 0, [1, 2]) })
    expect(mirrored()).toEqual([digest(1), digest(2)])
    expect(useAppStore.getState().mirroredConversationOwnersByEnvironment[ENV]).toMatchObject({
      state: 'ready',
      generation: 'gen-1',
      revision: 1
    })
  })
})
