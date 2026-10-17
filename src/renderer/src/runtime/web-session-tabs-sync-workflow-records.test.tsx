// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tagRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import type { RuntimeSessionWorkflowRecordSet } from '../../../shared/session-workflow-records'

const mocks = vi.hoisted(() => ({ runtimeSessionMirrorEnvironmentKey: vi.fn() }))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: mocks.runtimeSessionMirrorEnvironmentKey
}))
vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: async (_state: unknown, snapshot: unknown) =>
    snapshot
}))

import { useAppStore } from '@/store'
import { mirroredWorkflowBucketKey } from '@/store/slices/mirrored-workflow-records'
import type { AppState } from '@/store/types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
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
const runtimeCall = vi.fn(async () => ({
  id: 'call',
  ok: true as const,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-a' }
}))

function workflowSet(
  generation: string,
  revision: number,
  tabIds: string[]
): RuntimeSessionWorkflowRecordSet {
  return {
    generation,
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
  }
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

function mirroredTabIds(): string[] | undefined {
  return useAppStore
    .getState()
    .mirroredWorkflowRecordsByOwner[mirroredWorkflowBucketKey(ENV, WT)]?.records.map(
      (record) => record.tabId
    )
}

describe('workflow sets on the subscribeAll stream (step 9)', () => {
  beforeEach(() => {
    subscriptions.length = 0
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(
      `${ENV}\u0001runtime-a\u00010\u0001${REVISION}`
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    const runtimeEnvironments = [
      { id: ENV, createdAt: 100, pairingRevision: REVISION }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        workspaceSessionReady: true,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId: new Map([
          [ENV, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
        ]) as AppState['runtimeStatusByEnvironmentId']
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

  // MAJOR (re-review): the inventory replayed after a reconnect opens the stream again; a
  // restarted owner's new generation must take over there, or its rows freeze.
  it('takes a restarted owner’s new generation from the inventory a reconnect replays', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    await publish({
      type: 'snapshots',
      snapshots: [],
      workflowRecords: workflowSet('gen-1', 3, ['old'])
    })
    await publish({ type: 'workflowRecords', ...workflowSet('gen-1', 4, ['old', 'second']) })
    expect(mirroredTabIds()).toEqual(['old', 'second'])

    // The owner restarted; the connection resubscribes and tags the first inventory as a replay.
    await publish(
      { type: 'snapshots', snapshots: [], workflowRecords: workflowSet('gen-2', 1, ['new']) },
      true
    )
    expect(mirroredTabIds()).toEqual(['new'])

    await publish({ type: 'workflowRecords', ...workflowSet('gen-2', 2, ['new', 'next']) })
    expect(mirroredTabIds()).toEqual(['new', 'next'])
    // A late set from the old incarnation stays fenced.
    await publish({ type: 'workflowRecords', ...workflowSet('gen-1', 9, ['old']) })
    expect(mirroredTabIds()).toEqual(['new', 'next'])
  })
})
