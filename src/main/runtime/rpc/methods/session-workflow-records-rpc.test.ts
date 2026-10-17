import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrcaRuntimeService } from '../../omni-runtime'
import {
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  SESSION_WORKFLOW_NOT_FOUND_CODE,
  SESSION_WORKFLOW_OPEN_RPC,
  SESSION_WORKFLOW_UNVERIFIABLE_CODE,
  type RuntimeSessionWorkflowRecord
} from '../../../../shared/session-workflow-records'
import { SessionWorkflowRecordStore } from '../../session-workflow-record-store'
import { SESSION_TAB_METHODS } from './session-tabs'

const WT = 'repo::/work'
const NEGOTIATED = [
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY
]
// The baseline's own list minus this capability: a client too old to know it.
const OLD_CLIENT = remoteRuntimeClientCapabilities().filter(
  (capability) => capability !== SESSION_TABS_WORKFLOW_RECORDS_RUNTIME_CAPABILITY
)

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function snapshot(): RuntimeMobileSessionTabsResult {
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

function record(overrides: Partial<RuntimeSessionWorkflowRecord> = {}) {
  return {
    tabId: 'flow-tab',
    preset: 'council',
    title: 'Council',
    status: 'unavailable',
    runId: 'run-1',
    ...overrides
  } satisfies RuntimeSessionWorkflowRecord
}

function publish(store: SessionWorkflowRecordStore, records: RuntimeSessionWorkflowRecord[]) {
  store.publish({ rendererGeneration: 'r', recordsByWorktree: { [WT]: records }, complete: true })
}

function inventoryRuntime(store: SessionWorkflowRecordStore | null) {
  const runtime = {
    getRuntimeId: () => 'owner',
    supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
    listAllMobileSessionTabsInventory: vi.fn(async () => ({
      snapshots: [snapshot()],
      authoritative: true
    })),
    listAllMobileSessionTabsInventoryWithChangeSequence: vi.fn(async () => ({
      snapshots: [snapshot()],
      authoritative: true,
      changeSequence: 1
    })),
    listMobileSessionTabs: vi.fn(async () => snapshot()),
    onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    ...(store ? { getSessionWorkflowRecordStore: () => store } : {})
  }
  return runtime as unknown as OrcaRuntimeService
}

async function call(
  runtime: OrcaRuntimeService,
  method: string,
  clientCapabilities: string[],
  params?: unknown
): Promise<{ ok: boolean; result?: unknown; error?: { code: string; data?: unknown } }[]> {
  const messages: string[] = []
  await new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS }).dispatchStreaming(
    makeRequest(method, params),
    (message) => messages.push(message),
    { clientKind: 'runtime', connectionId: 'conn', clientCapabilities }
  )
  return messages.map((message) => JSON.parse(message))
}

describe('controller-owned workflow records on session.tabs (step 9)', () => {
  it('puts the whole set beside a listAll inventory for a negotiated client', async () => {
    const store = new SessionWorkflowRecordStore()
    publish(store, [record()])

    const [response] = await call(inventoryRuntime(store), 'session.tabs.listAll', NEGOTIATED)

    expect((response!.result as { workflowRecords: unknown }).workflowRecords).toEqual({
      generation: store.generation,
      revision: 1,
      complete: true,
      recordsByWorktree: { [WT]: [record()] }
    })
  })

  // Mixed versions, old client against new owner: exactly today's projection.
  it('gives a client that did not negotiate exactly what an owner without records gives', async () => {
    const store = new SessionWorkflowRecordStore()
    publish(store, [record()])
    for (const [method, params] of [
      ['session.tabs.listAll', undefined],
      ['session.tabs.list', { worktree: `id:${WT}` }]
    ] as const) {
      expect(await call(inventoryRuntime(store), method, OLD_CLIENT, params)).toEqual(
        await call(inventoryRuntime(null), method, OLD_CLIENT, params)
      )
    }
  })

  it('streams each later change in order, only to a negotiated client', async () => {
    const store = new SessionWorkflowRecordStore()
    publish(store, [record()])
    const negotiated: string[] = []
    const old: string[] = []
    for (const [messages, clientCapabilities] of [
      [negotiated, NEGOTIATED],
      [old, OLD_CLIENT]
    ] as const) {
      await new RpcDispatcher({
        runtime: inventoryRuntime(store),
        methods: SESSION_TAB_METHODS
      }).dispatchStreaming(
        makeRequest('session.tabs.subscribeAll'),
        (message) => messages.push(message),
        { clientKind: 'runtime', connectionId: 'conn', clientCapabilities }
      )
    }

    publish(store, [record({ status: 'done' })])
    publish(store, [])
    store.markPublisherGone()

    const events = negotiated.map((message) => JSON.parse(message).result)
    expect(events[0]).toMatchObject({ type: 'snapshots', workflowRecords: { revision: 1 } })
    // Minor (m4): between complete sets only the changed workspaces travel, against the last
    // delivered revision; a completeness change resends the whole set.
    expect(events.slice(1)).toEqual([
      {
        type: 'workflowRecords',
        generation: store.generation,
        revision: 2,
        baseRevision: 1,
        complete: true,
        changedByWorktree: { [WT]: [record({ status: 'done' })] }
      },
      {
        type: 'workflowRecords',
        generation: store.generation,
        revision: 3,
        baseRevision: 2,
        complete: true,
        changedByWorktree: { [WT]: [] }
      },
      {
        type: 'workflowRecords',
        generation: store.generation,
        revision: 4,
        complete: false,
        recordsByWorktree: {}
      }
    ])
    expect(old).toHaveLength(1)
    expect(JSON.parse(old[0]!).result).not.toHaveProperty('workflowRecords')
  })
})

describe('session.workflows.open (step 9)', () => {
  function openRuntime(store: SessionWorkflowRecordStore | null, revealed = true) {
    const reveal = vi.fn(() => revealed)
    const runtime = {
      getRuntimeId: () => 'owner',
      ...(store ? { getSessionWorkflowRecordStore: () => store } : {}),
      revealSessionWorkflowConversation: reveal,
      createMobileSessionTerminal: vi.fn(),
      activateMobileSessionTab: vi.fn()
    }
    return { runtime, reveal }
  }

  async function open(runtime: object, params: unknown) {
    const [response] = await call(
      runtime as OrcaRuntimeService,
      SESSION_WORKFLOW_OPEN_RPC,
      NEGOTIATED,
      params
    )
    return response!
  }

  it('opens through the owner window’s host focus and creates no terminal', async () => {
    const runtime = new OrcaRuntimeService()
    const focusTerminal = vi.fn()
    runtime.setNotifier({ focusTerminal } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], rendererGeneration: 'r1' })
    runtime.syncSessionWorkflowRecords(1, {
      rendererGeneration: 'r1',
      recordsByWorktree: { [WT]: [record()] }
    })
    const createTerminal = vi.spyOn(runtime, 'createMobileSessionTerminal')

    expect(await open(runtime, { worktree: WT, tabId: 'flow-tab' })).toMatchObject({
      ok: true,
      result: { opened: true }
    })
    // The window's handler is focusTerminalFromHost: select the anchor tab, no pane, no PTY.
    expect(focusTerminal).toHaveBeenCalledWith('flow-tab', WT, null)
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('refuses one its complete publication omits, and a retryable one it cannot verify or show', async () => {
    const store = new SessionWorkflowRecordStore()
    const unpublished = openRuntime(store)
    expect(await open(unpublished.runtime, { worktree: WT, tabId: 'flow-tab' })).toMatchObject({
      ok: false,
      error: { code: SESSION_WORKFLOW_UNVERIFIABLE_CODE, data: { retryable: true } }
    })

    publish(store, [record()])
    const gone = openRuntime(store)
    expect(await open(gone.runtime, { worktree: WT, tabId: 'other-tab' })).toMatchObject({
      ok: false,
      error: { code: SESSION_WORKFLOW_NOT_FOUND_CODE, data: { retryable: false } }
    })

    const windowless = openRuntime(store, false)
    expect(await open(windowless.runtime, { worktree: WT, tabId: 'flow-tab' })).toMatchObject({
      ok: false,
      error: { code: SESSION_WORKFLOW_UNVERIFIABLE_CODE }
    })
    for (const { reveal } of [unpublished, gone]) {
      expect(reveal).not.toHaveBeenCalled()
    }
  })
})
