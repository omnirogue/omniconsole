import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { toAppSshPtyId } from '../../../../../shared/ssh-pty-id'
import { flushAsyncTicks } from '../pty-connection-test-async'
import {
  LEAF_1,
  LEAF_2,
  createManager,
  createMockTransport,
  createPane
} from '../pty-connection-test-pane-fixtures'
import type { ConnectCallbacks, MockTransport } from '../pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from '../pty-connection-test-deps'
import { createInitialStoreState } from '../pty-connection-test-store-fixtures'
import type { StoreState } from '../pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../pty-connection-test-environment'

// Why: a quit or periodic capture writes no sleeping record for an agent that sat 'done', so after
// a restart that agent comes back as a hydrated 'done' row (restoredUnconfirmed) alone — Sal's
// store held 10 such rows on 2026-09-30. The connect gate read "no record, not mid-turn" as nothing
// to guard, so a mount no person asked for resumed the agent: an SSH tab whose remote PTYs died
// (cold-activation deferral is local-only, and the SSH_SESSION_EXPIRED fallback re-read the same
// verdict), or a local split tab mounted because a sibling's PTY is alive. These pin 0 starts for
// such a mount, exactly one start in the person lane on a reveal, and G5 for a mid-turn row.

const { scheduleRuntimeGraphSync, resetAndRefreshAllTerminalWebglAtlases } = vi.hoisted(() => ({
  scheduleRuntimeGraphSync: vi.fn(),
  resetAndRefreshAllTerminalWebglAtlases: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []

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
  createIpcPtyTransport: vi.fn(() => {
    const next = transportFactoryQueue.shift()
    if (!next) {
      throw new Error('No mock transport queued')
    }
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
}
type Deps = ReturnType<typeof buildPaneConnectionDeps>
type ConnectOptions = {
  command?: string
  sessionId?: string
  launchPriority?: string
  launchAdmissionKey?: string
  callbacks?: ConnectCallbacks
}
type Topology = 'ssh' | 'split'
type HostTransport = { transport: MockTransport; started: ConnectOptions[] }
type Mounted = {
  binding: Binding
  transport: MockTransport
  deps: Deps
  /** Every agent start the host actually made (a connect that ran its command). */
  started: ConnectOptions[]
}

const TAB_ID = 'tab-0'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_1)
const THREAD_ID = '019a0000-0000-7000-8000-000000000007'
const SSH_PTY_ID = toAppSshPtyId('ssh-a', 'remote-pty-0')

const TOPOLOGIES: [string, Topology][] = [
  ['an SSH tab whose remote PTYs died', 'ssh'],
  ["a local split tab mounted for its sibling's live PTY", 'split']
]

/** The pane's hook row with no sleeping record: hydrated from last-status.json after a restart
 *  (restoredUnconfirmed), or a live one. */
function statusRow(state: 'done' | 'working', restoredUnconfirmed: boolean) {
  return {
    paneKey: PANE_KEY,
    state,
    prompt: '',
    agentType: 'codex',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    providerSession: { key: 'session_id', id: THREAD_ID },
    // A typical final summary: the text heuristic must not read it as an ask that releases.
    lastAssistantMessage: 'Done:\n1. Fixed the restore flood\n2. Added tests',
    ...(restoredUnconfirmed ? { restoredUnconfirmed: true } : {})
  }
}

function seed(topology: Topology, row: ReturnType<typeof statusRow>): void {
  mockStoreState = {
    ...mockStoreState,
    pendingStartupByTabId: {},
    lastTerminalInputAtByPaneKey: {},
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: {},
    agentStatusByPaneKey: { [PANE_KEY]: row },
    ...(topology === 'ssh'
      ? {
          tabsByWorktree: { 'wt-1': [{ id: TAB_ID, ptyId: SSH_PTY_ID }] },
          ptyIdsByTabId: {},
          repos: [{ id: 'repo1', connectionId: 'ssh-a' }],
          sshConnectionStates: new Map([['ssh-a', { status: 'connected' }]])
        }
      : {
          tabsByWorktree: { 'wt-1': [{ id: TAB_ID, ptyId: 'sibling-0' }] },
          ptyIdsByTabId: { [TAB_ID]: ['lost-0', 'sibling-0'] }
        })
  } as unknown as StoreState
  // pty:hasPty cannot vouch for an SSH relay's PTY; locally only the sibling's shell still runs.
  vi.mocked(window.api.pty.hasPty).mockImplementation(
    async (ptyId: string) => (topology === 'ssh' ? null : ptyId === 'sibling-0') as boolean
  )
}

/** Answers like the real host: the SSH relay expires every reattach (its PTYs died with the
 *  remote), so only a fresh spawn starts the agent; locally main cold-restores the gone PTY and
 *  runs the reattach's command. */
function hostTransport(topology: Topology): HostTransport {
  const transport = createMockTransport(null)
  const started: ConnectOptions[] = []
  const answer = transport.connect.getMockImplementation() as (
    options: ConnectOptions
  ) => Promise<unknown>
  if (topology === 'ssh') {
    transport.getConnectionId.mockReturnValue('ssh-a')
  }
  transport.connect.mockImplementation(async (options: ConnectOptions) => {
    if (topology === 'ssh' && options.sessionId) {
      options.callbacks?.onError?.(`SSH_SESSION_EXPIRED: ${options.sessionId}`)
      return undefined
    }
    if (options.command) {
      started.push(options)
    }
    return topology === 'ssh' ? 'fresh-ssh-pty' : answer(options)
  })
  return { transport, started }
}

async function settle(): Promise<void> {
  await flushAsyncTicks(30)
  // Past the 250 ms connect fallback timer, so a deferred connect would have run.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await flushAsyncTicks(30)
}

/** A mount no person asked for: the pane is hidden and nobody touched it. */
async function mountInBackground(topology: Topology): Promise<Mounted> {
  const { connectPanePty } = await import('../pty-connection')
  const { transport, started } = hostTransport(topology)
  transportFactoryQueue.push(transport)
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    tabId: TAB_ID,
    restoredLeafId: LEAF_1,
    restoredPtyIdByLeafId:
      topology === 'ssh' ? { [LEAF_1]: SSH_PTY_ID } : { [LEAF_1]: 'lost-0', [LEAF_2]: 'sibling-0' },
    isActiveRef: { current: false },
    isVisibleRef: { current: false },
    onClearSessionRestoredBanner: vi.fn()
  })
  const binding = connectPanePty(
    createPane(1) as never,
    createManager(topology === 'ssh' ? 1 : 2) as never,
    deps as never
  ) as unknown as Binding
  await settle()
  return { binding, transport, deps, started }
}

/** What use-terminal-pane-lifecycle runs when a person brings the pane on screen. */
function revealOnDesktop(entry: Mounted): void {
  entry.deps.isVisibleRef.current = true
  entry.binding.noteVisibilityResume()
  entry.binding.noteRevealed()
}

describe('restore flood guard: an agent whose only resume is its status row', () => {
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

  it.each(TOPOLOGIES)(
    "%s: a hydrated 'done' row with no record, mounted in the background, starts no agent",
    async (_label, topology) => {
      seed(topology, statusRow('done', true))
      const entry = await mountInBackground(topology)

      expect(entry.started).toEqual([])
      // Held means no PTY at all: no reattach that could run the resume, and no bare shell.
      expect(entry.transport.connect).not.toHaveBeenCalled()
      expect(entry.deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'held')
    }
  )

  it.each(TOPOLOGIES)(
    '%s: a desktop reveal starts it exactly once, in the person lane',
    async (_label, topology) => {
      seed(topology, statusRow('done', true))
      const entry = await mountInBackground(topology)
      expect(entry.started).toEqual([])

      revealOnDesktop(entry)
      await settle()
      // A second reveal (a tab switch back, a later visibility flip) starts nothing more.
      entry.binding.noteVisibilityResume()
      entry.binding.noteRevealed()
      await settle()

      expect(entry.started).toHaveLength(1)
      expect(entry.started[0].command).toContain(THREAD_ID)
      expect(entry.started[0]).toMatchObject({
        launchPriority: 'person',
        launchAdmissionKey: PANE_KEY
      })
    }
  )

  it.each(TOPOLOGIES)(
    "%s: the phone's per-terminal open starts it exactly once, in the person lane",
    async (_label, topology) => {
      seed(topology, statusRow('done', true))
      const entry = await mountInBackground(topology)
      expect(entry.started).toEqual([])
      const { revealTerminalTabForPerson } = await import('./cold-restore-reveal-hold')

      revealTerminalTabForPerson(TAB_ID)
      await settle()
      revealTerminalTabForPerson(TAB_ID)
      await settle()

      expect(entry.started).toHaveLength(1)
      expect(entry.started[0].command).toContain(THREAD_ID)
      expect(entry.started[0]).toMatchObject({
        launchPriority: 'person',
        launchAdmissionKey: PANE_KEY
      })
    }
  )

  it.each(TOPOLOGIES)(
    "%s: a 'working' live row with no record still auto-continues in the background (G5)",
    async (_label, topology) => {
      seed(topology, statusRow('working', false))
      const entry = await mountInBackground(topology)

      expect(entry.started).toHaveLength(1)
      expect(entry.started[0].command).toContain(THREAD_ID)
      expect(entry.started[0].launchPriority).toBeUndefined()
      expect(entry.deps.onShowSessionRestoredBanner).not.toHaveBeenCalledWith(1, 'held')
    }
  )
})
