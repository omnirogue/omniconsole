import { readAutomaticCleanupProtection } from '../automatic-session-cleanup-protection'
vi.mock('../automatic-session-cleanup-protection', () => ({
  readAutomaticCleanupProtection: vi.fn(() => null),
  automaticCleanupProtectionForRow: () => null
}))
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-terminal-contracts'
import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import { IDLE_RULE, type IdleKeepReading } from '../../../../shared/idle-auto-close-settings'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  resetIdleAutoCloseCoordinatorForTests,
  runIdleAutoCloseTick,
  startIdleAutoCloseCoordinator,
  type IdleAutoCloseDeps
} from './idle-auto-close-coordinator'
import { setHibernationLineSinkForTests, type HibernationLine } from './idle-auto-close-audit'
import { resetForegroundTerminalTabIdsForTests } from '../foreground-terminal-tabs'
import { registerTerminalPaneVisibility } from '../terminal-pane-visibility-registry'
import { hydrateDrivers, setDriverForPty } from '../pane-manager/mobile-driver-state'
import { resetIdleKeepGuardsForTests } from './idle-keep-guards'
import { resetAgentPaneHistoryForTests } from './agent-pane-history'
import { createDefaultIdleAutoCloseDeps } from './idle-auto-close-deps'

const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn(), info: vi.fn() } }))

const MIN = 60_000
const T0 = 1_000_000_000
let clock = T0
const cleanups: (() => void)[] = []

function leafId(index: number): string {
  return `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
}

function paneKey(index: number): string {
  return `tab-${index}:${leafId(index)}`
}

function shellTab(index: number): TerminalTab {
  return {
    id: `tab-${index}`,
    ptyId: `pty-${index}`,
    worktreeId: 'wt-bg',
    title: 'zsh',
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: 1
  }
}

function shellLayout(index: number): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: leafId(index) },
    activeLeafId: leafId(index),
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId(index)]: `pty-${index}` }
  }
}

function session(id: string): PtyListedSession {
  return { id, cwd: '/tmp', title: 'zsh', agentOwnership: 'absent' }
}

function terminal(ptyId: string, lastOutputAt: number | null = T0): RuntimeTerminalSummary {
  return {
    handle: `h-${ptyId}`,
    ptyId,
    worktreeId: 'wt-bg',
    worktreePath: '/tmp',
    branch: 'main',
    tabId: `tab-${ptyId.slice('pty-'.length)}`,
    leafId: 'leaf',
    title: 'zsh',
    connected: true,
    writable: true,
    lastOutputAt,
    preview: ''
  }
}

function browserTab(id: string, worktreeId: string): BrowserWorkspace {
  return {
    id,
    worktreeId,
    label: id,
    sessionProfileId: null,
    pageIds: [],
    activePageId: null,
    url: 'https://example.com/docs',
    title: 'Docs',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function quietReading(target: { paneKey: string }): IdleKeepReading {
  return {
    paneKey: target.paneKey,
    listed: false,
    state: null,
    openAsk: false,
    keepGoing: false,
    agentForeground: null
  }
}

type MockedDeps = { [K in keyof IdleAutoCloseDeps]: Mock<IdleAutoCloseDeps[K]> }

type Fixture = {
  deps: MockedDeps
  records: HibernationLine[]
  outputAt: Map<string, number | null>
  liveGuests: Set<string>
}

function installStore(shells: number, overrides: Partial<AppState> = {}): void {
  const indexes = Array.from({ length: shells }, (_, index) => index + 1)
  useAppStore.setState({
    settings: { idleAutoCloseMode: 'shadow', idleAutoCloseMinutes: 30 } as never,
    workspaceSessionReady: true,
    activeWorktreeId: 'wt-active',
    repos: [{ id: 'repo-1', path: '/tmp/repo', displayName: 'repo', connectionId: null }] as never,
    worktreesByRepo: {
      'repo-1': [
        { id: 'wt-bg', repoId: 'repo-1', hostId: 'local' },
        { id: 'wt-active', repoId: 'repo-1', hostId: 'local' }
      ]
    } as never,
    tabsByWorktree: { 'wt-bg': indexes.map(shellTab) },
    terminalLayoutsByTabId: Object.fromEntries(
      indexes.map((index) => [`tab-${index}`, shellLayout(index)])
    ),
    ptyIdsByTabId: Object.fromEntries(indexes.map((index) => [`tab-${index}`, [`pty-${index}`]])),
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    retainedAgentsByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    pendingStartupByTabId: {},
    lastTerminalInputAtByPaneKey: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    ...overrides
  })
}

function setMode(mode: 'shadow' | 'on' | 'off', restoreFloodGuard?: boolean): void {
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings,
      idleAutoCloseMode: mode,
      ...(restoreFloodGuard === undefined ? {} : { restoreFloodGuard })
    } as never
  })
}

function start(options: { realNotice?: boolean } = {}): Fixture {
  const outputAt = new Map<string, number | null>()
  const liveGuests = new Set<string>()
  const records: HibernationLine[] = []
  setHibernationLineSinkForTests(async (batch) => {
    records.push(...batch)
  })
  const shellPtyIds = (): string[] =>
    Object.values(useAppStore.getState().tabsByWorktree)
      .flat()
      .map((tab) => tab.ptyId!)
  const deps: MockedDeps = {
    listSessions: vi.fn<IdleAutoCloseDeps['listSessions']>(async () => shellPtyIds().map(session)),
    listLocalTerminals: vi.fn<IdleAutoCloseDeps['listLocalTerminals']>(async () =>
      shellPtyIds().map((ptyId) =>
        terminal(ptyId, outputAt.has(ptyId) ? (outputAt.get(ptyId) ?? null) : T0)
      )
    ),
    inspectProcess: vi.fn<IdleAutoCloseDeps['inspectProcess']>(async () => ({
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    })),
    sleepShellWorkspace: vi.fn<IdleAutoCloseDeps['sleepShellWorkspace']>(async () => {}),
    holdsLiveGuests: vi.fn<IdleAutoCloseDeps['holdsLiveGuests']>((_state, worktreeId) =>
      liveGuests.has(worktreeId)
    ),
    isGuestEvictable: vi.fn<IdleAutoCloseDeps['isGuestEvictable']>(() => true),
    isGuestPlayingAudio: vi.fn<IdleAutoCloseDeps['isGuestPlayingAudio']>(() => false),
    discardWorktreeGuests: vi.fn<IdleAutoCloseDeps['discardWorktreeGuests']>(
      (_state, worktreeId) => {
        liveGuests.delete(worktreeId)
      }
    ),
    readKeptSessions: vi.fn<IdleAutoCloseDeps['readKeptSessions']>(async () => ({
      paneKeys: new Set<string>(),
      tabIds: new Set<string>()
    })),
    readKeep: vi.fn<IdleAutoCloseDeps['readKeep']>(async (targets) => targets.map(quietReading)),
    notifySleptShellWorkspaces: vi.fn<IdleAutoCloseDeps['notifySleptShellWorkspaces']>()
  }
  const injected: Partial<IdleAutoCloseDeps> = { ...deps }
  if (options.realNotice) {
    delete injected.notifySleptShellWorkspaces
  }
  startIdleAutoCloseCoordinator({ now: () => clock, deps: injected })
  return { deps, records, outputAt, liveGuests }
}

/** One tick per minute through `toMinute` (inclusive), like the real interval. */
async function runUntil(toMinute: number): Promise<void> {
  let minute = Math.floor((clock - T0) / MIN) + 1
  for (; minute <= toMinute; minute += 1) {
    clock = T0 + minute * MIN
    await runIdleAutoCloseTick()
  }
}

function ruleLines(records: HibernationLine[], rule: string): HibernationLine[] {
  return records.filter((record) => record.audit.rule === rule)
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = T0
  toastSuccess.mockReset()
  vi.mocked(readAutomaticCleanupProtection).mockReset()
  vi.mocked(readAutomaticCleanupProtection).mockReturnValue(null)
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  resetIdleAutoCloseCoordinatorForTests()
  setHibernationLineSinkForTests(null)
  resetForegroundTerminalTabIdsForTests()
  resetIdleKeepGuardsForTests()
  resetAgentPaneHistoryForTests()
  hydrateDrivers([])
  vi.useRealTimers()
})

describe('idle rules coordinator (R2, R3)', () => {
  it('in shadow writes exactly one would-line per idle shell workspace and stops nothing', async () => {
    installStore(2)
    const { deps, records } = start()
    await runUntil(45)
    const r2 = ruleLines(records, IDLE_RULE.R2)
    expect(r2).toHaveLength(1)
    expect(r2[0]).toMatchObject({
      action: 'idle.sleep-shells',
      audit: { mode: 'shadow', outcome: 'would' }
    })
    expect(r2[0]!.audit.evidence).toMatchObject({
      worktreeId: 'wt-bg',
      tabIds: 'tab-1,tab-2',
      foregroundProcess: 'zsh',
      keepsHistory: true
    })
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    expect(deps.discardWorktreeGuests).not.toHaveBeenCalled()
  })

  it("refuses to act in 'on' while the restore flood guard is off, and says so", async () => {
    installStore(1)
    setMode('on')
    const { deps, records } = start()
    await runUntil(45)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    expect(ruleLines(records, IDLE_RULE.R2)).toEqual([
      expect.objectContaining({
        audit: expect.objectContaining({
          mode: 'shadow',
          outcome: 'would',
          evidence: expect.objectContaining({ refused: 'restore-flood-guard-off' })
        })
      })
    ])
  })

  it("in 'on' with the guard acts once after two agreeing ticks and records done", async () => {
    installStore(1)
    setMode('on', true)
    const { deps, records } = start()
    // First observed at minute 1, so idle reaches 30 at minute 31 and is confirmed at 32.
    await runUntil(31)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    await runUntil(32)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledTimes(1)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledWith('wt-bg')
    await runUntil(50)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledTimes(1)
    expect(ruleLines(records, IDLE_RULE.R2)).toEqual([
      expect.objectContaining({ audit: expect.objectContaining({ mode: 'on', outcome: 'done' }) })
    ])
  })

  it('stops the shells keeping their history and closes no tab (G6)', async () => {
    installStore(2)
    setMode('on', true)
    const { deps, records } = start()
    await runUntil(32)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabsByWorktree['wt-bg']?.map((tab) => tab.id)).toEqual([
      'tab-1',
      'tab-2'
    ])
    expect(ruleLines(records, IDLE_RULE.R2)[0]?.audit).toMatchObject({
      outcome: 'done',
      evidence: expect.objectContaining({ keptHistory: true, tabs: 2 })
    })
  })

  it('sleeps through the store’s Sleep, terminals only, keeping history and every record', async () => {
    const shutdownWorktreeTerminals = vi.fn(async () => {})
    useAppStore.setState({ shutdownWorktreeTerminals } as never)
    await createDefaultIdleAutoCloseDeps().sleepShellWorkspace('wt-bg')
    expect(shutdownWorktreeTerminals).toHaveBeenCalledWith('wt-bg', {
      keepIdentifiers: true,
      sleepingPaneKeys: []
    })
  })

  it('records a stop that failed and does not repeat it for the same facts', async () => {
    installStore(1)
    setMode('on', true)
    const { deps, records } = start()
    deps.sleepShellWorkspace.mockRejectedValue(new Error('exact_terminal_stop_unverified'))
    await runUntil(45)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledTimes(1)
    expect(ruleLines(records, IDLE_RULE.R2)[0]?.audit).toMatchObject({
      outcome: 'failed',
      evidence: expect.objectContaining({ error: 'exact_terminal_stop_unverified' })
    })
  })

  it('never puts the workspace on screen to sleep', async () => {
    installStore(1, { activeWorktreeId: 'wt-bg' })
    setMode('on', true)
    const { deps, records } = start()
    await runUntil(45)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    expect(ruleLines(records, IDLE_RULE.R2)).toEqual([])
  })

  it('keeps a workspace with one busy tab: only whole idle workspaces sleep', async () => {
    installStore(2)
    setMode('on', true)
    const { deps } = start()
    deps.inspectProcess.mockImplementation(async (ptyId) =>
      ptyId === 'pty-2'
        ? { foregroundProcess: 'node', hasChildProcesses: true }
        : { foregroundProcess: 'zsh', hasChildProcesses: false }
    )
    await runUntil(45)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a workspace that still holds agent state (a finished agent card)', async () => {
    installStore(1, {
      retainedAgentsByPaneKey: { 'tab-old:leaf': { worktreeId: 'wt-bg' } as never }
    })
    setMode('on', true)
    const { deps } = start()
    await runUntil(45)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a workspace whose tab gained a PTY the plan never inspected (G4)', async () => {
    installStore(1)
    setMode('on', true)
    const fixture = start()
    fixture.deps.readKeep.mockImplementation(async (targets) => {
      useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-new'] } })
      return targets.map(quietReading)
    })
    await runUntil(40)
    expect(fixture.deps.readKeep).toHaveBeenCalled()
    expect(fixture.deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it.each([
    ['held when the rules started', true],
    ['appeared while they ran', false]
  ])(
    'never sleeps a shell whose agent exited earlier this session (%s)',
    async (_label, atStart) => {
      const doneEntry = { [paneKey(1)]: { state: 'done', paneKey: paneKey(1) } as never }
      installStore(1, atStart ? { agentStatusByPaneKey: doneEntry } : {})
      setMode('on', true)
      const { deps } = start()
      await runUntil(1)
      useAppStore.setState({ agentStatusByPaneKey: doneEntry })
      await runUntil(2)
      // As R1 does once the agent is gone: the done entry is dropped, no resume record is left.
      useAppStore.setState({ agentStatusByPaneKey: {} })
      await runUntil(70)
      expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    }
  )

  it('re-reads visibility after main answers; keeps a shell that came on screen (G4)', async () => {
    installStore(1)
    setMode('on', true)
    const fixture = start()
    const ref = { current: false }
    cleanups.push(registerTerminalPaneVisibility('tab-1', ref))
    fixture.deps.readKeep.mockImplementation(async (targets) => {
      ref.current = true
      return targets.map(quietReading)
    })
    await runUntil(40)
    expect(fixture.deps.readKeep).toHaveBeenCalled()
    expect(fixture.deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a shell whose pane main reads as asking (G1)', async () => {
    installStore(1)
    setMode('on', true)
    const fixture = start()
    fixture.deps.readKeep.mockImplementation(async (targets) =>
      targets.map((target) => ({
        ...quietReading(target),
        listed: true,
        state: 'waiting-for-yes'
      }))
    )
    await runUntil(40)
    expect(fixture.deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it('keeps every shell when main cannot be read (unknown means keep)', async () => {
    installStore(1)
    setMode('on', true)
    const fixture = start()
    fixture.deps.readKeep.mockResolvedValue([])
    await runUntil(40)
    expect(fixture.deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a shell a person is driving from the phone (G2)', async () => {
    installStore(1)
    setMode('on', true)
    const fixture = start()
    setDriverForPty('pty-1', { kind: 'mobile', clientId: 'phone' })
    await runUntil(40)
    expect(fixture.deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a shell that started a command since it was planned', async () => {
    installStore(1)
    setMode('on', true)
    const fixture = start()
    await runUntil(31)
    fixture.deps.inspectProcess.mockResolvedValue({
      foregroundProcess: 'npm',
      hasChildProcesses: true
    })
    await runUntil(40)
    expect(fixture.deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a pane holding a mid-task restore record (G5)', async () => {
    installStore(1, {
      sleepingAgentSessionsByPaneKey: {
        [paneKey(1)]: { paneKey: paneKey(1), origin: 'quit', state: 'working' } as never
      }
    })
    setMode('on', true)
    const { deps } = start()
    await runUntil(45)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it("in 'off' reads nothing and writes nothing", async () => {
    installStore(1)
    setMode('off')
    const { deps, records } = start()
    await runUntil(45)
    expect(deps.listSessions).not.toHaveBeenCalled()
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    expect(records).toEqual([])
  })

  it('restarts the window on new output', async () => {
    installStore(1)
    setMode('on', true)
    const { deps, outputAt } = start()
    await runUntil(20)
    outputAt.set('pty-1', clock)
    await runUntil(49)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    await runUntil(51)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledTimes(1)
  })

  it('acts on nothing after a sleep-sized gap and restarts every clock', async () => {
    installStore(1)
    setMode('on', true)
    const { deps } = start()
    await runUntil(2)
    clock = T0 + 60 * MIN
    await runIdleAutoCloseTick()
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    await runUntil(89)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    await runUntil(91)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledTimes(1)
  })

  it('tells the person once per tick; opening the workspace is the way back', async () => {
    installStore(2)
    setMode('on', true)
    start({ realNotice: true })
    await runUntil(32)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    const [title, options] = toastSuccess.mock.calls[0]! as [
      string,
      { description: string; action?: unknown }
    ]
    expect(title).toBe('Put 1 idle shell workspace to sleep')
    expect(options.description).toContain('Opening a workspace restarts its shells')
    expect(options.action).toBeUndefined()
  })

  it('discards pages hidden for the window, keeps URL and title, and restarts on reveal', async () => {
    installStore(0, {
      activeWorktreeId: 'wt-active',
      browserTabsByWorktree: { 'wt-b': [browserTab('browser-1', 'wt-b')] }
    })
    setMode('on', true)
    const fixture = start()
    fixture.liveGuests.add('wt-b')
    await runUntil(30)
    expect(fixture.deps.discardWorktreeGuests).not.toHaveBeenCalled()
    await runUntil(32)
    expect(fixture.deps.discardWorktreeGuests).toHaveBeenCalledTimes(1)
    expect(fixture.liveGuests.has('wt-b')).toBe(false)
    // The rebuild source a revisit reads is untouched.
    expect(useAppStore.getState().browserTabsByWorktree['wt-b']?.[0]).toMatchObject({
      url: 'https://example.com/docs',
      title: 'Docs'
    })
    // Revealing rebuilds the page; leaving again starts a fresh window.
    useAppStore.setState({ activeWorktreeId: 'wt-b' })
    fixture.liveGuests.add('wt-b')
    await runUntil(40)
    useAppStore.setState({ activeWorktreeId: 'wt-active' })
    await runUntil(70)
    expect(fixture.deps.discardWorktreeGuests).toHaveBeenCalledTimes(1)
    await runUntil(72)
    expect(fixture.deps.discardWorktreeGuests).toHaveBeenCalledTimes(2)
    expect(ruleLines(fixture.records, IDLE_RULE.R3)).toHaveLength(2)
    expect(ruleLines(fixture.records, IDLE_RULE.R3)[0]).toMatchObject({
      action: 'idle.discard-page',
      audit: { mode: 'on', outcome: 'done' }
    })
  })

  it('keeps a hidden page that starts playing sound before the discard (G4)', async () => {
    installStore(0, { browserTabsByWorktree: { 'wt-b': [browserTab('browser-1', 'wt-b')] } })
    setMode('on', true)
    const fixture = start()
    fixture.liveGuests.add('wt-b')
    await runUntil(29)
    // Planned at 30 and 31 while silent; the call starts between the 31 plan and its re-check.
    let reads = 0
    fixture.deps.isGuestPlayingAudio.mockImplementation(() => {
      reads += 1
      return reads >= 3
    })
    await runUntil(40)
    expect(reads).toBeGreaterThanOrEqual(3)
    expect(fixture.deps.discardWorktreeGuests).not.toHaveBeenCalled()
    expect(ruleLines(fixture.records, IDLE_RULE.R3)).toEqual([])
  })

  it('stops a tick whose mode is switched off while it re-checks (kill switch)', async () => {
    installStore(2)
    setMode('on', true)
    const fixture = start()
    await runUntil(31)
    fixture.deps.readKeep.mockImplementation(async (targets) => {
      setMode('off')
      return targets.map(quietReading)
    })
    await runUntil(32)
    expect(fixture.deps.readKeep).toHaveBeenCalledTimes(1)
    expect(fixture.deps.sleepShellWorkspace).not.toHaveBeenCalled()
    expect(ruleLines(fixture.records, IDLE_RULE.R2)).toEqual([])
  })

  it('sleeps a workspace it already logged in shadow once the mode turns on', async () => {
    installStore(1)
    const { deps, records } = start()
    await runUntil(45)
    expect(ruleLines(records, IDLE_RULE.R2)).toHaveLength(1)
    setMode('on', true)
    await runUntil(46)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledTimes(1)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledWith('wt-bg')
    expect(ruleLines(records, IDLE_RULE.R2).map((line) => line.audit.outcome)).toEqual([
      'would',
      'done'
    ])
  })

  it('acts once the restore flood guard comes on under an already-on mode', async () => {
    installStore(1)
    setMode('on')
    const { deps } = start()
    await runUntil(45)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
    setMode('on', true)
    await runUntil(46)
    expect(deps.sleepShellWorkspace).toHaveBeenCalledTimes(1)
  })

  it('discards a page it already logged in shadow once the mode turns on', async () => {
    installStore(0, { browserTabsByWorktree: { 'wt-b': [browserTab('browser-1', 'wt-b')] } })
    const fixture = start()
    fixture.liveGuests.add('wt-b')
    await runUntil(40)
    expect(fixture.deps.discardWorktreeGuests).not.toHaveBeenCalled()
    setMode('on', true)
    await runUntil(41)
    expect(fixture.deps.discardWorktreeGuests).toHaveBeenCalledTimes(1)
    expect(ruleLines(fixture.records, IDLE_RULE.R3).map((line) => line.audit.outcome)).toEqual([
      'would',
      'done'
    ])
  })

  it('re-checks a workspace kept for an unreadable reading once the retry window passes', async () => {
    installStore(1)
    setMode('on', true)
    const fixture = start()
    fixture.deps.readKeep.mockResolvedValueOnce([])
    // Planned at 31, confirmed at 32: main cannot be read, so it stays.
    await runUntil(36)
    expect(fixture.deps.readKeep).toHaveBeenCalledTimes(1)
    expect(fixture.deps.sleepShellWorkspace).not.toHaveBeenCalled()
    // Same facts five minutes later: read again, and now it may sleep.
    await runUntil(37)
    expect(fixture.deps.readKeep).toHaveBeenCalledTimes(2)
    expect(fixture.deps.sleepShellWorkspace).toHaveBeenCalledTimes(1)
  })

  it('in shadow logs a would-discard and keeps the page', async () => {
    installStore(0, { browserTabsByWorktree: { 'wt-b': [browserTab('browser-1', 'wt-b')] } })
    const fixture = start()
    fixture.liveGuests.add('wt-b')
    await runUntil(40)
    expect(fixture.deps.discardWorktreeGuests).not.toHaveBeenCalled()
    expect(ruleLines(fixture.records, IDLE_RULE.R3)).toEqual([
      expect.objectContaining({ audit: expect.objectContaining({ outcome: 'would' }) })
    ])
  })
})

describe('shell workspace protection at the stop boundary', () => {
  it('keeps a protected workspace even if the earlier plan found no saved rows', async () => {
    installStore(1)
    setMode('on', true)
    const { deps } = start()
    vi.mocked(readAutomaticCleanupProtection).mockReturnValue('protected-workspace')
    await runUntil(45)
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a shell newly protected during the asynchronous host reading', async () => {
    installStore(1)
    setMode('on', true)
    const { deps } = start()
    deps.readKeep.mockImplementation(async (targets) => {
      vi.mocked(readAutomaticCleanupProtection).mockReturnValue('started-today')
      return targets.map(quietReading)
    })
    await runUntil(45)
    expect(deps.readKeep).toHaveBeenCalled()
    expect(deps.sleepShellWorkspace).not.toHaveBeenCalled()
  })
})
