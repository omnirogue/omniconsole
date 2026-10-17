/**
 * One done Claude agent in a background tab, idle 40 minutes, for the agent sleep (R1) tests: the
 * store, main's G1 reading, the process inspection and the audit sink, all reset between tests.
 */

import { vi, type Mock } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { IdleKeepReading } from '../../../shared/idle-auto-close-settings'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  resetAgentHibernationCoordinatorForTests,
  runAgentHibernationTick
} from './agent-hibernation-coordinator'
import {
  observeHibernationPtyBindings,
  resetHibernationPaneAgeForTests,
  type DaemonSessionIdentity
} from './agent-hibernation-pane-age'
import { setAgentSleepGuardDepsForTests, type AgentSleepGuardDeps } from './agent-sleep-guards'
import { setDaemonSessionReaderForTests } from './agent-hibernation-plan-now'
import { resetAgentSleepWakeTrackerForTests } from './agent-sleep-wake-tracker'
import { resetLegacySleepRecordNormalizationForTests } from './agent-sleep-legacy-records'
import { resetAgentPaneHistoryForTests } from './idle-auto-close/agent-pane-history'
import { resetForegroundTerminalTabIdsForTests } from './foreground-terminal-tabs'
import {
  setHibernationLineSinkForTests,
  type HibernationLine
} from './idle-auto-close/idle-auto-close-audit'
import { resetIdleKeepGuardsForTests } from './idle-auto-close/idle-keep-guards'
import { hydrateDrivers } from './pane-manager/mobile-driver-state'

export const runtimeCall: Mock = vi.fn()
vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

export const MIN = 60_000
export const NOW = 1_800_000_000_000
export const LEAF = '11111111-1111-4111-8111-111111111111'
export const PANE = `tab-1:${LEAF}`
/** Hibernation acting: idle auto-close On with the restore flood guard (it governs hibernation). */
export const HIBERNATION = {
  experimentalAgentHibernation: true,
  agentHibernationIdleMs: 30 * MIN,
  idleAutoCloseMode: 'on',
  restoreFloodGuard: true
}

export const lines: HibernationLine[] = []
export const cleanups: (() => void)[] = []
export const guardDeps = {
  readProtection: vi.fn<AgentSleepGuardDeps['readProtection']>(() => null),
  readKeep: vi.fn<AgentSleepGuardDeps['readKeep']>(),
  inspectProcess: vi.fn<AgentSleepGuardDeps['inspectProcess']>()
}

export function tab(id = 'tab-1'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-bg',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

export function layout(ptyId = 'pty-1', leafId = LEAF): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

export function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'ship it',
    updatedAt: NOW - 40 * MIN,
    stateStartedAt: NOW - 40 * MIN,
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: [],
    ...overrides
  }
}

/** main's reading of an idle agent that provably holds its terminal and asks nothing. */
export function quiet(target: { paneKey: string }): IdleKeepReading {
  return {
    paneKey: target.paneKey,
    listed: true,
    state: 'idle',
    openAsk: false,
    keepGoing: false,
    agentForeground: true
  }
}

/** main's reading of a pane whose agent exited: the pid proof is gone. */
export function agentGone(target: { paneKey: string }): IdleKeepReading {
  return { ...quiet(target), state: 'exited', agentForeground: false }
}

/** The record hibernation writes for the fixture pane. */
export function sleptRecord(capturedAt: number): SleepingAgentSessionRecord {
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: '',
    state: 'done',
    capturedAt,
    updatedAt: capturedAt,
    origin: 'worktree-sleep',
    restoreOnTabOpenOnly: true,
    resumeOnFirstReveal: true
  }
}

/** Ages the panes' PTY bindings past the window, as earlier ticks would have. */
export function ageBindings(at = NOW - 40 * MIN): void {
  const state = useAppStore.getState()
  observeHibernationPtyBindings({
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    now: at,
    idleMs: 30 * MIN
  })
}

export function install(
  settings: object,
  overrides: Partial<AppState> = {}
): ReturnType<typeof vi.fn> {
  const shutdown = vi.fn().mockResolvedValue(undefined)
  const e = entry()
  useAppStore.setState({
    settings: settings as never,
    activeWorktreeId: 'wt-active',
    repos: [],
    worktreesByRepo: {
      'fixture-repo': [{ id: 'wt-bg', repoId: 'fixture-repo', hostId: 'local' }]
    } as never,
    detectedWorktreesByRepo: {},
    tabsByWorktree: { 'wt-bg': [tab()] },
    terminalLayoutsByTabId: { 'tab-1': layout() },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    agentStatusByPaneKey: { [e.paneKey]: e },
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    shutdownCompletedAgentPaneForHibernation: shutdown as never,
    ...overrides
  })
  ageBindings()
  return shutdown
}

/**
 * The local daemon's listing: every PTY the store holds, each in the lifetime `incarnation` names
 * (the same one across an app restart, as a surviving daemon PTY keeps it).
 */
async function liveDaemonSessions(): Promise<DaemonSessionIdentity[]> {
  return Object.values(useAppStore.getState().ptyIdsByTabId)
    .flat()
    .map((ptyId) => ({ sessionId: ptyId, incarnationId: `lifetime-${ptyId}`, pid: 4242 }))
}
export const daemonSessions = vi.fn<() => Promise<readonly DaemonSessionIdentity[] | null>>()

export async function ticks(count = 2, stepMs = MIN): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await runAgentHibernationTick()
    vi.setSystemTime(Date.now() + stepMs)
  }
}

export function linesFor(action: string): HibernationLine[] {
  return lines.filter((line) => line.action === action)
}

export function setUpAgentSleepTest(): void {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  lines.length = 0
  guardDeps.readProtection.mockReset()
  guardDeps.readProtection.mockReturnValue(null)
  guardDeps.readKeep.mockReset()
  guardDeps.readKeep.mockImplementation(async (targets) => targets.map(quiet))
  guardDeps.inspectProcess.mockReset()
  guardDeps.inspectProcess.mockImplementation(async () => ({
    foregroundProcess: 'claude',
    hasChildProcesses: true
  }))
  setAgentSleepGuardDepsForTests(guardDeps)
  daemonSessions.mockReset()
  daemonSessions.mockImplementation(liveDaemonSessions)
  setDaemonSessionReaderForTests(daemonSessions)
  setHibernationLineSinkForTests(async (batch) => {
    lines.push(...batch)
  })
}

export function tearDownAgentSleepTest(): void {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
  resetAgentHibernationCoordinatorForTests()
  resetAgentSleepWakeTrackerForTests()
  resetIdleKeepGuardsForTests()
  resetForegroundTerminalTabIdsForTests()
  resetHibernationPaneAgeForTests()
  resetLegacySleepRecordNormalizationForTests()
  resetAgentPaneHistoryForTests()
  setAgentSleepGuardDepsForTests(null)
  setDaemonSessionReaderForTests(null)
  setHibernationLineSinkForTests(null)
  hydrateDrivers([])
  runtimeCall.mockReset()
  vi.useRealTimers()
}
