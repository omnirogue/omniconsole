import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrcaRuntimeService } from '../../omni-runtime'
import {
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY,
  SESSION_TABS_SCOPED_ABSENCE_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { snapshotAffirmsWorkspaceMembership } from '../../../../shared/session-tabs-absence-evidence'
import { ClientSessionTabSelectionStore } from '../../client-session-tab-selection'
import { SessionConversationLedgerStore } from '../../session-conversation-ledger-store'
import { SESSION_TAB_METHODS } from './session-tabs'
import { listSessionTabsInventory, projectSessionTabsForClient } from './session-tabs-inventory'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('session tabs inventory RPC methods', () => {
  it('withholds an old-client list until the host inventory is authoritative', async () => {
    let resolveInventory!: (value: { snapshots: []; authoritative: true }) => void
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(
        () =>
          new Promise<{ snapshots: []; authoritative: true }>((resolve) => {
            resolveInventory = resolve
          })
      )
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    const pending = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      { clientKind: 'runtime' }
    )
    for (let index = 0; index < 20 && !resolveInventory; index += 1) {
      await Promise.resolve()
    }
    expect(messages).toEqual([])

    resolveInventory({ snapshots: [], authoritative: true })
    await pending

    expect(JSON.parse(messages[0]!).result).toEqual({ snapshots: [] })
  })

  // Why: a census failure only invalidates the emptiness verdict — the runtime
  // degrades to the same scan unlabeled, so a capable client keeps the list
  // (e.g. one configured-but-disconnected SSH host) without a second collect.
  it('serves a capable client an unlabeled list when the census fails', async () => {
    const legacyListAll = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => ({
        snapshots: [
          {
            worktree: 'wt-local',
            publicationEpoch: 'epoch-local',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })),
      listAllMobileSessionTabs: legacyListAll
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      {
        clientKind: 'runtime',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )

    expect(legacyListAll).not.toHaveBeenCalled()
    const result = JSON.parse(messages[0]!).result
    expect(result.snapshots).toEqual([expect.objectContaining({ worktree: 'wt-local' })])
    expect(result.authoritative).toBeUndefined()
  })

  it('propagates disconnect errors to legacy clients', async () => {
    const legacyListAll = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => {
        throw new Error('client_disconnected')
      }),
      listAllMobileSessionTabs: legacyListAll
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      { clientKind: 'runtime' }
    )

    expect(legacyListAll).not.toHaveBeenCalled()
    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: false,
      error: expect.objectContaining({ code: 'runtime_error' })
    })
  })

  it('labels an authoritative inventory only for a client that negotiated it', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => ({
        snapshots: [],
        authoritative: true as const
      }))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      {
        clientKind: 'runtime',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )

    expect(JSON.parse(messages[0]!).result).toEqual({ snapshots: [], authoritative: true })
  })

  // Step 6 (C4): scoped absence evidence is additive and negotiated; a client that did not ask
  // for it keeps today's projection and reads the unlabeled omission as unknown.
  // Step 6 review: every websocket client has a device id, so the owner's placeholder reaches it
  // through the per-device navigation projection, rewritten and re-versioned.
  it('keeps the projected placeholder recognisable with and without the capability', () => {
    const selections = new ClientSessionTabSelectionStore()
    const worktree = 'repo::/restarting'
    const placeholder: RuntimeMobileSessionTabsResult = {
      worktree,
      publicationEpoch: 'none',
      snapshotVersion: 0,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: [],
      membershipUnverified: true
    }
    // The device navigated here before the owner restarted: its selection revision is 1.
    selections.activate(
      {
        ...placeholder,
        publicationEpoch: 'renderer:before-restart',
        tabs: [
          { type: 'markdown', id: 'notes', title: 'notes', filePath: '/n.md', isActive: false }
        ]
      } as RuntimeMobileSessionTabsResult,
      'device-1',
      'notes'
    )
    const projected = selections.project(placeholder, 'device-1')
    expect(projected).toMatchObject({
      publicationEpoch: 'none:client-navigation',
      snapshotVersion: 1,
      membershipUnverified: true
    })

    const negotiated = projectSessionTabsForClient(projected, 'runtime', [
      SESSION_TABS_SCOPED_ABSENCE_RUNTIME_CAPABILITY
    ])
    const legacy = projectSessionTabsForClient(projected, 'runtime', [
      SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY
    ])
    expect(negotiated.membershipUnverified).toBe(true)
    expect(legacy).not.toHaveProperty('membershipUnverified')
    // Either way a receiver reads it as the placeholder, never as complete membership.
    expect(snapshotAffirmsWorkspaceMembership(negotiated)).toBe(false)
    expect(snapshotAffirmsWorkspaceMembership(legacy)).toBe(false)
  })

  it('carries scoped absence evidence only to a client that negotiated it', async () => {
    const marked = {
      worktree: 'repo-ssh::/remote',
      publicationEpoch: 'renderer:1',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: [],
      membershipUnverified: true as const
    }
    const coverage = { unverifiedRepoIds: ['repo-ssh'], unverifiedWorkspaces: [] }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => ({ snapshots: [marked], coverage }))
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const listAll = async (clientCapabilities: string[]): Promise<Record<string, unknown>> => {
      const messages: string[] = []
      await dispatcher.dispatchStreaming(
        makeRequest('session.tabs.listAll'),
        (message) => messages.push(message),
        { clientKind: 'runtime', clientCapabilities }
      )
      return JSON.parse(messages[0]!).result
    }

    expect(
      await listAll([
        SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
        SESSION_TABS_SCOPED_ABSENCE_RUNTIME_CAPABILITY
      ])
    ).toEqual({ snapshots: [marked], coverage })
    const { membershipUnverified: _marker, ...unmarked } = marked
    expect(await listAll([SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY])).toEqual({
      snapshots: [unmarked]
    })
    // The per-workspace list and subscriptions share this projection.
    expect(projectSessionTabsForClient(marked, 'mobile', undefined)).not.toHaveProperty(
      'membershipUnverified'
    )
    expect(
      projectSessionTabsForClient(marked, 'runtime', [
        SESSION_TABS_SCOPED_ABSENCE_RUNTIME_CAPABILITY
      ])
    ).toEqual(marked)
  })

  // Session parity, step 4: the owner's conversation ledger is one more negotiated field. Between
  // a client without the capability and the same client with it, the only skew on listAll and on
  // the subscribeAll inventory is that field added; the tab frames are untouched.
  it('adds only the conversation ledger for a client that negotiated it', async () => {
    const ledger = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    ledger.publishWindow({
      rendererGeneration: 'r1',
      listedAt: 1,
      coverage: [{ worktreeId: 'wt-ledger', complete: true }],
      omitted: { unknownHost: 0, unverified: 0 },
      folders: [],
      projects: [],
      recordsByWorktree: {}
    })
    const inventory = {
      snapshots: [
        {
          worktree: 'wt-ledger',
          publicationEpoch: 'epoch-ledger',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ],
      authoritative: true as const
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => inventory),
      listAllMobileSessionTabsInventoryWithChangeSequence: vi.fn(async () => ({
        ...inventory,
        changeSequence: 1
      })),
      onMobileSessionTabsChanged: vi.fn(() => vi.fn()),
      registerSubscriptionCleanup: vi.fn(),
      getSessionConversationLedgerStore: () => ledger
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const firstResult = async (method: string, clientCapabilities: readonly string[]) => {
      const messages: string[] = []
      await dispatcher.dispatchStreaming(makeRequest(method), (m) => messages.push(m), {
        clientKind: 'runtime',
        connectionId: 'conn-ledger',
        clientCapabilities
      })
      return JSON.parse(messages[0]!).result as Record<string, unknown>
    }
    const older = remoteRuntimeClientCapabilities().filter(
      (capability) => capability !== SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY
    )

    for (const method of ['session.tabs.listAll', 'session.tabs.subscribeAll']) {
      const before = await firstResult(method, older)
      const after = await firstResult(method, [
        ...older,
        SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY
      ])
      // Why inline: comparePublishedFields lives with the e2e harness, outside the node project.
      expect({
        added: Object.keys(after).filter((key) => !Object.hasOwn(before, key)),
        removed: Object.keys(before).filter((key) => !Object.hasOwn(after, key))
      }).toEqual({ added: ['conversationLedger'], removed: [] })
      expect(after.snapshots).toEqual(before.snapshots)
    }
  })

  it('serves an old client the degraded scan when terminal liveness cannot be proven', async () => {
    const legacyListAll = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(async () => ({
        snapshots: [
          {
            worktree: 'wt-local',
            publicationEpoch: 'epoch-local',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })),
      listAllMobileSessionTabs: legacyListAll
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.listAll'),
      (message) => messages.push(message),
      { clientKind: 'runtime' }
    )

    expect(legacyListAll).not.toHaveBeenCalled()
    expect(JSON.parse(messages[0]!).result).toEqual({
      snapshots: [expect.objectContaining({ worktree: 'wt-local' })]
    })
  })

  it('forwards the caller signal so a disconnected request never scans', async () => {
    const inventory = vi.fn(async (_navigationId?: string, signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw new Error('client_disconnected')
      }
      return { snapshots: [] }
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: inventory
    } as unknown as OrcaRuntimeService
    const controller = new AbortController()
    controller.abort()

    await expect(listSessionTabsInventory({ runtime, signal: controller.signal })).rejects.toThrow(
      'client_disconnected'
    )
    expect(inventory).toHaveBeenCalledWith(undefined, controller.signal)
  })

  it('lets the final authoritative inventory subsume prior-epoch updates', async () => {
    let resolveInventory!: (value: {
      snapshots: RuntimeMobileSessionTabsResult[]
      authoritative: true
      changeSequence: number
    }) => void
    const listeners: ((
      snapshot: RuntimeMobileSessionTabsResult,
      changeSequence: number
    ) => void)[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventoryWithChangeSequence: vi.fn(
        () =>
          new Promise<{
            snapshots: RuntimeMobileSessionTabsResult[]
            authoritative: true
            changeSequence: number
          }>((resolve) => {
            resolveInventory = resolve
          })
      ),
      onMobileSessionTabsChanged: vi.fn(
        (listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void) => {
          listeners.push(listener)
          return vi.fn()
        }
      ),
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []

    const pending = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      {
        connectionId: 'conn-authoritative',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )
    await Promise.resolve()
    listeners[0]?.(
      {
        worktree: 'wt-authoritative',
        publicationEpoch: 'epoch-before-reload',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      },
      1
    )
    expect(messages).toEqual([])

    resolveInventory({
      snapshots: [
        {
          worktree: 'wt-authoritative',
          publicationEpoch: 'epoch-after-reload',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ],
      authoritative: true,
      changeSequence: 1
    })
    await pending
    listeners[0]?.(
      {
        worktree: 'wt-authoritative',
        publicationEpoch: 'epoch-after-reload',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: []
      },
      2
    )

    expect(messages.map((message) => JSON.parse(message).result)).toEqual([
      {
        type: 'snapshots',
        snapshots: [
          expect.objectContaining({
            worktree: 'wt-authoritative',
            publicationEpoch: 'epoch-after-reload',
            snapshotVersion: 1
          })
        ],
        authoritative: true
      },
      expect.objectContaining({
        type: 'updated',
        worktree: 'wt-authoritative',
        publicationEpoch: 'epoch-after-reload',
        snapshotVersion: 2
      })
    ])
  })

  it('lets authoritative empty inventory win over prior-epoch updates', async () => {
    let resolveInventory!: (value: {
      snapshots: []
      authoritative: true
      changeSequence: number
    }) => void
    const listeners: ((
      snapshot: RuntimeMobileSessionTabsResult,
      changeSequence: number
    ) => void)[] = []
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventoryWithChangeSequence: vi.fn(
        () =>
          new Promise<{ snapshots: []; authoritative: true; changeSequence: number }>((resolve) => {
            resolveInventory = resolve
          })
      ),
      onMobileSessionTabsChanged: vi.fn(
        (listener: (snapshot: RuntimeMobileSessionTabsResult, changeSequence: number) => void) => {
          listeners.push(listener)
          return vi.fn()
        }
      ),
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    const snapshot = (snapshotVersion: number): RuntimeMobileSessionTabsResult => ({
      worktree: 'wt-buffered',
      publicationEpoch: 'epoch-buffered',
      snapshotVersion,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })

    const pending = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      {
        connectionId: 'conn-authoritative-empty',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )
    await Promise.resolve()
    listeners[0]?.(snapshot(2), 1)
    listeners[0]?.(snapshot(3), 2)

    resolveInventory({ snapshots: [], authoritative: true, changeSequence: 2 })
    await pending

    expect(messages.map((message) => JSON.parse(message).result)).toEqual([
      { type: 'snapshots', snapshots: [], authoritative: true }
    ])
  })

  it('does no subscription work for an already-cancelled stream', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      supportsAuthoritativeSessionTabsInventory: vi.fn(() => true),
      listAllMobileSessionTabsInventory: vi.fn(),
      onMobileSessionTabsChanged: vi.fn(),
      registerSubscriptionCleanup: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const controller = new AbortController()
    const messages: string[] = []
    controller.abort()

    await dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      { signal: controller.signal }
    )

    expect(runtime.onMobileSessionTabsChanged).not.toHaveBeenCalled()
    expect(runtime.listAllMobileSessionTabsInventory).not.toHaveBeenCalled()
    expect(messages.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'runtime_error' })
      })
    ])
  })

  it('aborts and removes a publication waiter when the stream is cleaned up', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.attachWindow(1)
    const dispatcher = new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS })
    const messages: string[] = []
    const pending = dispatcher.dispatchStreaming(
      makeRequest('session.tabs.subscribeAll'),
      (message) => messages.push(message),
      {
        connectionId: 'conn-cancel',
        clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
      }
    )
    const waiters = (runtime as unknown as { sessionTabsInventoryWaiters: Set<() => void> })
      .sessionTabsInventoryWaiters
    for (let index = 0; index < 20 && waiters.size === 0; index += 1) {
      await Promise.resolve()
    }
    expect(waiters.size).toBe(1)

    runtime.cleanupSubscription('session.tabs:conn-cancel:*:req-1')
    await pending

    expect(waiters.size).toBe(0)
    expect(messages.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'runtime_error' })
      })
    ])
  })
})
