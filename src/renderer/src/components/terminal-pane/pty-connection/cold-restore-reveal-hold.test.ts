import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { flushAsyncTicks } from '../pty-connection-test-async'
import {
  LEAF_1,
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

// Why: the 2026-09-30 restore flood — a background mount of one folder workspace resumed 51
// finished agents (origin 'worktree-sleep', state 'done', no restoreOnTabOpenOnly) in a minute.
// These cases pin that such a mount starts no agent and spawns no PTY, that a person's reveal
// starts exactly that pane, and that the safety guards (G1-G5) and the kill switch hold.

const { scheduleRuntimeGraphSync, resetAndRefreshAllTerminalWebglAtlases, storeListeners } =
  vi.hoisted(() => ({
    scheduleRuntimeGraphSync: vi.fn(),
    resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
    storeListeners: new Set<(state: unknown, previous: unknown) => void>()
  }))

/** A store change the panes' subscriptions hear (the mock store does not notify by itself). */
function notifyStore(): void {
  for (const listener of Array.from(storeListeners)) {
    listener(mockStoreState, mockStoreState)
  }
}

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
    subscribe: (listener: (state: unknown, previous: unknown) => void) => {
      storeListeners.add(listener)
      return () => storeListeners.delete(listener)
    }
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
  wakeHibernatedAgentIfArmed: (claimed?: Set<string>) => string | null
  dispose: () => void
}
type Deps = ReturnType<typeof buildPaneConnectionDeps>
type ConnectOptions = {
  command?: string
  sessionId?: string
  launchPriority?: string
  launchAdmissionKey?: string
}
type Mounted = { binding: Binding; transport: MockTransport; deps: Deps }
type RecordOverrides = Record<string, unknown>

const NOW = Date.now()

function threadId(index: number): string {
  return `019a0000-0000-7000-8000-${String(index).padStart(12, '0')}`
}

function paneKeyOf(tabId: string): string {
  return makePaneKey(tabId, LEAF_1)
}

/** What completed-agent hibernation writes: finished, slept, and NOT restoreOnTabOpenOnly. */
function sleepRecord(tabId: string, index: number, overrides: RecordOverrides = {}) {
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
    ...overrides
  }
}

function seedRestoredTabs(count: number, overrides: RecordOverrides = {}): void {
  const tabs = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    ptyId: `lost-${index}`
  }))
  mockStoreState = {
    ...mockStoreState,
    tabsByWorktree: { 'wt-1': tabs },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      tabs.map((tab, index) => [paneKeyOf(tab.id), sleepRecord(tab.id, index, overrides)])
    )
  } as unknown as StoreState
}

async function mountPane(
  tabId: string,
  overrides: Record<string, unknown> = {},
  transport: MockTransport = createMockTransport(null)
): Promise<Mounted> {
  const { connectPanePty } = await import('../pty-connection')
  transportFactoryQueue.push(transport)
  const index = tabId.replace('tab-', '')
  const deps = buildPaneConnectionDeps(() => mockStoreState, {
    tabId,
    restoredLeafId: LEAF_1,
    restoredPtyIdByLeafId: { [LEAF_1]: `lost-${index}` },
    isActiveRef: { current: false },
    isVisibleRef: { current: false },
    onClearSessionRestoredBanner: vi.fn(),
    ...overrides
  })
  const binding = connectPanePty(
    createPane(1) as never,
    createManager(1) as never,
    deps as never
  ) as unknown as Binding
  return { binding, transport, deps }
}

async function mountAll(count: number): Promise<Mounted[]> {
  const mounted: Mounted[] = []
  for (let index = 0; index < count; index += 1) {
    mounted.push(await mountPane(`tab-${index}`))
  }
  await flushAsyncTicks(30)
  return mounted
}

function connectOptions(transport: MockTransport): ConnectOptions[] {
  return transport.connect.mock.calls.map(([options]) => options as ConnectOptions)
}

function agentStarts(transports: MockTransport[]): ConnectOptions[] {
  return transports.flatMap(connectOptions).filter((options) => Boolean(options.command))
}

function patchRecord(tabId: string, patch: RecordOverrides): void {
  Object.assign(mockStoreState.sleepingAgentSessionsByPaneKey[paneKeyOf(tabId)] as object, patch)
}

function setStoreField(field: string, value: unknown): void {
  mockStoreState = { ...mockStoreState, [field]: value } as unknown as StoreState
}

describe('restore flood guard: background mounts of slept agents', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeListeners.clear()
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(false)
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('51 background-mounted slept agents: 0 agent starts and 0 PTY spawns', async () => {
    seedRestoredTabs(51)
    const mounted = await mountAll(51)

    const transports = mounted.map((entry) => entry.transport)
    expect(agentStarts(transports)).toHaveLength(0)
    // Held means no PTY at all — not even a bare login shell that would strand the resume.
    expect(transports.every((transport) => transport.connect.mock.calls.length === 0)).toBe(true)
    for (const { deps } of mounted) {
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'held')
    }
  })

  it('a reveal starts exactly that one pane, in the admission priority lane', async () => {
    seedRestoredTabs(51)
    const mounted = await mountAll(51)

    const opened = mounted[7]
    opened.deps.isVisibleRef.current = true
    opened.binding.noteRevealed()
    await flushAsyncTicks(30)

    const starts = agentStarts(mounted.map((entry) => entry.transport))
    expect(starts).toHaveLength(1)
    expect(starts[0].command).toContain(threadId(7))
    expect(starts[0].launchPriority).toBe('person')
    expect(starts[0].launchAdmissionKey).toBe(paneKeyOf('tab-7'))
    expect(connectOptions(opened.transport)).toHaveLength(1)
  })

  it("the phone's per-terminal open reveals that one tab only", async () => {
    seedRestoredTabs(3)
    const mounted = await mountAll(3)
    const { revealTerminalTabForPerson } = await import('./cold-restore-reveal-hold')

    revealTerminalTabForPerson('tab-1')
    await flushAsyncTicks(30)

    const starts = agentStarts(mounted.map((entry) => entry.transport))
    expect(starts).toHaveLength(1)
    expect(starts[0].command).toContain(threadId(1))
    expect(starts[0].launchPriority).toBe('person')
  })

  it("keeps resuming 'quit' and 'live' agents that were mid-task (G5), in the background", async () => {
    seedRestoredTabs(3, { origin: 'quit', state: 'working' })
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKeyOf('tab-2')] = sleepRecord('tab-2', 2, {
      origin: 'live',
      state: 'working'
    }) as never
    const mounted = await mountAll(3)

    const starts = agentStarts(mounted.map((entry) => entry.transport))
    expect(starts).toHaveLength(3)
    expect(starts.every((options) => options.launchPriority === undefined)).toBe(true)
  })

  it("an SSH workspace activation mounts its tabs at once, yet resumes no idle 'quit' agent", async () => {
    // Cold-activation deferral covers local hosts only; the connect gate holds the rest.
    const { toAppSshPtyId } = await import('../../../../../shared/ssh-pty-id')
    const sshPtyId = toAppSshPtyId('ssh-a', 'remote-pty-0')
    seedRestoredTabs(1, { origin: 'quit', state: 'done' })
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-0', ptyId: sshPtyId }] },
      repos: [{ id: 'repo1', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([['ssh-a', { status: 'disconnected' }]]),
      deferredSshReconnectTargets: ['ssh-a'],
      deferredSshSessionIdsByTabId: { 'tab-0': sshPtyId }
    } as unknown as StoreState
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(null as never)
    const transport = createMockTransport(null)
    transport.getConnectionId.mockReturnValue('ssh-a')
    const { deps } = await mountPane(
      'tab-0',
      { restoredPtyIdByLeafId: { [LEAF_1]: sshPtyId } },
      transport
    )
    await flushAsyncTicks(30)
    await new Promise((resolve) => setTimeout(resolve, 70))

    expect(transport.connect).not.toHaveBeenCalled()
    expect(window.api.ssh.connect).not.toHaveBeenCalled()
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'held')
  })

  it('holds tab-open-only and first-reveal records too', async () => {
    seedRestoredTabs(2, { origin: 'quit', state: 'done' })
    patchRecord('tab-0', {
      restoreOnTabOpenOnly: true
    })
    patchRecord('tab-1', {
      resumeOnFirstReveal: true
    })
    const mounted = await mountAll(2)
    expect(agentStarts(mounted.map((entry) => entry.transport))).toHaveLength(0)
  })

  it('holds an archived pane, even one whose agent was mid-task (#921)', async () => {
    seedRestoredTabs(2, { origin: 'quit', state: 'done' })
    patchRecord('tab-1', {
      state: 'working'
    })
    const { setPutAwayPaneReader } = await import('@/lib/restore-flood-resume-verdict')
    setPutAwayPaneReader(() => true)
    const mounted = await mountAll(2)

    const transports = mounted.map((entry) => entry.transport)
    // The interrupted-restore auto-continue skips put-away panes; a background mount must too.
    expect(agentStarts(transports)).toHaveLength(0)
    expect(transports.every((transport) => transport.connect.mock.calls.length === 0)).toBe(true)

    // Sal opens the archived tab himself: that reveal resumes it.
    mounted[1].deps.isVisibleRef.current = true
    mounted[1].binding.noteRevealed()
    await flushAsyncTicks(30)
    expect(agentStarts([mounted[1].transport])).toHaveLength(1)
  })

  it('51 slept agents with realistic last messages: 0 starts and 0 PTY spawns, records kept', async () => {
    // A typical final message is a numbered summary or ends with a question; as a release from the
    // background that text resumed most of the 51 agents. A held resume loses nothing (G1): the
    // record stays resumable and opening the tab resumes it in the priority lane.
    seedRestoredTabs(51)
    const finals = [
      'Done:\n1. Fixed the restore flood\n2. Added tests\n3. Pushed the branch',
      'Want me to open a PR?',
      'Before I go on:\n1. Ship it today?\n2. Keep the flag on\n3. Tell Uma'
    ]
    for (let index = 0; index < 51; index += 1) {
      patchRecord(`tab-${index}`, { lastAssistantMessage: finals[index % finals.length] })
    }
    const mounted = await mountAll(51)

    const transports = mounted.map((entry) => entry.transport)
    expect(transports.every((transport) => transport.connect.mock.calls.length === 0)).toBe(true)
    expect(Object.keys(mockStoreState.sleepingAgentSessionsByPaneKey)).toHaveLength(51)

    mounted[2].deps.isVisibleRef.current = true
    mounted[2].binding.noteRevealed()
    await flushAsyncTicks(30)
    const starts = agentStarts(transports)
    expect(starts).toHaveLength(1)
    expect(starts[0].command).toContain(threadId(2))
    expect(starts[0].launchPriority).toBe('person')
  })

  it('51 slept agents whose hook rows came back after a restart: 0 starts, 0 PTY spawns', async () => {
    // Main hydrates each pane's last hook row from last-status.json (restoredUnconfirmed): the final
    // numbered summary or question, and for an agent that sat at a prompt its state and prompt. No
    // such row is a live ask or a live turn, so none may release a held resume.
    seedRestoredTabs(51)
    const finals = [
      'Done:\n1. Fixed the restore flood\n2. Added tests\n3. Pushed the branch',
      'Want me to open a PR?',
      'Before I go on:\n1. Ship it today?\n2. Keep the flag on\n3. Tell Uma'
    ]
    const states = ['done', 'waiting', 'blocked'] as const
    for (let index = 0; index < 51; index += 1) {
      const paneKey = paneKeyOf(`tab-${index}`)
      const state = states[index % states.length]
      const lastAssistantMessage = finals[index % finals.length]
      // A finished sleep, or the idle 'quit' checkpoint of an agent that sat at a prompt.
      patchRecord(`tab-${index}`, {
        lastAssistantMessage,
        ...(state === 'done' ? {} : { origin: 'quit', state })
      })
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        paneKey,
        state,
        prompt: '',
        agentType: 'codex',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        providerSession: { key: 'session_id', id: threadId(index) },
        lastAssistantMessage,
        ...(state === 'done'
          ? {}
          : { interactivePrompt: 'Allow git push?', restoredUnconfirmed: true })
      } as never
    }
    const mounted = await mountAll(51)

    const transports = mounted.map((entry) => entry.transport)
    expect(agentStarts(transports)).toHaveLength(0)
    expect(transports.every((transport) => transport.connect.mock.calls.length === 0)).toBe(true)
    expect(Object.keys(mockStoreState.sleepingAgentSessionsByPaneKey)).toHaveLength(51)
  })

  it("holds 'quit' and 'live' agents that were idle, not mid-task, on any background mount", async () => {
    // What a quit writes for an agent idle at its prompt; a split tab mounted for a sibling's live
    // PTY, or an SSH or runtime-host activation, reaches these panes too.
    seedRestoredTabs(3, { origin: 'quit', state: 'done' })
    patchRecord('tab-1', { origin: 'live' })
    patchRecord('tab-2', { state: 'waiting' })
    const mounted = await mountAll(3)

    const transports = mounted.map((entry) => entry.transport)
    expect(transports.every((transport) => transport.connect.mock.calls.length === 0)).toBe(true)
    for (const { deps } of mounted) {
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'held')
    }
  })

  it('resumes a pane a person touched in the last 10 minutes (G2), not 11 minutes ago', async () => {
    seedRestoredTabs(2)
    setStoreField('lastTerminalInputAtByPaneKey', {
      [paneKeyOf('tab-0')]: Date.now() - 9 * 60_000,
      [paneKeyOf('tab-1')]: Date.now() - 11 * 60_000
    })
    const mounted = await mountAll(2)

    expect(agentStarts([mounted[0].transport])).toHaveLength(1)
    expect(agentStarts([mounted[1].transport])).toHaveLength(0)
  })

  it('resumes a visible pane (G3), such as a grid tile on screen', async () => {
    seedRestoredTabs(1)
    const { transport } = await mountPane('tab-0', { isVisibleRef: { current: true } })
    await flushAsyncTicks(30)
    expect(agentStarts([transport])).toHaveLength(1)
  })

  it('re-reads every guard right before it acts (G4), not once per pass', async () => {
    seedRestoredTabs(1)
    let answer: (live: boolean) => void = () => {}
    vi.mocked(window.api.pty.hasPty).mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (answer = resolve))
    )
    const { transport, deps } = await mountPane('tab-0')
    await flushAsyncTicks(10)
    // While the liveness probe is out, the pane comes on screen.
    deps.isVisibleRef.current = true
    answer(false)
    await flushAsyncTicks(30)
    expect(agentStarts([transport])).toHaveLength(1)
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalledWith(1, 'held')
  })

  it('reattaches a hidden slept pane whose PTY still runs (main runs no command for it)', async () => {
    seedRestoredTabs(1)
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(true)
    const { transport, deps } = await mountPane('tab-0')
    await flushAsyncTicks(30)

    // The one connect names the live PTY (main's isLivePtyReattach never runs or admits its
    // command); no fresh spawn follows it.
    const calls = connectOptions(transport)
    expect(calls).toHaveLength(1)
    expect(calls[0].sessionId).toBe('lost-0')
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalledWith(1, 'held')
  })

  it('holds when that live reattach finds only the empty shell passive hibernation left', async () => {
    seedRestoredTabs(1)
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(true)
    const transport = createMockTransport(null)
    const reattach = transport.connect.getMockImplementation() as (options: {
      sessionId?: string
    }) => Promise<unknown>
    // The agent was killed; its shell was adopted: a reattach with no snapshot, replay or restore.
    transport.connect.mockImplementationOnce(async (options: { sessionId?: string }) => {
      await reattach(options)
      return { id: options.sessionId, isReattach: true }
    })
    const { deps } = await mountPane('tab-0', {}, transport)
    await flushAsyncTicks(30)

    // The fallback re-read the verdict (G4): no fresh spawn with the resume, the pane holds.
    const calls = connectOptions(transport)
    expect(calls).toHaveLength(1)
    expect(calls[0].sessionId).toBe('lost-0')
    expect(transport.disconnect).toHaveBeenCalled()
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'held')
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKeyOf('tab-0')]).toBeTruthy()
  })

  it("probes the PTY the reattach would use, never a split sibling's live PTY", async () => {
    seedRestoredTabs(1)
    // This leaf has no PTY of its own; the tab's PTY belongs to its sibling's live shell.
    mockStoreState.tabsByWorktree = { 'wt-1': [{ id: 'tab-0', ptyId: 'pty-sibling' }] } as never
    vi.mocked(window.api.pty.hasPty).mockImplementation(async (id: string) => id === 'pty-sibling')
    const sibling = createMockTransport('pty-sibling')
    const { transport, deps } = await mountPane('tab-0', {
      restoredPtyIdByLeafId: {},
      paneTransportsRef: { current: new Map([[2, sibling]]) }
    })
    await flushAsyncTicks(30)

    expect(window.api.pty.hasPty).not.toHaveBeenCalledWith('pty-sibling')
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'held')
  })

  it('keeps the earlier eager restore when the guard is switched off', async () => {
    seedRestoredTabs(51)
    mockStoreState.settings = { ...mockStoreState.settings, restoreFloodGuard: false } as never
    const mounted = await mountAll(51)

    const starts = agentStarts(mounted.map((entry) => entry.transport))
    expect(starts).toHaveLength(51)
    // The kill switch covers main's admission window too: no start names a pane or a lane for it.
    expect(starts.every((options) => !options.launchAdmissionKey && !options.launchPriority)).toBe(
      true
    )
  })

  it('with the guard off a start waiting on main is not held in flight (parking, paste wait)', async () => {
    seedRestoredTabs(2)
    const pending = (): MockTransport => {
      const transport = createMockTransport(null)
      transport.connect.mockImplementation(() => new Promise(() => {}))
      return transport
    }
    const settings = mockStoreState.settings
    mockStoreState.settings = { ...settings, restoreFloodGuard: false } as never
    const off = await mountPane('tab-0', { isVisibleRef: { current: true } }, pending())
    await flushAsyncTicks(30)
    mockStoreState.settings = { ...settings, restoreFloodGuard: true } as never
    const on = await mountPane('tab-1', { isVisibleRef: { current: true } }, pending())
    await flushAsyncTicks(30)

    expect(agentStarts([off.transport, on.transport])).toHaveLength(2)
    const { isAgentStartInFlightForTab } = await import('@/lib/agent-start-in-flight')
    expect(isAgentStartInFlightForTab('tab-0')).toBe(false)
    expect(isAgentStartInFlightForTab('tab-1')).toBe(true)
  })
})

describe('restore flood guard: duplicate resumes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeListeners.clear()
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(false)
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  function addOtherPane(
    tabId: string,
    ptyId: string,
    live: boolean,
    // What the pane's foreground sample shows: its agent idle at the prompt by default.
    foreground: { agent: string | null; shellForeground: boolean } | null = {
      agent: 'codex',
      shellForeground: false
    }
  ): void {
    const paneKey = paneKeyOf(tabId)
    mockStoreState.tabsByWorktree['wt-1'].push({ id: tabId, ptyId } as never)
    if (live) {
      mockStoreState.ptyIdsByTabId = { ...mockStoreState.ptyIdsByTabId, [tabId]: [ptyId] }
    }
    if (live && foreground) {
      mockStoreState.paneForegroundAgentByPaneKey[paneKey] = foreground as never
    }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'done',
      prompt: '',
      agentType: 'codex',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      providerSession: { key: 'session_id', id: threadId(0) }
    } as never
  }

  it('does not resume a session a live OmniConsole PTY already runs (idle at done)', async () => {
    seedRestoredTabs(1)
    addOtherPane('tab-live', 'live-pty', true)
    const { transport, deps } = await mountPane('tab-0', { isVisibleRef: { current: true } })
    await flushAsyncTicks(30)

    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'duplicate')
  })

  it('asks the provider about a pane it has not bound, and trusts only a live answer', async () => {
    seedRestoredTabs(2)
    patchRecord('tab-1', {
      providerSession: { key: 'session_id', id: threadId(0) }
    })
    addOtherPane('tab-cold', 'cold-pty', false)
    vi.mocked(window.api.pty.hasPty).mockImplementation(async (id: string) => id === 'cold-pty')
    // Its done row is backed by the agent still in the PTY's foreground.
    vi.mocked(window.api.pty.getForegroundProcess).mockImplementation(async (id: string) =>
      id === 'cold-pty' ? 'codex' : null
    )
    const blocked = await mountPane('tab-0', { isVisibleRef: { current: true } })
    await flushAsyncTicks(30)
    expect(blocked.transport.connect).not.toHaveBeenCalled()
    expect(blocked.deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'duplicate')

    vi.mocked(window.api.pty.hasPty).mockResolvedValue(false)
    const resumed = await mountPane('tab-1', { isVisibleRef: { current: true } })
    await flushAsyncTicks(30)
    expect(agentStarts([resumed.transport])).toHaveLength(1)
  })

  it("resumes when the other pane's done row is history: its agent exited back to the shell", async () => {
    seedRestoredTabs(1)
    // Tab A finished and the person typed /exit: a live zsh PTY still holding the done row.
    addOtherPane('tab-live', 'live-pty', true, { agent: null, shellForeground: true })
    const { transport, deps } = await mountPane('tab-0', { isVisibleRef: { current: true } })
    await flushAsyncTicks(30)
    expect(agentStarts([transport])).toHaveLength(1)
    expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalledWith(1, 'duplicate')
  })

  it('probes a done row with no foreground sample, and resumes when the PTY shows its shell', async () => {
    seedRestoredTabs(1)
    addOtherPane('tab-live', 'live-pty', true, null)
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('zsh')
    const { transport } = await mountPane('tab-0', { isVisibleRef: { current: true } })
    await flushAsyncTicks(30)
    expect(window.api.pty.getForegroundProcess).toHaveBeenCalledWith('live-pty')
    expect(agentStarts([transport])).toHaveLength(1)
  })

  it('a visible duplicate pane resumes by itself once the owning pane goes away', async () => {
    seedRestoredTabs(1)
    addOtherPane('tab-live', 'live-pty', true)
    const { transport, deps } = await mountPane('tab-0', { isVisibleRef: { current: true } })
    await flushAsyncTicks(30)
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'duplicate')

    // Unrelated store churn while the owner still runs changes nothing.
    notifyStore()
    await flushAsyncTicks(10)
    expect(transport.connect).not.toHaveBeenCalled()

    // Sal closes tab A: its PTY binding and status row go away. Tab 0 stays on screen.
    mockStoreState.ptyIdsByTabId = {}
    delete mockStoreState.agentStatusByPaneKey[paneKeyOf('tab-live')]
    notifyStore()
    await flushAsyncTicks(30)
    expect(agentStarts([transport])).toHaveLength(1)
    expect(deps.onClearSessionRestoredBanner).toHaveBeenCalledWith(1, 'duplicate')
  })

  it('never treats a sleeping record as a live copy of the session', async () => {
    seedRestoredTabs(1)
    // The same thread asleep in another pane is resumable, not running.
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKeyOf('tab-other')] = sleepRecord(
      'tab-other',
      0
    ) as never
    let ownRecordAtStart: unknown = null
    const transport = createMockTransport(null)
    transport.connect.mockImplementationOnce(async (opts: { sessionId?: string }) => {
      ownRecordAtStart = mockStoreState.sleepingAgentSessionsByPaneKey[paneKeyOf('tab-0')]
      return { id: opts.sessionId }
    })
    await mountPane('tab-0', { isVisibleRef: { current: true } }, transport)
    await flushAsyncTicks(30)
    expect(agentStarts([transport])).toHaveLength(1)
    // Starting the resume never deletes the record; it clears after the replacement is confirmed.
    expect(ownRecordAtStart).toBeTruthy()
  })

  it('skips a reveal-resume while the same session is already starting in another pane', async () => {
    seedRestoredTabs(1)
    const { claimProviderSessionLaunch } = await import('@/lib/live-provider-session-owner')
    claimProviderSessionLaunch(paneKeyOf('tab-9'), 'codex', { key: 'session_id', id: threadId(0) })
    const { transport, deps } = await mountPane('tab-0', { isVisibleRef: { current: true } })
    await flushAsyncTicks(30)
    expect(transport.connect).not.toHaveBeenCalled()
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'duplicate')
  })
})

describe('restore flood guard: starts waiting in the admission queue', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeListeners.clear()
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(false)
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  function queuedTransport(): MockTransport {
    const transport = createMockTransport(null)
    // Main holds the start in its admission queue: the connect does not settle.
    transport.connect.mockImplementation(() => new Promise(() => {}))
    return transport
  }

  it('keeps the duplicate check while the first resume waits past the 60 s claim TTL', async () => {
    seedRestoredTabs(2)
    patchRecord('tab-1', {
      providerSession: { key: 'session_id', id: threadId(0) }
    })
    const first = queuedTransport()
    await mountPane('tab-0', { isVisibleRef: { current: true } }, first)
    await flushAsyncTicks(30)
    expect(agentStarts([first])).toHaveLength(1)

    // 70 s later the first start is still queued (51 starts at 3 per 10 s take ~170 s).
    const later = Date.now() + 70_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    const second = await mountPane('tab-1', { isVisibleRef: { current: true } })
    await flushAsyncTicks(30)

    expect(second.transport.connect).not.toHaveBeenCalled()
    expect(second.deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'duplicate')
  })

  it('a reveal promotes a queued deferred SSH session resume, like the other connect paths', async () => {
    const { toAppSshPtyId } = await import('../../../../../shared/ssh-pty-id')
    const sshPtyId = toAppSshPtyId('ssh-a', 'remote-pty-0')
    seedRestoredTabs(1, { origin: 'quit', state: 'working' })
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-0', ptyId: sshPtyId }] },
      repos: [{ id: 'repo1', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([['ssh-a', { status: 'disconnected' }]]),
      deferredSshReconnectTargets: ['ssh-a'],
      deferredSshSessionIdsByTabId: { 'tab-0': sshPtyId }
    } as unknown as StoreState
    const promoteAgentLaunch = vi.fn(async () => true)
    ;(window.api.pty as unknown as Record<string, unknown>).promoteAgentLaunch = promoteAgentLaunch
    const transport = queuedTransport()
    transport.getConnectionId.mockReturnValue('ssh-a')
    const { binding } = await mountPane(
      'tab-0',
      { restoredPtyIdByLeafId: { [LEAF_1]: sshPtyId } },
      transport
    )
    await flushAsyncTicks(30)
    await new Promise((resolve) => setTimeout(resolve, 70))

    const starts = agentStarts([transport])
    expect(starts).toHaveLength(1)
    expect(starts[0].sessionId).toBe(sshPtyId)
    expect(starts[0].launchAdmissionKey).toBe(paneKeyOf('tab-0'))
    expect(window.api.ssh.connect).toHaveBeenCalledWith({ targetId: 'ssh-a' })

    // Sal opens the tab while the resume still waits behind the background backlog.
    binding.noteRevealed()
    expect(promoteAgentLaunch).toHaveBeenCalledWith(paneKeyOf('tab-0'))
  })
})

describe('restore flood guard: hibernated pane wake', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeListeners.clear()
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  async function hibernatedPane(recordOverrides: RecordOverrides = {}): Promise<Mounted> {
    const { connectPanePty } = await import('../pty-connection')
    const transport = createMockTransport('pty-pane-1')
    transportFactoryQueue.push(transport)
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      consumeSuppressedPtyExit: vi.fn(() => true),
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      onClearSessionRestoredBanner: vi.fn()
    })
    const paneKey = paneKeyOf('tab-1')
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
      ...sleepRecord('tab-1', 0),
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernated' },
      ...recordOverrides
    } as never
    mockStoreState.suppressedPtyExitIds['tab-pty'] = true
    const binding = connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      deps as never
    ) as unknown as Binding
    await flushAsyncTicks(30)
    // The hidden pane reattached its still-running PTY.
    expect((transport.getPtyId as unknown as () => string | null)()).toBe('tab-pty')
    const { createIpcPtyTransport } = await import('../pty-transport')
    const exit = vi.mocked(createIpcPtyTransport).mock.calls[0]?.[0] as {
      onPtyExit?: (ptyId: string) => void
    }
    // Hibernation kills it while hidden.
    exit.onPtyExit?.('tab-pty')
    await flushAsyncTicks(30)
    return { binding, transport, deps }
  }

  it('the phone opening the whole workspace does not wake a finished agent nobody sees', async () => {
    const { binding, transport } = await hibernatedPane()
    const before = transport.connect.mock.calls.length

    expect(binding.wakeHibernatedAgentIfArmed(new Set())).toBeNull()
    await flushAsyncTicks(30)
    expect(transport.connect.mock.calls.length).toBe(before)
  })

  it('wakes once the pane is visible (G3)', async () => {
    const { binding, transport, deps } = await hibernatedPane()
    const before = transport.connect.mock.calls.length

    deps.isVisibleRef.current = true
    binding.noteVisibilityResume()
    await flushAsyncTicks(30)
    expect(transport.connect.mock.calls.length).toBe(before + 1)
    expect(connectOptions(transport).at(-1)?.command).toContain('sess-hibernated')
  })

  function addOwnerOfHibernatedSession(): void {
    const paneKey = paneKeyOf('tab-owner')
    mockStoreState.tabsByWorktree['wt-1'].push({ id: 'tab-owner', ptyId: 'owner-pty' } as never)
    mockStoreState.ptyIdsByTabId = { ...mockStoreState.ptyIdsByTabId, 'tab-owner': ['owner-pty'] }
    mockStoreState.agentStatusByPaneKey[paneKey] = {
      paneKey,
      state: 'working',
      prompt: '',
      agentType: 'claude',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      providerSession: { key: 'session_id', id: 'sess-hibernated' }
    } as never
  }

  it('does not wake a second copy of a session another pane runs, until that pane goes away', async () => {
    const { binding, transport, deps } = await hibernatedPane()
    const before = transport.connect.mock.calls.length
    addOwnerOfHibernatedSession()

    deps.isVisibleRef.current = true
    binding.noteVisibilityResume()
    await flushAsyncTicks(30)
    expect(transport.connect.mock.calls.length).toBe(before)
    expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'duplicate')

    // The owner closes while the hibernated pane stays on screen: it wakes by itself, once.
    mockStoreState.ptyIdsByTabId = { 'tab-1': ['tab-pty'] }
    delete mockStoreState.agentStatusByPaneKey[paneKeyOf('tab-owner')]
    notifyStore()
    await flushAsyncTicks(30)
    expect(transport.connect.mock.calls.length).toBe(before + 1)
    expect(connectOptions(transport).at(-1)?.command).toContain('sess-hibernated')
  })

  it('does not wake a session another pane is starting right now, and claims its own wake', async () => {
    const { binding, transport, deps } = await hibernatedPane()
    const before = transport.connect.mock.calls.length
    const { claimProviderSessionLaunch, findLiveProviderSessionOwner } =
      await import('@/lib/live-provider-session-owner')
    const release = claimProviderSessionLaunch(paneKeyOf('tab-9'), 'claude', {
      key: 'session_id',
      id: 'sess-hibernated'
    })
    deps.isVisibleRef.current = true
    binding.noteVisibilityResume()
    await flushAsyncTicks(30)
    expect(transport.connect.mock.calls.length).toBe(before)

    release()
    binding.noteVisibilityResume()
    await flushAsyncTicks(30)
    expect(transport.connect.mock.calls.length).toBe(before + 1)
    // Its own wake now claims the session, so a reveal elsewhere sees it starting.
    expect(
      findLiveProviderSessionOwner(mockStoreState as never, {
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'sess-hibernated' },
        excludePaneKey: paneKeyOf('tab-9')
      })
    ).toBe(paneKeyOf('tab-1'))
  })

  it('keeps a hibernated agent whose last message asks a question armed for its reveal', async () => {
    const { binding, transport, deps } = await hibernatedPane({
      lastAssistantMessage: 'Which branch should I use?'
    })
    const before = transport.connect.mock.calls.length

    // The phone opening the workspace is no reveal of this pane: the ask waits in its record.
    expect(binding.wakeHibernatedAgentIfArmed(new Set())).toBeNull()
    await flushAsyncTicks(30)
    expect(transport.connect.mock.calls.length).toBe(before)

    deps.isVisibleRef.current = true
    binding.noteVisibilityResume()
    await flushAsyncTicks(30)
    expect(transport.connect.mock.calls.length).toBe(before + 1)
  })
})
