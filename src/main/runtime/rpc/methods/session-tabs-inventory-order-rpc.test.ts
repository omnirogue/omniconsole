import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-session-contracts'
import { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_TAB_METHODS } from './session-tabs'
import { projectSessionTabsForClient } from './session-tabs-inventory'

const WT = 'repo::/worktree'
const LEAF = '11111111-1111-4111-8111-111111111111'
const RENDERER = 'renderer:gen-a'
const ORDER = [SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY]

type Frame = RuntimeMobileSessionTabsResult & { type?: string; removed?: boolean }

function publication(tabIds: readonly string[], version: number): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: RENDERER,
    snapshotVersion: version,
    activeGroupId: 'group',
    activeTabId: `${tabIds[0]}::${LEAF}`,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group', activeTabId: tabIds[0]!, tabOrder: [...tabIds] }],
    tabs: tabIds.map((id, index) => ({
      type: 'terminal' as const,
      id: `${id}::${LEAF}`,
      parentTabId: id,
      leafId: LEAF,
      ptyId: `pty-${id}`,
      title: id,
      isActive: index === 0
    }))
  }
}

function setup(): { runtime: OrcaRuntimeService; dispatcher: RpcDispatcher } {
  const repo = { id: 'repo', path: '/worktree' }
  const runtime = new OrcaRuntimeService({
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    getRepo: () => repo,
    getRepos: () => [repo],
    getAllWorktreeMeta: () => ({})
  } as never)
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [publication(['a', 'b'], 1)],
    rendererGeneration: RENDERER
  })
  return { runtime, dispatcher: new RpcDispatcher({ runtime, methods: SESSION_TAB_METHODS }) }
}

async function call(
  dispatcher: RpcDispatcher,
  method: string,
  params: unknown,
  capabilities: readonly string[]
): Promise<{ frames: () => Frame[] }> {
  const messages: string[] = []
  const request: RpcRequest = { id: `${method}-1`, authToken: 'tok', method, params }
  await dispatcher.dispatchStreaming(request, (message) => messages.push(message), {
    clientKind: 'runtime',
    clientCapabilities: capabilities as never,
    pairedDeviceId: 'macbook',
    connectionId: `connection-${method}`
  })
  const frames = (): Frame[] =>
    messages.flatMap((message) => {
      const result = (JSON.parse(message) as { result?: unknown }).result as
        | (Frame & { snapshots?: Frame[] })
        | undefined
      return result?.snapshots ?? (result && 'worktree' in result ? [result] : [])
    })
  return { frames }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

/** Every path a session-tab frame leaves the owner by, for one client. */
async function collectEveryPath(capabilities: readonly string[]): Promise<Record<string, Frame[]>> {
  const { runtime, dispatcher } = setup()
  const list = await call(dispatcher, 'session.tabs.list', { worktree: `id:${WT}` }, capabilities)
  const listAll = await call(dispatcher, 'session.tabs.listAll', {}, capabilities)
  const subscribe = await call(
    dispatcher,
    'session.tabs.subscribe',
    { worktree: `id:${WT}` },
    capabilities
  )
  const subscribeAll = await call(dispatcher, 'session.tabs.subscribeAll', null, capabilities)
  await flush()
  const initialSubscribe = subscribe.frames().length
  const initialSubscribeAll = subscribeAll.frames().length

  // A stored write (both subscriptions), then a navigation emit for this client.
  runtime.touchMobileSessionTabsForWorktree(WT, { immediate: true })
  const internals = runtime as unknown as {
    getMobileSessionTabsForWorktree(
      worktree: string,
      client?: string
    ): RuntimeMobileSessionTabsResult
    emitMobileSessionTabsSnapshotToClient(
      projected: RuntimeMobileSessionTabsResult,
      client: string,
      follow?: boolean
    ): void
  }
  internals.emitMobileSessionTabsSnapshotToClient(
    internals.getMobileSessionTabsForWorktree(WT, 'macbook'),
    'macbook',
    true
  )
  // The activation reply: what activateMobileSessionTab returns for a caller (its client
  // projection after the activation), through the mutation reply projection and JSON. Why not the
  // RPC itself: with no live window in a unit test it answers the retryable refusal (step 4).
  const internalsWithSelection = runtime as unknown as {
    clientSessionTabSelections: {
      activate(
        snapshot: RuntimeMobileSessionTabsResult,
        client: string,
        tabId: string
      ): RuntimeMobileSessionTabsResult
    }
  }
  const activated = internalsWithSelection.clientSessionTabSelections.activate(
    internals.getMobileSessionTabsForWorktree(WT, 'macbook'),
    'macbook',
    `b::${LEAF}`
  )
  const activate = [
    JSON.parse(
      JSON.stringify(projectSessionTabsForClient(activated, 'runtime', capabilities as never))
    ) as Frame
  ]
  // The window stops publishing the workspace: a removal frame.
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [],
    rendererGeneration: RENDERER
  })
  await flush()
  return {
    list: list.frames(),
    listAll: listAll.frames(),
    subscribeInitial: subscribe.frames().slice(0, initialSubscribe),
    subscribeUpdates: subscribe.frames().slice(initialSubscribe),
    subscribeAllInitial: subscribeAll.frames().slice(0, initialSubscribeAll),
    subscribeAllUpdates: subscribeAll.frames().slice(initialSubscribeAll),
    activate
  }
}

describe('every owner emit path carries the negotiated inventory order (step 3)', () => {
  it('sends it on list, listAll, both subscriptions, navigation, removal and mutation replies', async () => {
    const paths = await collectEveryPath(ORDER)
    for (const [path, frames] of Object.entries(paths)) {
      expect(frames.length, path).toBeGreaterThan(0)
      for (const frame of frames) {
        expect(frame.inventoryOrder, `${path} ${frame.publicationEpoch}`).toEqual(
          expect.objectContaining({ generation: expect.any(String), revision: expect.any(Number) })
        )
      }
    }
    const updates = paths.subscribeAllUpdates!
    expect(updates.some((frame) => frame.navigationIntent === 'follow')).toBe(true)
    expect(updates.some((frame) => frame.removed === true)).toBe(true)
    // One runtime incarnation, one generation, on every path.
    const generations = new Set(
      Object.values(paths).flatMap((frames) =>
        frames.map((frame) => frame.inventoryOrder!.generation)
      )
    )
    expect(generations.size).toBe(1)
  })

  it('sends none of it to a client that did not negotiate (today’s frames)', async () => {
    const paths = await collectEveryPath([])
    for (const [path, frames] of Object.entries(paths)) {
      expect(frames.length, path).toBeGreaterThan(0)
      for (const frame of frames) {
        expect(frame, path).not.toHaveProperty('inventoryOrder')
      }
    }
  })
})
