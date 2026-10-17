import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { stopAgentHibernationCoordinator } from './agent-hibernation-coordinator'
import { resolveAgentSleepPolicy } from './agent-sleep-policy'
import {
  ageBindings,
  entry,
  guardDeps,
  HIBERNATION,
  install,
  layout,
  lines,
  linesFor,
  MIN,
  PANE,
  setUpAgentSleepTest,
  tab,
  tearDownAgentSleepTest,
  ticks
} from './agent-sleep-test-fixture'

const { readKeep, inspectProcess } = guardDeps
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const PANE_2 = `tab-2:${LEAF_2}`

beforeEach(setUpAgentSleepTest)
afterEach(tearDownAgentSleepTest)

/** Two done agents in two background tabs, both past the window. */
function installTwo(settings: object): ReturnType<typeof install> {
  const shutdown = install(settings, {
    tabsByWorktree: { 'wt-bg': [tab('tab-1'), tab('tab-2')] },
    terminalLayoutsByTabId: { 'tab-1': layout('pty-1'), 'tab-2': layout('pty-2', LEAF_2) },
    ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] },
    agentStatusByPaneKey: {
      [PANE]: entry(),
      [PANE_2]: entry({
        paneKey: PANE_2,
        tabId: 'tab-2',
        providerSession: { key: 'session_id', id: 'session-2' }
      })
    }
  })
  ageBindings()
  return shutdown
}

function setSettings(patch: object): void {
  useAppStore.setState({ settings: { ...useAppStore.getState().settings, ...patch } as never })
}

describe('idle auto-close governs hibernation too (the safe default and the kill switch)', () => {
  it('with hibernation on and the default shadow mode, only logs what it would sleep', async () => {
    const shutdown = install({
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: 30 * MIN
    })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(linesFor('hibernation.sleep')).toEqual([
      expect.objectContaining({
        audit: expect.objectContaining({
          mode: 'shadow',
          outcome: 'would',
          evidence: expect.objectContaining({ source: 'hibernation' })
        })
      })
    ])
  })

  it("with hibernation on and 'off', plans, reads and writes nothing", async () => {
    const shutdown = install({ ...HIBERNATION, idleAutoCloseMode: 'off' })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(readKeep).not.toHaveBeenCalled()
    expect(lines).toEqual([])
  })

  it("with hibernation on and 'on', refuses to act until the restore flood guard is on", async () => {
    const shutdown = install({ ...HIBERNATION, restoreFloodGuard: false })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(linesFor('hibernation.sleep')[0]?.audit.evidence).toMatchObject({
      refused: 'restore-flood-guard-off'
    })
  })

  it('waits for the longer of the hibernation and idle auto-close windows', () => {
    const policy = (agentHibernationIdleMs: number, idleAutoCloseMinutes: number) =>
      resolveAgentSleepPolicy({
        experimentalAgentHibernation: true,
        agentHibernationIdleMs,
        idleAutoCloseMode: 'on',
        idleAutoCloseMinutes
      })?.idleMs
    expect(policy(10 * MIN, 30)).toBe(30 * MIN)
    expect(policy(60 * MIN, 30)).toBe(60 * MIN)
    expect(resolveAgentSleepPolicy({ idleAutoCloseMinutes: 45 })?.idleMs).toBe(45 * MIN)
  })
})

describe('switching agent sleep off stops a drain already running (G4)', () => {
  it.each<[string, () => void]>([
    ["idle auto-close set to 'off'", () => setSettings({ idleAutoCloseMode: 'off' })],
    ["idle auto-close set to 'shadow'", () => setSettings({ idleAutoCloseMode: 'shadow' })],
    ['the coordinator stopped', () => stopAgentHibernationCoordinator()]
  ])('%s after the first sleep', async (_label, switchOff) => {
    const shutdown = installTwo(HIBERNATION)
    shutdown.mockImplementation(async () => switchOff())
    // Both are confirmed on the second tick and drained one after the other in it.
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('while the guards are reading the next pane', async () => {
    const shutdown = installTwo(HIBERNATION)
    readKeep.mockImplementation(async (targets) => {
      setSettings({ idleAutoCloseMode: 'off' })
      return targets.map((target) => ({
        paneKey: target.paneKey,
        listed: true,
        state: 'idle',
        openAsk: false,
        keepGoing: false,
        agentForeground: true
      }))
    })
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    expect(linesFor('hibernation.sleep')).toEqual([])
  })
})

describe('shadow reads each would-do once', () => {
  it('does not re-read an unchanged would-sleep pane for as long as it stays the same', async () => {
    const shutdown = install({ idleAutoCloseMode: 'shadow' })
    await ticks(20)
    expect(shutdown).not.toHaveBeenCalled()
    expect(readKeep).toHaveBeenCalledTimes(1)
    expect(inspectProcess).toHaveBeenCalledTimes(1)
    expect(linesFor('hibernation.sleep')).toHaveLength(1)
  })

  it('reads again before acting once the mode turns on', async () => {
    const shutdown = install({ idleAutoCloseMode: 'shadow' })
    await ticks(3)
    setSettings({ idleAutoCloseMode: 'on', restoreFloodGuard: true })
    await ticks(1)
    // The tick's shared reading, then this pane's own reading right before the shutdown (G4).
    expect(readKeep).toHaveBeenCalledTimes(3)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})
