import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  LEAF_2,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: () => () => {}
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

const SLEPT_PANE_KEY = makePaneKey('tab-1', LEAF_1)

function sleptRecord(shape: Partial<SleepingAgentSessionRecord>): SleepingAgentSessionRecord {
  return {
    paneKey: SLEPT_PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-slept-1' },
    prompt: 'finish the task',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    ...shape
  }
}

// What automatic sleep (toAutomaticSleepRecord) leaves on the slept leaf of a split.
const AUTOMATIC_SHAPE = { restoreOnTabOpenOnly: true, resumeOnFirstReveal: true as const }

/** After a restart: the slept leaf keeps its dead PTY id as a wake hint, the sibling still runs. */
function seedRestartedSplitTab(record: SleepingAgentSessionRecord): void {
  mockStoreState = {
    ...mockStoreState,
    pendingStartupByTabId: {},
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-sibling' }] },
    // Hydration advertises every leaf binding, the slept leaf's dead id included.
    ptyIdsByTabId: { 'tab-1': ['pty-agent', 'pty-sibling'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_2 }
        },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-agent', [LEAF_2]: 'pty-sibling' }
      }
    },
    sleepingAgentSessionsByPaneKey: { [SLEPT_PANE_KEY]: record }
  } as StoreState
}

function queueSleptPaneTransport(): MockTransport {
  const transport = createMockTransport(null)
  transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => ({
    id: 'pty-resumed',
    ...(sessionId ? { coldRestore: { scrollback: 'history', cwd: '/tmp/wt-1' } } : {})
  }))
  transportFactoryQueue.push(transport)
  return transport
}

function connectSleptPane(
  connectPanePty: (pane: never, manager: never, deps: never) => unknown,
  isVisibleRef: { current: boolean }
): { noteVisibilityResume: () => void } {
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    isVisibleRef,
    restoredLeafId: LEAF_1,
    restoredPtyIdByLeafId: { [LEAF_1]: 'pty-agent', [LEAF_2]: 'pty-sibling' }
  })
  return connectPanePty(
    createPane(1) as never,
    createManager(2) as never,
    deps as never
  ) as { noteVisibilityResume: () => void }
}

function resumeConnects(transport: MockTransport): unknown[] {
  return transport.connect.mock.calls.filter(([options]) =>
    String((options as { command?: string }).command ?? '').includes('--resume')
  )
}

async function settleConnects(): Promise<void> {
  await flushAsyncTicks(20)
  // Past the 250ms connect fallback timer, so a deferred connect would have run.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await flushAsyncTicks(20)
}

describe('a pane automatic sleep put down, in a split that stays mounted', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('stays asleep through a background mount and resumes once when its tab is opened', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markDeferredTabsRevealed } = await import('../terminal/deferred-startup-mount')
    seedRestartedSplitTab(sleptRecord(AUTOMATIC_SHAPE))
    const transport = queueSleptPaneTransport()
    // An untargeted background mount, and the workspace opened on another tab, reveal nothing here.
    markDeferredTabsRevealed([], new Set())
    markDeferredTabsRevealed(['tab-2'], new Set())
    const isVisibleRef = { current: false }

    const binding = connectSleptPane(connectPanePty, isVisibleRef)
    await settleConnects()

    // No connect and no spawn, so nothing carries the `--resume`.
    expect(transport.connect).not.toHaveBeenCalled()
    expect(transport.attach).not.toHaveBeenCalled()

    isVisibleRef.current = true
    binding.noteVisibilityResume()
    await settleConnects()

    expect(resumeConnects(transport)).toHaveLength(1)
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'pty-agent',
        command: expect.stringContaining('sess-slept-1')
      })
    )

    // A second reveal does not resume it again.
    binding.noteVisibilityResume()
    await settleConnects()
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('resumes while hidden when a mount targets its tab, as opening it from a phone does', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { markDeferredTabsRevealed } = await import('../terminal/deferred-startup-mount')
    seedRestartedSplitTab(sleptRecord(AUTOMATIC_SHAPE))
    const transport = queueSleptPaneTransport()
    markDeferredTabsRevealed(['tab-1'], new Set())

    connectSleptPane(connectPanePty, { current: false })
    await settleConnects()

    expect(resumeConnects(transport)).toHaveLength(1)
  })

  it('leaves records outside the automatic sleep shape to their existing hidden cold restore', async () => {
    const { connectPanePty } = await import('./pty-connection')
    seedRestartedSplitTab(sleptRecord({}))
    const transport = queueSleptPaneTransport()

    connectSleptPane(connectPanePty, { current: false })
    await settleConnects()

    expect(resumeConnects(transport)).toHaveLength(1)
  })
})
