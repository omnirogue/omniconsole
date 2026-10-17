import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { resolveLaunchTrigger } from '../../../../../shared/launch-trigger'
import { flushAsyncTicks } from '../pty-connection-test-async'
import {
  LEAF_1,
  LEAF_2,
  createManager,
  createMockTransport,
  createPane
} from '../pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from '../pty-connection-test-deps'
import { createInitialStoreState } from '../pty-connection-test-store-fixtures'
import type { StoreState } from '../pty-connection-test-store-state'
import type { MockTransport } from '../pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../pty-connection-test-environment'

// Why: automatic sleep (#928) now writes the manual lazy shape — done, restoreOnTabOpenOnly,
// resumeOnFirstReveal, its own tabId — and the restore flood guard (#927) holds whatever a mount no
// person asked for would resume. Combined, these pin that no background mount path resumes such a
// record, that a person's reveal (the desktop, or the phone's per-terminal open) resumes it exactly
// once in the admission person lane, and that launch.trigger (#926) names what started it.

const { scheduleRuntimeGraphSync, resetAndRefreshAllTerminalWebglAtlases } = vi.hoisted(() => ({
  scheduleRuntimeGraphSync: vi.fn(),
  resetAndRefreshAllTerminalWebglAtlases: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let spawned: Record<string, unknown>[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))
vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))
vi.mock('../terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery: vi.fn()
}))
vi.mock('../cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false)
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: () => () => {}
  }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('../pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})
vi.mock('../pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: unknown) => {
    const next = transportFactoryQueue.shift()
    if (!next) {
      throw new Error('No mock transport queued')
    }
    // Kept so a connect can run the real spawn request against the pane's own options.
    ;(next as MockTransport & { options?: unknown }).options = options
    return next
  })
}))
vi.mock('../pty-dispatcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEagerPtyBufferHandle: vi.fn(() => undefined)
}))

type Binding = {
  noteRevealed: () => void
  noteVisibilityResume: () => void
  wakeHibernatedAgentIfArmed: (claimed?: Set<string>) => string | null
}
type Deps = ReturnType<typeof buildPaneConnectionDeps>
type Mounted = { binding: Binding; transport: MockTransport; deps: Deps }
type Topology = 'single' | 'split'

const NOW = Date.now()

function threadId(index: number): string {
  return `019a0000-0000-7000-8000-${String(index).padStart(12, '0')}`
}

function paneKeyOf(tabId: string): string {
  return makePaneKey(tabId, LEAF_1)
}

/** What automatic sleep leaves (toAutomaticSleepRecord): the manual lazy shape, re-keyed. */
function lazyRecord(tabId: string, index: number, overrides: Record<string, unknown> = {}) {
  return {
    paneKey: paneKeyOf(tabId),
    tabId,
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: threadId(index) },
    prompt: '',
    state: 'done',
    capturedAt: NOW - 60 * 60_000,
    updatedAt: NOW - 60 * 60_000,
    origin: 'worktree-sleep',
    restoreOnTabOpenOnly: true,
    resumeOnFirstReveal: true,
    ...overrides
  }
}

/**
 * After a restart: each tab's slept leaf keeps its dead PTY id. `split` adds a sibling whose shell
 * still runs, so the tab mounts with the workspace and only #928's connect gate stands before it.
 */
function seedTabs(count: number, topology: Topology, overrides: Record<string, unknown> = {}) {
  const ids = Array.from({ length: count }, (_, index) => `tab-${index}`)
  mockStoreState = {
    ...mockStoreState,
    pendingStartupByTabId: {},
    lastTerminalInputAtByPaneKey: {},
    agentStatusByPaneKey: {},
    tabsByWorktree: {
      'wt-1': ids.map((id, index) => ({
        id,
        ptyId: topology === 'split' ? `sibling-${index}` : `lost-${index}`
      }))
    },
    ptyIdsByTabId:
      topology === 'split'
        ? Object.fromEntries(ids.map((id, index) => [id, [`lost-${index}`, `sibling-${index}`]]))
        : {},
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      ids.map((id, index) => [paneKeyOf(id), lazyRecord(id, index, overrides)])
    )
  } as unknown as StoreState
  vi.mocked(window.api.pty.hasPty).mockImplementation(async (ptyId: string) =>
    ptyId.startsWith('sibling-')
  )
  return ids
}

/** A transport whose connect runs the real renderer spawn request (ipc-pty-spawn-request.ts)
 *  for every agent start, so the fields main receives — lane, admission key, launch trigger —
 *  are read as the pane computes them at that moment. */
async function spawningTransport(): Promise<MockTransport> {
  const { spawnIpcPty } = await import('../ipc-pty-spawn-request')
  const transport = createMockTransport(null)
  const reattach = transport.connect.getMockImplementation() as (options: unknown) => unknown
  transport.connect.mockImplementation(async (options: { command?: string }) => {
    if (options.command) {
      const { options: transportOptions } = transport as MockTransport & { options?: unknown }
      await spawnIpcPty(transportOptions as never, options as never)
    }
    return reattach(options)
  })
  return transport
}

async function mountPane(tabId: string): Promise<Mounted> {
  const { connectPanePty } = await import('../pty-connection')
  const transport = await spawningTransport()
  transportFactoryQueue.push(transport)
  const index = tabId.replace('tab-', '')
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    tabId,
    restoredLeafId: LEAF_1,
    restoredPtyIdByLeafId: { [LEAF_1]: `lost-${index}`, [LEAF_2]: `sibling-${index}` },
    isActiveRef: { current: false },
    isVisibleRef: { current: false },
    onClearSessionRestoredBanner: vi.fn()
  })
  const binding = connectPanePty(
    createPane(1) as never,
    createManager(2) as never,
    deps as never
  ) as unknown as Binding
  return { binding, transport, deps }
}

async function settle(): Promise<void> {
  await flushAsyncTicks(30)
  // Past the 250 ms connect fallback timer, so a deferred connect would have run.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await flushAsyncTicks(30)
}

async function mountAll(ids: readonly string[]): Promise<Mounted[]> {
  const mounted: Mounted[] = []
  for (const id of ids) {
    mounted.push(await mountPane(id))
  }
  await settle()
  return mounted
}

function connects(mounted: readonly Mounted[]): number {
  return mounted.reduce((sum, entry) => sum + entry.transport.connect.mock.calls.length, 0)
}

/** What use-terminal-pane-lifecycle runs when a person brings the pane on screen. */
function revealOnDesktop(entry: Mounted): void {
  entry.deps.isVisibleRef.current = true
  entry.binding.noteVisibilityResume()
  entry.binding.noteRevealed()
}

/** A targeted background mount (a browser lease, a wake naming tabs) marks its tabs as #928's
 *  reveal; an untargeted mount, or the workspace opened on another tab, marks none. */
async function backgroundMount(tabIds: readonly string[]): Promise<void> {
  const { markDeferredTabsRevealed, selectRevealDeferredTabIds } =
    await import('../../terminal/deferred-startup-mount')
  markDeferredTabsRevealed(tabIds, new Set(selectRevealDeferredTabIds(mockStoreState as never)))
}

describe('restore flood guard x automatic sleep records (lazy shape)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    spawned = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
    Object.assign(window.api.pty, {
      spawn: vi.fn(async (args: Record<string, unknown>) => {
        spawned.push(args)
        return { id: `spawned-${spawned.length}` }
      })
    })
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  describe.each<[string, readonly string[]]>([
    ['an untargeted background mount', []],
    ['a background mount targeted at the tab (browser lease, wake)', ['tab-0']]
  ])('%s', (_label, targeted) => {
    it.each<Topology>(['single', 'split'])(
      'holds a %s-pane tab, then one desktop reveal resumes it once',
      async (topology) => {
        const ids = seedTabs(1, topology)
        await backgroundMount(targeted)
        const [entry] = await mountAll(ids)

        expect(connects([entry])).toBe(0)
        expect(spawned).toEqual([])
        // The mounted pane's armed wake (the phone opening the workspace) is no reveal either.
        expect(entry.binding.wakeHibernatedAgentIfArmed(new Set())).toBeNull()
        await settle()
        expect(connects([entry])).toBe(0)

        revealOnDesktop(entry)
        await settle()
        // A second reveal (tab switch back, a later visibility flip) resumes nothing more.
        entry.binding.noteVisibilityResume()
        entry.binding.noteRevealed()
        await settle()

        expect(spawned).toHaveLength(1)
        expect(String(spawned[0].command)).toContain(threadId(0))
        expect(spawned[0]).toMatchObject({
          launchPriority: 'person',
          launchAdmissionKey: paneKeyOf('tab-0'),
          // #926: a slept agent's resume is a hibernation wake, on screen.
          launchTrigger: 'hibernation-wake',
          launchVisible: true
        })
        // The record stays until the resumed agent replaces it; it is never cleared by a hold.
        expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKeyOf('tab-0')]).toBeTruthy()
      }
    )
  })

  it.each<Topology>(['single', 'split'])(
    "the phone's per-terminal open resumes a held %s-pane tab once, in the person lane",
    async (topology) => {
      const ids = seedTabs(3, topology)
      const mounted = await mountAll(ids)
      expect(connects(mounted)).toBe(0)
      const { revealTerminalTabForPerson } = await import('./cold-restore-reveal-hold')

      revealTerminalTabForPerson('tab-1')
      await settle()
      revealTerminalTabForPerson('tab-1')
      await settle()

      expect(spawned).toHaveLength(1)
      expect(String(spawned[0].command)).toContain(threadId(1))
      expect(spawned[0]).toMatchObject({
        launchPriority: 'person',
        launchAdmissionKey: paneKeyOf('tab-1'),
        launchTrigger: 'hibernation-wake',
        launchVisible: false
      })
      // Main labels it from the phone's tab hint (noted only for the phone's own open).
      expect(
        resolveLaunchTrigger({ rendererTrigger: spawned[0].launchTrigger, tabHint: 'mobile-wake' })
      ).toBe('mobile-wake')
      expect(connects([mounted[0], mounted[2]])).toBe(0)
    }
  )

  it.each<Topology>(['single', 'split'])(
    '51 lazy records + a whole-workspace background mount (%s panes): 0 agent starts, 0 PTY spawns',
    async (topology) => {
      const ids = seedTabs(51, topology)
      const { requestBackgroundTerminalWorktreeMount, takePendingBackgroundTerminalWorktreeMount } =
        await import('../../terminal/background-terminal-worktree-mount')
      requestBackgroundTerminalWorktreeMount({ worktreeId: 'wt-1' })
      // Under the guard a whole-workspace request names no tab, so it mounts nothing new...
      expect(takePendingBackgroundTerminalWorktreeMount('wt-1')).toEqual({
        worktreeId: 'wt-1',
        tabIds: []
      })
      await backgroundMount([])
      // ...and every pane that mounts anyway (the workspace's own activation, a remount after
      // eviction, a split kept mounted for its live sibling) starts and spawns nothing.
      const mounted = await mountAll(ids)
      for (const { binding } of mounted) {
        expect(binding.wakeHibernatedAgentIfArmed(new Set())).toBeNull()
      }
      await settle()

      expect(connects(mounted)).toBe(0)
      expect(spawned).toEqual([])
      expect(Object.keys(mockStoreState.sleepingAgentSessionsByPaneKey)).toHaveLength(51)
    }
  )

  it('51 lazy records with no PTY left: their tabs are held unmounted until revealed', async () => {
    const ids = seedTabs(51, 'single')
    mockStoreState.tabsByWorktree = { 'wt-1': ids.map((id) => ({ id, ptyId: null })) } as never
    const { selectRevealDeferredTabIds, withholdUnrevealedDeferredTabs } =
      await import('../../terminal/deferred-startup-mount')
    const deferred = new Set(selectRevealDeferredTabIds(mockStoreState as never))

    expect(deferred.size).toBe(51)
    const mountable = withholdUnrevealedDeferredTabs(
      'wt-1',
      null,
      mockStoreState.tabsByWorktree['wt-1'],
      deferred
    )
    expect(mountable ? [...mountable] : null).toEqual([])
  })

  it("a person's desktop click on a held idle 'quit' tab records a person reveal", async () => {
    // One reveal source (foreground-terminal-tabs.ts): the visit that releases the hold is the
    // visit the launch trigger reads as a person's.
    const ids = seedTabs(1, 'single', {
      origin: 'quit',
      restoreOnTabOpenOnly: undefined,
      resumeOnFirstReveal: undefined
    })
    const [entry] = await mountAll(ids)
    expect(connects([entry])).toBe(0)
    const { setForegroundTerminalTabIds, getForegroundTerminalTabRevealedAt } =
      await import('@/lib/foreground-terminal-tabs')
    const { notePersonInputForRevealEvidence, wasTerminalTabRevealedByPerson } =
      await import('@/lib/launch-trigger/person-reveal-evidence')

    notePersonInputForRevealEvidence()
    setForegroundTerminalTabIds(['tab-0'])
    expect(getForegroundTerminalTabRevealedAt('tab-0')).toBeGreaterThan(NOW - 60 * 60_000)
    expect(wasTerminalTabRevealedByPerson('tab-0')).toBe(true)
    revealOnDesktop(entry)
    await settle()

    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      launchPriority: 'person',
      launchTrigger: 'person-reveal',
      launchVisible: true
    })
  })

  it('with the guard off a lazy record still waits for its tab (#928) and resumes once', async () => {
    const ids = seedTabs(1, 'split')
    mockStoreState.settings = { ...mockStoreState.settings, restoreFloodGuard: false } as never
    const [entry] = await mountAll(ids)
    expect(connects([entry])).toBe(0)

    revealOnDesktop(entry)
    await settle()

    expect(spawned).toHaveLength(1)
    // The kill switch lifts main's admission window too: no lane, no admission key.
    expect(spawned[0].launchPriority).toBeUndefined()
    expect(spawned[0].launchAdmissionKey).toBeUndefined()
    expect(spawned[0].launchTrigger).toBe('hibernation-wake')
  })

  describe('an agent hibernation slept in place (its pane stays mounted in the background)', () => {
    /** The pane runs its agent, then hibernation writes the lazy record and kills the PTY. */
    async function hibernatedInPlace(): Promise<Mounted> {
      const { connectPanePty } = await import('../pty-connection')
      const transport = await spawningTransport()
      transportFactoryQueue.push(transport)
      ;(mockStoreState as unknown as Record<string, unknown>).pendingStartupByTabId = {}
      const deps = buildPaneConnectionDeps(() => mockStoreState, {
        consumeSuppressedPtyExit: vi.fn(() => true),
        isActiveRef: { current: false },
        isVisibleRef: { current: false },
        onClearSessionRestoredBanner: vi.fn()
      })
      const binding = connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        deps as never
      ) as unknown as Binding
      await settle()
      expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKeyOf('tab-1')] = lazyRecord(
        'tab-1',
        5
      ) as never
      mockStoreState.suppressedPtyExitIds['tab-pty'] = true
      const { options } = transport as MockTransport & { options?: unknown }
      ;(options as { onPtyExit?: (ptyId: string) => void }).onPtyExit?.('tab-pty')
      await settle()
      return { binding, transport, deps }
    }

    it("stays asleep for the phone's workspace wake; the phone's tab open wakes it once", async () => {
      const entry = await hibernatedInPlace()
      expect(entry.binding.wakeHibernatedAgentIfArmed(new Set())).toBeNull()
      await settle()
      expect(spawned).toEqual([])
      const { revealTerminalTabForPerson } = await import('./cold-restore-reveal-hold')

      revealTerminalTabForPerson('tab-1')
      await settle()
      revealTerminalTabForPerson('tab-1')
      await settle()

      expect(spawned).toHaveLength(1)
      expect(String(spawned[0].command)).toContain(threadId(5))
      expect(spawned[0]).toMatchObject({ launchTrigger: 'hibernation-wake', launchVisible: false })
    })

    it('a desktop reveal wakes it exactly once, though both reveal hooks fire', async () => {
      const entry = await hibernatedInPlace()

      revealOnDesktop(entry)
      await settle()
      entry.binding.noteVisibilityResume()
      entry.binding.noteRevealed()
      await settle()

      expect(spawned).toHaveLength(1)
      expect(spawned[0]).toMatchObject({ launchTrigger: 'hibernation-wake', launchVisible: true })
    })
  })
})
