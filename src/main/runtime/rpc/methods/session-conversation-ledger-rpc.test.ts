import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../omni-runtime'
import {
  RUNTIME_CAPABILITIES,
  SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  sessionConversationIdentity,
  type RuntimeSessionConversationRecord,
  type RuntimeSessionConversationRemoval,
  type SessionConversationLedgerWindowPublication
} from '../../../../shared/session-conversation-ledger'
import type { RuntimeSessionWorkflowRecord } from '../../../../shared/session-workflow-records'
import { conversationLedgerStatusCapabilities } from '../../session-conversation-ledger-runtime'
import { SessionConversationLedgerStore } from '../../session-conversation-ledger-store'
import { SessionWorkflowRecordStore } from '../../session-workflow-record-store'
import type { SessionConversationLedgerFeed } from './session-conversation-ledger'
import { SESSION_TAB_METHODS } from './session-tabs'

const WT = 'repo::/work'
const WT2 = 'repo::/other'
const LEDGER = SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY
const SUBSCRIPTION = 'session.tabs:conn:*:req-1'
const withoutLedger = (list: readonly string[]): string[] =>
  list.filter((capability) => capability !== LEDGER)
// Every remote transport declares the ledger capability with its receiver (session parity, step 5).
const NEW_CLIENT = remoteRuntimeClientCapabilities()
// What a ledger owner's status names: this build's list plus what its running publisher adds.
const OWNER_STATUS = [
  ...RUNTIME_CAPABILITIES,
  ...conversationLedgerStatusCapabilities({ hasOwnerPublisher: () => true })
]
// F25: an old client sends a real list without the ledger capability. Inside one build the repo's
// own lists stand in for the baseline's (the cross-version harness derives it from the baseline
// checkout): what every remote transport declares, and everything a ledger owner's status names.
const OLD_CLIENTS = [withoutLedger(NEW_CLIENT), withoutLedger(OWNER_STATUS)]

function providerRecord(
  id: string,
  overrides: Partial<RuntimeSessionConversationRecord> = {},
  worktreeId = WT
): RuntimeSessionConversationRecord {
  const providerSession = { key: 'session_id' as const, id }
  return {
    conversation: sessionConversationIdentity({ worktreeId, agent: 'claude', providerSession }),
    agent: 'claude',
    providerSession,
    title: `Claude ${id}`,
    titleSource: 'terminal',
    surface: 'record',
    rest: 'asleep',
    listed: true,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

/** A tab whose agent never reported a provider session: known only by its pane. */
const PANE_RECORD: RuntimeSessionConversationRecord = {
  conversation: null,
  paneIdentity: 'pane:tab-1:leaf-1',
  agent: 'codex',
  providerSession: null,
  title: 'Codex',
  titleSource: 'terminal',
  surface: 'tab',
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  rest: 'dormant',
  listed: true,
  updatedAt: 1_700_000_000_000
}

function publication(
  recordsByWorktree: Record<string, RuntimeSessionConversationRecord[]>,
  overrides: Partial<SessionConversationLedgerWindowPublication> = {}
): SessionConversationLedgerWindowPublication {
  return {
    rendererGeneration: 'r1',
    listedAt: 1_700_000_000_500,
    coverage: Object.keys(recordsByWorktree).map((worktreeId) => ({ worktreeId, complete: true })),
    omitted: { unknownHost: 0, unverified: 0 },
    folders: [{ id: 'f1', name: 'Church' }],
    projects: [{ folderId: 'f1' }],
    recordsByWorktree,
    ...overrides
  }
}

function newLedger(first: SessionConversationLedgerWindowPublication) {
  const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
  store.publishWindow(first)
  return store
}

function workflow(overrides: Partial<RuntimeSessionWorkflowRecord> = {}) {
  return {
    tabId: 'flow-tab',
    preset: 'council',
    title: 'Council',
    status: 'unavailable',
    runId: 'run-1',
    ...overrides
  } satisfies RuntimeSessionWorkflowRecord
}

function publishWorkflows(
  store: SessionWorkflowRecordStore,
  records: RuntimeSessionWorkflowRecord[]
) {
  store.publish({ rendererGeneration: 'r', recordsByWorktree: { [WT]: records }, complete: true })
}

function frame(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'renderer:1',
    snapshotVersion: 3,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

/** An owner runtime double: one workspace frame, a subscription registry, and the stores it has. */
function ownerRuntime(
  stores: { ledger?: SessionConversationLedgerFeed; workflows?: SessionWorkflowRecordStore } = {}
) {
  const cleanups = new Map<string, () => void>()
  const runtime = {
    getRuntimeId: () => 'owner',
    restoreStructuredAgentSessionTabs: vi.fn(async () => undefined),
    supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
    listAllMobileSessionTabsInventory: vi.fn(async () => ({
      snapshots: [frame()],
      authoritative: true
    })),
    listAllMobileSessionTabsInventoryWithChangeSequence: vi.fn(async () => ({
      snapshots: [frame()],
      authoritative: true,
      changeSequence: 1
    })),
    listMobileSessionTabs: vi.fn(async () => frame()),
    onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    cleanupSubscription: (id: string) => {
      cleanups.get(id)?.()
      cleanups.delete(id)
    },
    ...(stores.workflows ? { getSessionWorkflowRecordStore: () => stores.workflows } : {}),
    ...(stores.ledger ? { getSessionConversationLedgerStore: () => stores.ledger } : {})
  }
  return runtime as unknown as OrcaRuntimeService
}

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

/** Every raw reply one call produced; a stream keeps appending to the returned list. */
async function dispatch(
  runtime: OrcaRuntimeService,
  method: string,
  clientCapabilities: readonly string[],
  options: { params?: unknown; signal?: AbortSignal } = {}
): Promise<string[]> {
  const messages: string[] = []
  await new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS }).dispatchStreaming(
    request(method, options.params),
    (message) => messages.push(message),
    { clientKind: 'runtime', connectionId: 'conn', clientCapabilities, signal: options.signal }
  )
  return messages
}

function resultsOf(messages: string[]): Record<string, unknown>[] {
  return messages.map((message) => JSON.parse(message).result as Record<string, unknown>)
}

describe('the owner conversation ledger on session.tabs (session parity, step 4)', () => {
  it('puts the whole set beside listAll and the subscribeAll inventory for a negotiated client', async () => {
    const ledger = newLedger(publication({ [WT]: [providerRecord('a'), PANE_RECORD] }))
    const gone = { conversation: providerRecord('gone').conversation!, worktreeId: WT, at: 5 }
    ledger.setRemovals([gone], false)
    const runtime = ownerRuntime({ ledger })

    const [listed] = resultsOf(await dispatch(runtime, 'session.tabs.listAll', NEW_CLIENT))
    expect(listed!.conversationLedger).toEqual(ledger.snapshot())
    expect(ledger.snapshot()).toMatchObject({ source: 'window', revision: 2, removals: [gone] })

    const [inventory] = resultsOf(await dispatch(runtime, 'session.tabs.subscribeAll', NEW_CLIENT))
    expect(inventory!.type).toBe('snapshots')
    expect(inventory!.conversationLedger).toEqual(ledger.snapshot())
  })

  it('projects a main-authored set like a window one, and streams the window closing as a delta', async () => {
    const mainOnly = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    const { rendererGeneration: _generation, ...body } = publication({
      [WT]: [providerRecord('a', { rest: 'dormant' })]
    })
    mainOnly.publishMain(body)
    const runtime = ownerRuntime({ ledger: mainOnly })
    const [listed] = resultsOf(await dispatch(runtime, 'session.tabs.listAll', NEW_CLIENT))
    expect(listed!.conversationLedger).toEqual(mainOnly.snapshot())
    expect(listed!.conversationLedger).toMatchObject({ source: 'main', revision: 1 })
    const windowSet = newLedger(publication({ [WT]: [providerRecord('a')] })).snapshot()
    expect(Object.keys(listed!.conversationLedger as object).sort()).toEqual(
      Object.keys(windowSet).sort()
    )

    // Same generation: a delta naming the new source and every workspace's (now incomplete) coverage.
    const ledger = newLedger(publication({ [WT]: [providerRecord('a')] }))
    const stream = await dispatch(ownerRuntime({ ledger }), 'session.tabs.subscribeAll', NEW_CLIENT)
    ledger.markPublisherGone()
    expect(resultsOf(stream).slice(1)).toEqual([
      {
        type: 'conversationLedger',
        generation: ledger.generation,
        revision: 2,
        baseRevision: 1,
        source: 'main',
        coverage: [{ worktreeId: WT, complete: false }],
        changedByWorktree: {}
      }
    ])
  })

  it('streams an archive mark as a delta of that workspace alone, and folders only when they change', async () => {
    const a = providerRecord('a')
    const b = providerRecord('b', {}, WT2)
    const ledger = newLedger(publication({ [WT]: [a], [WT2]: [b] }))
    const stream = await dispatch(ownerRuntime({ ledger }), 'session.tabs.subscribeAll', NEW_CLIENT)
    const archived = { ...a, archived: { archived: true, byHand: true } }
    const folders = [
      { id: 'f1', name: 'Church' },
      { id: 'f2', name: 'Ads' }
    ]
    const coverage = [
      { worktreeId: WT, complete: true },
      { worktreeId: WT2, complete: true }
    ]

    ledger.publishWindow(publication({ [WT]: [archived], [WT2]: [b] }))
    ledger.publishWindow(publication({ [WT]: [archived], [WT2]: [b] }, { folders }))
    // The other workspace's last conversation went away; the owner still covers it completely.
    ledger.publishWindow(publication({ [WT]: [archived] }, { folders, coverage }))

    const delta = (revision: number, change: object) => ({
      type: 'conversationLedger',
      generation: ledger.generation,
      revision,
      baseRevision: revision - 1,
      source: 'window',
      coverage,
      ...change
    })
    expect(resultsOf(stream).slice(1)).toEqual([
      delta(2, { changedByWorktree: { [WT]: [archived] } }),
      delta(3, { changedByWorktree: {}, folders }),
      delta(4, { changedByWorktree: { [WT2]: [] } })
    ])
  })

  it('carries each new tombstone once, by digest or by pane, against the revision it last delivered', async () => {
    const a = providerRecord('a')
    const ledger = newLedger(publication({ [WT]: [a, PANE_RECORD] }))
    const stream = await dispatch(ownerRuntime({ ledger }), 'session.tabs.subscribeAll', NEW_CLIENT)
    const coverage = [{ worktreeId: WT, complete: true }]
    const deleted: RuntimeSessionConversationRemoval = {
      conversation: a.conversation!,
      worktreeId: WT,
      at: 10
    }
    const paneDeleted: RuntimeSessionConversationRemoval = {
      paneIdentity: PANE_RECORD.paneIdentity!,
      worktreeId: WT,
      at: 11
    }

    // The owner deletes `a`: its window stops listing it, and main adds the tombstone.
    ledger.publishWindow(publication({ [WT]: [PANE_RECORD] }))
    ledger.setRemovals([deleted], false)
    // Then the provider-less conversation: the next delta carries only the newer tombstone.
    ledger.publishWindow(publication({}, { coverage }))
    ledger.setRemovals([deleted, paneDeleted], false)

    const delta = (revision: number, change: object) => ({
      type: 'conversationLedger',
      generation: ledger.generation,
      revision,
      baseRevision: revision - 1,
      source: 'window',
      coverage,
      ...change
    })
    expect(resultsOf(stream).slice(1)).toEqual([
      delta(2, { changedByWorktree: { [WT]: [PANE_RECORD] } }),
      delta(3, { changedByWorktree: {}, removals: [deleted] }),
      delta(4, { changedByWorktree: { [WT]: [] } }),
      delta(5, { changedByWorktree: {}, removals: [paneDeleted] })
    ])
    const late = await dispatch(ownerRuntime({ ledger }), 'session.tabs.subscribeAll', NEW_CLIENT)
    expect(resultsOf(late)[0]!.conversationLedger).toMatchObject({
      removals: [deleted, paneDeleted]
    })
  })

  it('resends the whole set when the owner generation changes', async () => {
    const before = newLedger(publication({ [WT]: [providerRecord('a')] }))
    const after = newLedger(publication({ [WT]: [providerRecord('a', { rest: 'live' })] }))
    let current = before
    const listeners = new Set<() => void>()
    const feed: SessionConversationLedgerFeed = {
      snapshot: () => current.snapshot(),
      removalsSince: (revision) => current.removalsSince(revision),
      onChange: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
    const stream = await dispatch(
      ownerRuntime({ ledger: feed }),
      'session.tabs.subscribeAll',
      NEW_CLIENT
    )

    // The owner restarted: the same revision number under a new generation.
    current = after
    listeners.forEach((listener) => listener())

    expect(after.snapshot().revision).toBe(before.snapshot().revision)
    expect(resultsOf(stream).slice(1)).toEqual([
      { type: 'conversationLedger', ...after.snapshot() }
    ])
  })

  it('resends the whole set when a delta could not say what changed', async () => {
    const tombstone = { conversation: providerRecord('gone').conversation!, worktreeId: WT, at: 5 }
    const omitted = { unknownHost: 1, unverified: 0 }
    const ledger = newLedger(publication({ [WT]: [providerRecord('a')] }))
    ledger.setRemovals([tombstone], false)
    const stream = await dispatch(ownerRuntime({ ledger }), 'session.tabs.subscribeAll', NEW_CLIENT)
    const expected: unknown[] = []
    const wholeSet = () => expected.push({ type: 'conversationLedger', ...ledger.snapshot() })

    // An undo withdraws the tombstone, which a delta (it only adds removals) cannot say.
    ledger.setRemovals([], false)
    wholeSet()
    ledger.publishWindow(publication({ [WT]: [providerRecord('a')] }, { omitted }))
    wholeSet()
    ledger.setRemovals([tombstone], true)
    wholeSet()
    // Once the set said its removals were cut, each delta repeats it.
    const live = providerRecord('a', { rest: 'live' })
    ledger.publishWindow(publication({ [WT]: [live] }, { omitted }))
    expected.push({
      type: 'conversationLedger',
      generation: ledger.generation,
      revision: 6,
      baseRevision: 5,
      source: 'window',
      coverage: [{ worktreeId: WT, complete: true }],
      changedByWorktree: { [WT]: [live] },
      removalsTruncated: true
    })

    expect(resultsOf(stream).slice(1)).toEqual(expected)
  })

  it('stops watching at the stream end and on abort', async () => {
    const ledger = newLedger(publication({ [WT]: [providerRecord('a')] }))
    // A feed double: each stream's unsubscribe is observed, never the store's internals.
    const unsubscribes: ReturnType<typeof vi.fn>[] = []
    const feed: SessionConversationLedgerFeed = {
      snapshot: () => ledger.snapshot(),
      removalsSince: (revision) => ledger.removalsSince(revision),
      onChange: (listener) => {
        const unsubscribe = vi.fn(ledger.onChange(listener))
        unsubscribes.push(unsubscribe)
        return unsubscribe
      }
    }
    const runtime = ownerRuntime({ ledger: feed })
    const ended = await dispatch(runtime, 'session.tabs.subscribeAll', NEW_CLIENT)
    const controller = new AbortController()
    const aborted = await dispatch(
      ownerRuntime({ ledger: feed }),
      'session.tabs.subscribeAll',
      NEW_CLIENT,
      { signal: controller.signal }
    )
    expect(unsubscribes.map((unsubscribe) => unsubscribe.mock.calls.length)).toEqual([0, 0])

    runtime.cleanupSubscription(SUBSCRIPTION)
    expect(unsubscribes.map((unsubscribe) => unsubscribe.mock.calls.length)).toEqual([1, 0])
    controller.abort()
    ledger.publishWindow(publication({ [WT]: [providerRecord('a', { rest: 'live' })] }))

    expect(resultsOf(ended).map((result) => result.type)).toEqual(['snapshots', 'end'])
    expect(resultsOf(aborted).map((result) => result.type)).toEqual(['snapshots'])
    expect(unsubscribes.map((unsubscribe) => unsubscribe.mock.calls.length)).toEqual([1, 1])
  })

  // F25, mixed versions (old client, new owner): today's projection byte for byte, on every path.
  it('gives an old client exactly what an owner without a ledger gives, through every later event', async () => {
    // The old clients are derived from a ledger owner's status, which names the capability.
    expect(OWNER_STATUS).toContain(LEDGER)
    for (const oldClient of OLD_CLIENTS) {
      expect(oldClient.length).toBeGreaterThan(0)
      const a = providerRecord('a')
      const workflows = new SessionWorkflowRecordStore()
      publishWorkflows(workflows, [workflow()])
      const ledger = newLedger(publication({ [WT]: [a, PANE_RECORD] }))
      ledger.setRemovals(
        [{ paneIdentity: PANE_RECORD.paneIdentity!, worktreeId: WT, at: 9 }],
        false
      )
      const withLedger = ownerRuntime({ ledger, workflows })
      const withoutStore = ownerRuntime({ workflows })
      for (const [method, params] of [
        ['session.tabs.listAll', undefined],
        ['session.tabs.list', { worktree: `id:${WT}` }]
      ] as const) {
        expect(await dispatch(withLedger, method, oldClient, { params })).toEqual(
          await dispatch(withoutStore, method, oldClient, { params })
        )
      }

      const served = await dispatch(withLedger, 'session.tabs.subscribeAll', oldClient)
      const today = await dispatch(withoutStore, 'session.tabs.subscribeAll', oldClient)
      ledger.publishWindow(publication({ [WT]: [{ ...a, archived: { archived: true } }] }))
      ledger.setRemovals([], false)
      ledger.markPublisherGone()
      publishWorkflows(workflows, [workflow({ status: 'done' })])

      expect(served).toEqual(today)
      expect(resultsOf(served).map((result) => result.type)).toEqual([
        'snapshots',
        'workflowRecords'
      ])
      expect(served.join('\n')).not.toMatch(
        new RegExp(`conversationLedger|removals|pane:tab-1|${a.conversation}`)
      )
    }
  })

  it('keeps the workflow publication byte-identical with and without the ledger capability', async () => {
    const workflows = new SessionWorkflowRecordStore()
    publishWorkflows(workflows, [workflow()])
    const ledger = newLedger(publication({ [WT]: [providerRecord('a')] }))
    const runtime = ownerRuntime({ ledger, workflows })
    const dropLedger = (message: string): string => {
      const { conversationLedger: _ledger, ...result } = JSON.parse(message).result
      return JSON.stringify({ ...JSON.parse(message), result })
    }
    const isLedgerEvent = (message: string) =>
      JSON.parse(message).result.type === 'conversationLedger'

    const [listedWith] = await dispatch(runtime, 'session.tabs.listAll', NEW_CLIENT)
    const [listedWithout] = await dispatch(
      runtime,
      'session.tabs.listAll',
      withoutLedger(NEW_CLIENT)
    )
    expect(dropLedger(listedWith!)).toBe(listedWithout)

    const withCapability = await dispatch(runtime, 'session.tabs.subscribeAll', NEW_CLIENT)
    const withoutCapability = await dispatch(
      runtime,
      'session.tabs.subscribeAll',
      withoutLedger(NEW_CLIENT)
    )
    publishWorkflows(workflows, [workflow({ status: 'done' })])
    ledger.publishWindow(publication({ [WT]: [providerRecord('a', { rest: 'live' })] }))
    workflows.markPublisherGone()

    expect(withCapability.filter(isLedgerEvent)).toHaveLength(1)
    expect([
      dropLedger(withCapability[0]!),
      ...withCapability.slice(1).filter((message) => !isLedgerEvent(message))
    ]).toEqual(withoutCapability)
    expect(resultsOf(withoutCapability).map((result) => result.type)).toEqual([
      'snapshots',
      'workflowRecords',
      'workflowRecords'
    ])
  })
})
