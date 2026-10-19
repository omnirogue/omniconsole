import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { runAgentHibernationTick } from './agent-hibernation-coordinator'
import { isThrashExempt, startAgentSleepWakeTracker } from './agent-sleep-wake-tracker'
import { startPersonAttachTracking } from './idle-auto-close/idle-keep-guards'
import { setDriverForPty } from './pane-manager/mobile-driver-state'
import { registerTerminalPaneVisibility } from './terminal-pane-visibility-registry'
import {
  ageBindings,
  agentGone,
  cleanups,
  entry,
  guardDeps,
  HIBERNATION,
  install,
  layout,
  lines,
  linesFor,
  MIN,
  NOW,
  PANE,
  quiet,
  runtimeCall,
  setUpAgentSleepTest,
  sleptRecord,
  tearDownAgentSleepTest,
  ticks
} from './agent-sleep-test-fixture'

const { readKeep, inspectProcess } = guardDeps

beforeEach(setUpAgentSleepTest)
afterEach(tearDownAgentSleepTest)

describe('agent sleep never thrashes a visible pane (G3, G4)', () => {
  it('never sleeps a pane its own isVisibleRef shows, and counts it', async () => {
    const shutdown = install(HIBERNATION)
    cleanups.push(registerTerminalPaneVisibility('tab-1', { current: true }))
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(linesFor('idle.summary')[0]?.audit.evidence).toMatchObject({ 'kept.visible': 1 })
  })

  it('reads the pane’s live visibility again immediately before the shutdown', async () => {
    const shutdown = install(HIBERNATION)
    const ref = { current: false }
    cleanups.push(registerTerminalPaneVisibility('tab-1', ref))
    readKeep.mockImplementation(async (targets) => {
      ref.current = true // revealed while main answered
      return targets.map(quiet)
    })
    await ticks(3)
    expect(readKeep).toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('sleeps the same pane once it is off screen, and logs the sleep', async () => {
    const shutdown = install(HIBERNATION)
    cleanups.push(registerTerminalPaneVisibility('tab-1', { current: false }))
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(linesFor('hibernation.sleep')).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ paneKey: PANE, tabId: 'tab-1' }),
        audit: expect.objectContaining({
          rule: 'idle.R1.sleep-done-agent',
          mode: 'on',
          outcome: 'done',
          evidence: expect.objectContaining({ source: 'hibernation', foregroundProcess: 'claude' })
        })
      })
    ])
  })
})

describe('thrash breaker', () => {
  /** Slept at `sleptAt`, then woken now onto pty-2. */
  function sleepThenWake(sleptAt: number): void {
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: { [PANE]: sleptRecord(sleptAt) },
      agentStatusByPaneKey: {},
      ptyIdsByTabId: { 'tab-1': [] }
    })
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {},
      terminalLayoutsByTabId: { 'tab-1': layout('pty-2') },
      ptyIdsByTabId: { 'tab-1': ['pty-2'] }
    })
  }

  it('logs every wake and exempts a pane woken within 30 minutes for the session', async () => {
    const shutdown = install(HIBERNATION)
    cleanups.push(startAgentSleepWakeTracker())
    sleepThenWake(NOW - 2_000)
    expect(isThrashExempt(PANE)).toBe(true)
    expect(linesFor('hibernation.wake')[0]).toMatchObject({
      target: { paneKey: PANE, tabId: 'tab-1' },
      audit: { rule: 'hibernation.wake', evidence: expect.objectContaining({ thrashExempt: true }) }
    })
    // Done again and idle long enough: the breaker still keeps it.
    useAppStore.setState({ agentStatusByPaneKey: { [PANE]: entry() } })
    ageBindings()
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not exempt a pane that slept longer than 30 minutes', async () => {
    const shutdown = install(HIBERNATION)
    cleanups.push(startAgentSleepWakeTracker())
    sleepThenWake(NOW - 31 * MIN)
    expect(isThrashExempt(PANE)).toBe(false)
    expect(linesFor('hibernation.wake')[0]?.audit.evidence).toMatchObject({ thrashExempt: false })
    useAppStore.setState({ agentStatusByPaneKey: { [PANE]: entry() } })
    ageBindings()
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('does not count a failed shutdown’s rollback as a wake, nor exempt the pane', async () => {
    // As shutdownCompletedAgentPaneForHibernation does: the record lands before the kill, and a
    // failed kill deletes it again while the pane still holds its live PTY.
    const shutdown = install(HIBERNATION)
    shutdown.mockImplementation(async () => {
      useAppStore.setState({ sleepingAgentSessionsByPaneKey: { [PANE]: sleptRecord(Date.now()) } })
      useAppStore.setState({ sleepingAgentSessionsByPaneKey: {} })
      throw new Error('exact_terminal_stop_mismatch')
    })
    cleanups.push(startAgentSleepWakeTracker())
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(linesFor('hibernation.sleep')[0]?.audit).toMatchObject({ outcome: 'failed' })
    expect(linesFor('hibernation.wake')).toEqual([])
    expect(isThrashExempt(PANE)).toBe(false)
  })

  it('counts a wake that reattaches the same PTY id after it went down', () => {
    install(HIBERNATION)
    cleanups.push(startAgentSleepWakeTracker())
    // Slept on pty-1 (the record lands first, then the kill drops it), woken back onto pty-1.
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: { [PANE]: sleptRecord(NOW - 2_000) } })
    useAppStore.setState({ ptyIdsByTabId: { 'tab-1': [] } })
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {},
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    expect(linesFor('hibernation.wake')).toHaveLength(1)
    expect(isThrashExempt(PANE)).toBe(true)
  })

  it('does not count a record cleared by closing its tab as a wake', () => {
    install(HIBERNATION)
    cleanups.push(startAgentSleepWakeTracker())
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: { [PANE]: sleptRecord(NOW) } })
    useAppStore.setState({ sleepingAgentSessionsByPaneKey: {}, tabsByWorktree: { 'wt-bg': [] } })
    expect(linesFor('hibernation.wake')).toEqual([])
    expect(isThrashExempt(PANE)).toBe(false)
  })
})

describe('an agent that already exited', () => {
  it('drops the stale done entry and writes no resume record', async () => {
    const shutdown = install(HIBERNATION)
    readKeep.mockImplementation(async (targets) => targets.map(agentGone))
    inspectProcess.mockResolvedValue({ foregroundProcess: 'zsh', hasChildProcesses: false })
    await ticks(2)
    expect(shutdown).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentStatusByPaneKey[PANE]).toBeUndefined()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[PANE]).toBeUndefined()
    expect(linesFor('hibernation.drop-stale-done')[0]?.audit).toMatchObject({
      mode: 'on',
      outcome: 'done',
      evidence: expect.objectContaining({ foregroundProcess: 'zsh' })
    })
  })

  it('in shadow only says it would drop the entry', async () => {
    const shutdown = install({ idleAutoCloseMode: 'shadow' })
    readKeep.mockImplementation(async (targets) => targets.map(agentGone))
    inspectProcess.mockResolvedValue({ foregroundProcess: '-zsh', hasChildProcesses: false })
    await ticks(2)
    expect(shutdown).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentStatusByPaneKey[PANE]).toBeDefined()
    expect(linesFor('hibernation.drop-stale-done')[0]?.audit).toMatchObject({ outcome: 'would' })
  })

  it('keeps a pane whose process cannot be read', async () => {
    const shutdown = install(HIBERNATION)
    inspectProcess.mockResolvedValue({
      foregroundProcess: null,
      hasChildProcesses: false,
      unavailable: true
    })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentStatusByPaneKey[PANE]).toBeDefined()
  })
})

describe('R1 under idleAutoCloseMode', () => {
  it('in shadow (the default) writes one would-line and sleeps nothing', async () => {
    const shutdown = install({ idleAutoCloseMode: 'shadow', idleAutoCloseMinutes: 30 })
    await ticks(6)
    expect(shutdown).not.toHaveBeenCalled()
    expect(linesFor('hibernation.sleep')).toEqual([
      expect.objectContaining({
        audit: expect.objectContaining({
          mode: 'shadow',
          outcome: 'would',
          evidence: expect.objectContaining({ source: 'idle-auto-close', idleMs: 30 * MIN })
        })
      })
    ])
  })

  it("refuses to act in 'on' unless the restore flood guard is on", async () => {
    const shutdown = install({ idleAutoCloseMode: 'on' })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(linesFor('hibernation.sleep')[0]?.audit).toMatchObject({
      mode: 'shadow',
      outcome: 'would',
      evidence: expect.objectContaining({ refused: 'restore-flood-guard-off' })
    })
  })

  it("acts in 'on' with the restore flood guard on", async () => {
    const shutdown = install({ idleAutoCloseMode: 'on', restoreFloodGuard: true })
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('keeps a done agent at 29 minutes and sleeps it at 30 (fake clock)', async () => {
    const shutdown = install(
      { idleAutoCloseMode: 'on', restoreFloodGuard: true, idleAutoCloseMinutes: 30 },
      {
        agentStatusByPaneKey: {
          [PANE]: entry({ stateStartedAt: NOW - 29 * MIN, updatedAt: NOW - 29 * MIN })
        }
      }
    )
    await runAgentHibernationTick() // 29:00
    vi.setSystemTime(NOW + 59_999)
    await runAgentHibernationTick() // 29:59
    expect(shutdown).not.toHaveBeenCalled()
    vi.setSystemTime(NOW + MIN)
    await runAgentHibernationTick() // 30:00, first eligible sight
    vi.setSystemTime(NOW + 2 * MIN)
    await runAgentHibernationTick() // confirmed
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('never lists a runtime environment, nor sleeps a pane that runs on one', async () => {
    const shutdown = install(
      { idleAutoCloseMode: 'on', restoreFloodGuard: true, activeRuntimeEnvironmentId: 'runtime-1' },
      {
        worktreesByRepo: {
          'fixture-repo': [
            {
              id: 'wt-bg',
              repoId: 'fixture-repo',
              hostId: 'local',
              runtimeOwnerEnvironmentId: 'runtime-1'
            }
          ]
        } as never
      }
    )
    await ticks(3)
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
  })

  it("in 'off' with hibernation off plans nothing and writes nothing", async () => {
    const shutdown = install({ idleAutoCloseMode: 'off' })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(readKeep).not.toHaveBeenCalled()
    expect(lines).toEqual([])
  })
})

describe('an open ask keeps the agent (G1)', () => {
  it.each(['awaiting-user', 'waiting-for-yes', 'working'])('keeps on Stage A1 %s', async (state) => {
    const shutdown = install(HIBERNATION)
    readKeep.mockImplementation(async (targets) =>
      targets.map((target) => ({ ...quiet(target), state }))
    )
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it.each([
    ['a numbered question list', 'Before I go on:\n1. Phase 0?\n2. Thirty minutes?\n3. Archive?'],
    ['a closing question', 'Merged the fix. Shall I deploy it?']
  ])('keeps a last reply holding %s, without asking main', async (_label, reply) => {
    const shutdown = install(HIBERNATION, {
      agentStatusByPaneKey: { [PANE]: entry({ lastAssistantMessage: reply }) }
    })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(readKeep).not.toHaveBeenCalled()
  })

  it('keeps it when main cannot read it or does not list it', async () => {
    const shutdown = install(HIBERNATION)
    readKeep.mockResolvedValue([])
    await ticks(3)
    readKeep.mockImplementation(async (targets) =>
      targets.map((target) => ({ ...quiet(target), listed: false }))
    )
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })
})

describe('a person’s touch keeps the agent (G2)', () => {
  it('keeps a pane a person attached to in the last 10 minutes', async () => {
    const shutdown = install(HIBERNATION)
    cleanups.push(startPersonAttachTracking(() => Date.now()))
    setDriverForPty('pty-1', { kind: 'desktop' })
    setDriverForPty('pty-1', { kind: 'idle' })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    vi.setSystemTime(NOW + 11 * MIN)
    await runAgentHibernationTick()
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('keeps a pane typed into in the last 10 minutes', async () => {
    const shutdown = install(HIBERNATION)
    useAppStore.getState().recordTerminalInput(PANE, NOW - 5 * MIN)
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })
})

describe('interrupted restore stays ungated (G5)', () => {
  it('never touches a pane holding a quit record of a mid-task agent', async () => {
    const quitRecord: SleepingAgentSessionRecord = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-bg',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'session-1' },
      prompt: 'mid-task',
      state: 'working',
      capturedAt: NOW - 50 * MIN,
      updatedAt: NOW - 50 * MIN,
      origin: 'quit'
    }
    const shutdown = install(HIBERNATION, {
      sleepingAgentSessionsByPaneKey: { [PANE]: quitRecord }
    })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[PANE]).toBe(quitRecord)
  })
})

describe('automatic cleanup protection at the act boundary', () => {
  it('keeps a protected session before any process read', async () => {
    const shutdown = install(HIBERNATION)
    guardDeps.readProtection.mockReturnValue('protected-workspace')
    await ticks(3)
    expect(readKeep).not.toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('keeps a session newly protected while the host reading was awaited', async () => {
    const shutdown = install(HIBERNATION)
    readKeep.mockImplementation(async (targets) => {
      guardDeps.readProtection.mockReturnValue('routine')
      return targets.map(quiet)
    })
    await ticks(3)
    expect(readKeep).toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
  })
})
