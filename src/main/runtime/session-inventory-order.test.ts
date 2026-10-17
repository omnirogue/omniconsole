import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY,
  SESSION_TABS_SCOPED_ABSENCE_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { attachSessionTabsInventoryOrder } from '../../shared/session-tabs-inventory-order'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeMobileSessionTabsResult,
  type RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-session-contracts'
import type { SessionTabsInventoryOrder } from '../../shared/session-tabs-inventory-order'
import { OrcaRuntimeService } from './omni-runtime'
import { projectSessionTabsForClient } from './rpc/methods/session-tabs-inventory'

const WT = 'repo::/worktree'
const LEAF = '11111111-1111-4111-8111-111111111111'

type Internals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  clientSessionTabSelections: {
    activate(
      snapshot: RuntimeMobileSessionTabsResult,
      clientNavigationId: string,
      activeTabId: string
    ): RuntimeMobileSessionTabsResult
  }
  publishPtyBackedMobileSessionTerminal(
    worktreeId: string,
    pty: unknown,
    args: { tabId: string; leafId: string; title: string | null; activate: boolean }
  ): void
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId?: string): Set<string>
}

function publication(
  tabIds: readonly string[],
  version: number,
  epoch = 'renderer:gen-a'
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: WT,
    publicationEpoch: epoch,
    snapshotVersion: version,
    activeGroupId: 'group',
    activeTabId: tabIds[0] ? `${tabIds[0]}::${LEAF}` : null,
    activeTabType: tabIds[0] ? 'terminal' : null,
    tabGroups: [{ id: 'group', activeTabId: tabIds[0] ?? null, tabOrder: [...tabIds] }],
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

function createRuntime(): { runtime: OrcaRuntimeService; internals: Internals } {
  const repo = { id: 'repo', path: '/worktree' }
  const runtime = new OrcaRuntimeService({
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    getRepo: () => repo,
    getRepos: () => [repo],
    getAllWorktreeMeta: () => ({})
  } as never)
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  return { runtime, internals: runtime as unknown as Internals }
}

function sync(runtime: OrcaRuntimeService, snapshots: RuntimeMobileSessionTabsSnapshot[]): void {
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: snapshots,
    rendererGeneration: snapshots[0]?.publicationEpoch.split(':headless-merge:')[0]
  })
}

function orders(frames: readonly RuntimeMobileSessionTabsResult[]): SessionTabsInventoryOrder[] {
  return frames.map((frame) => frame.inventoryOrder!)
}

function expectStrictlyIncreasing(values: readonly number[]): void {
  values.slice(1).forEach((value, index) => expect(value).toBeGreaterThan(values[index]!))
}

describe('owner inventory generation and revision (step 3b)', () => {
  it('stamps every writer and the removal tombstone from one counter, across epochs', () => {
    const { runtime } = createRuntime()
    const frames: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot))
    runtime.attachWindow(1)

    sync(runtime, [publication(['a'], 1)])
    runtime.touchMobileSessionTabsForWorktree(WT, { immediate: true })
    sync(runtime, [publication(['a', 'b'], 2)])
    // Renderer reload: a new renderer generation and epoch, same runtime incarnation.
    sync(runtime, [publication(['b'], 1, 'renderer:gen-b')])
    runtime.touchMobileSessionTabsForWorktree(WT, { immediate: true })
    // The window stops publishing the workspace: a removal tombstone.
    runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    // Re-added within the same generation.
    sync(runtime, [publication(['c'], 2, 'renderer:gen-b')])
    runtime.touchMobileSessionTabsForWorktree(WT, { immediate: true })

    const emitted = orders(frames)
    expect(emitted.length).toBeGreaterThanOrEqual(4)
    expect(new Set(emitted.map((order) => order.generation)).size).toBe(1)
    expectStrictlyIncreasing(emitted.map((order) => order.revision))
    const removal = frames.find((frame) => (frame as { removed?: boolean }).removed === true)
    expect(removal?.inventoryOrder).toBeDefined()
    const readded = frames[frames.indexOf(removal!) + 1]
    expect(readded!.inventoryOrder!.revision).toBeGreaterThan(removal!.inventoryOrder!.revision)
    expect(
      new Set(frames.map((frame) => frame.publicationEpoch.split(':')[1])).size
    ).toBeGreaterThan(1)
  })

  it('keeps revisions monotonic through headless creation, activation and desktop promotion', () => {
    const { runtime, internals } = createRuntime()
    const frames: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot))
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

    // Headless terminal creation publishes a headless:pty-backed epoch.
    internals.publishPtyBackedMobileSessionTerminal(
      WT,
      { ptyId: 'serve-1', worktreeId: WT, connected: true },
      { tabId: 'serve-tab', leafId: LEAF, title: 'Serve', activate: true }
    )
    // Activation hydrates the headless snapshot again.
    internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WT)
    runtime.touchMobileSessionTabsForWorktree(WT, { immediate: true })
    // Promotion to a desktop window, whose renderer then publishes.
    runtime.attachWindow(1)
    sync(runtime, [publication(['d'], 1, 'renderer:promoted')])
    runtime.touchMobileSessionTabsForWorktree(WT, { immediate: true })

    const emitted = orders(frames)
    expect(
      new Set(frames.map((frame) => frame.publicationEpoch.split(':')[0])).size
    ).toBeGreaterThan(1)
    expect(new Set(emitted.map((order) => order.generation)).size).toBe(1)
    expectStrictlyIncreasing(emitted.map((order) => order.revision))
  })

  it('sends a removal tombstone when a worktree is removed', () => {
    const { runtime } = createRuntime()
    const frames: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot))
    runtime.attachWindow(1)
    sync(runtime, [publication(['a'], 1)])
    const lastWrite = frames.at(-1)?.inventoryOrder?.revision ?? 0
    const store = {
      getWorktreeMeta: () => undefined,
      removeWorktreeMeta: vi.fn(),
      getRepos: () => []
    }
    ;(
      runtime as unknown as {
        removeWorktreeMetadataAndHistory(store: unknown, worktreeId: string): void
      }
    ).removeWorktreeMetadataAndHistory(store, WT)

    const removal = frames.at(-1) as RuntimeMobileSessionTabsResult & { removed?: boolean }
    expect(removal.removed).toBe(true)
    expect(removal.worktree).toBe(WT)
    expect(removal.inventoryOrder!.revision).toBeGreaterThan(lastWrite)
  })

  it('mints a new generation per runtime incarnation', () => {
    const first = createRuntime()
    const second = createRuntime()
    for (const { runtime } of [first, second]) {
      runtime.attachWindow(1)
      sync(runtime, [publication(['a'], 1)])
    }
    const [a] = storedOrders(first.runtime)
    const [b] = storedOrders(second.runtime)
    expect(a!.generation).not.toBe(b!.generation)
  })
})

/** The order each stored snapshot publishes with, read through the shared publish projection. */
function storedOrders(runtime: OrcaRuntimeService): SessionTabsInventoryOrder[] {
  const internals = runtime as unknown as {
    toPublishedMobileSessionTabsResult(
      snapshot: RuntimeMobileSessionTabsSnapshot
    ): RuntimeMobileSessionTabsResult | null
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  }
  return [...internals.mobileSessionTabsByWorktree.values()].map(
    (snapshot) => internals.toPublishedMobileSessionTabsResult(snapshot)!.inventoryOrder!
  )
}

describe('client projection and negotiation (step 3c, d, e)', () => {
  it('carries a client’s navigation as its own revision beside the inventory revision', async () => {
    const { runtime, internals } = createRuntime()
    runtime.attachWindow(1)
    sync(runtime, [publication(['a', 'b'], 1)])
    const before = await runtime.listMobileSessionTabs(`id:${WT}`, 'phone')
    const navigated = internals.clientSessionTabSelections.activate(before, 'phone', `b::${LEAF}`)

    expect(navigated.activeTabId).toBe(`b::${LEAF}`)
    expect(navigated.inventoryOrder?.revision).toBe(before.inventoryOrder?.revision)
    expect(navigated.inventoryOrder?.projectionRevision).toBe(
      (before.inventoryOrder?.projectionRevision ?? 0) + 1
    )
    // Another client's projection is unaffected.
    const other = await runtime.listMobileSessionTabs(`id:${WT}`, 'macbook')
    expect(other.inventoryOrder?.projectionRevision).toBe(0)
  })

  it('answers list and stream with the same projection for the same client and capabilities', async () => {
    const { runtime } = createRuntime()
    runtime.attachWindow(1)
    sync(runtime, [publication(['a', 'b'], 1)])
    const streamed: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => streamed.push(snapshot), 'phone')
    runtime.notifyMobileSessionTabsChanged(WT)
    const listed = await runtime.listMobileSessionTabs(`id:${WT}`, 'phone')
    const capabilities = [SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY]

    expect(streamed.at(-1)?.inventoryOrder).toBeDefined()
    expect(projectSessionTabsForClient(streamed.at(-1)!, 'runtime', capabilities)).toEqual(
      projectSessionTabsForClient(listed, 'runtime', capabilities)
    )
  })

  it('gives a client that did not negotiate today’s frame, unchanged', async () => {
    const { runtime } = createRuntime()
    runtime.attachWindow(1)
    sync(runtime, [publication(['a'], 1)])
    const listed = await runtime.listMobileSessionTabs(`id:${WT}`, 'phone')
    const { inventoryOrder, ...legacyFrame } = listed

    expect(inventoryOrder).toBeDefined()
    // Old peer (no capability): the old projection, epoch and folded version.
    expect(projectSessionTabsForClient(listed, 'runtime', [])).toEqual(legacyFrame)
    // On the wire (JSON), neither an old runtime peer nor the phone sees the field.
    for (const [clientKind, capabilities] of [
      ['runtime', []],
      ['mobile', undefined]
    ] as const) {
      const wire = JSON.parse(
        JSON.stringify(projectSessionTabsForClient(listed, clientKind, capabilities))
      )
      expect(wire).not.toHaveProperty('inventoryOrder')
    }
    // In process, results stay exactly today's shape for every existing equality check.
    expect(Object.keys(listed)).not.toContain('inventoryOrder')
    // New peer: the same frame plus the negotiated metadata.
    expect(
      projectSessionTabsForClient(listed, 'runtime', [
        SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY
      ])
    ).toEqual({ ...legacyFrame, inventoryOrder })
  })
})

describe('step 3 and step 6 metadata coexist (negotiated independently)', () => {
  it('strips inventory order and membership evidence each for clients without its capability', () => {
    const frame = attachSessionTabsInventoryOrder(
      {
        worktree: WT,
        publicationEpoch: 'renderer:gen-a',
        snapshotVersion: 3,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [],
        membershipUnverified: true as const
      },
      { generation: 'runtime-1', revision: 7 }
    )
    const wire = (capabilities: string[]): Record<string, unknown> =>
      JSON.parse(JSON.stringify(projectSessionTabsForClient(frame, 'runtime', capabilities)))
    const order = SESSION_TABS_INVENTORY_ORDER_RUNTIME_CAPABILITY
    const absence = SESSION_TABS_SCOPED_ABSENCE_RUNTIME_CAPABILITY
    expect(wire([order, absence])).toMatchObject({
      membershipUnverified: true,
      inventoryOrder: { generation: 'runtime-1', revision: 7 }
    })
    expect(wire([order])).not.toHaveProperty('membershipUnverified')
    expect(wire([order])).toHaveProperty('inventoryOrder')
    expect(wire([absence])).toHaveProperty('membershipUnverified', true)
    expect(wire([absence])).not.toHaveProperty('inventoryOrder')
    expect(wire([])).not.toHaveProperty('membershipUnverified')
    expect(wire([])).not.toHaveProperty('inventoryOrder')
  })
})

describe('renderer generation fence (step 3b)', () => {
  it('refuses a delayed graph from a renderer generation a reload replaced', () => {
    const { runtime, internals } = createRuntime()
    runtime.attachWindow(1)
    sync(runtime, [publication(['a'], 5, 'renderer:gen-a')])
    sync(runtime, [publication(['b'], 1, 'renderer:gen-b')])
    const current = internals.mobileSessionTabsByWorktree.get(WT)

    expect(() => sync(runtime, [publication(['a', 'stale'], 6, 'renderer:gen-a')])).toThrow(
      'superseded renderer generation'
    )
    expect(internals.mobileSessionTabsByWorktree.get(WT)).toBe(current)
  })
})
