import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { startAgentHibernationCoordinator } from './agent-hibernation-coordinator'
import { settleLegacySleepRecordPassForTests } from './agent-sleep-legacy-records'
import { recordAwaitsFirstRevealInOwnTab } from './sleeping-agent-pane-ownership'
import { registerTerminalPaneVisibility } from './terminal-pane-visibility-registry'
import {
  cleanups,
  guardDeps,
  install,
  layout,
  linesFor,
  NOW,
  PANE,
  quiet,
  setUpAgentSleepTest,
  tab,
  tearDownAgentSleepTest
} from './agent-sleep-test-fixture'

beforeEach(setUpAgentSleepTest)
afterEach(tearDownAgentSleepTest)

const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const PANE_2 = `tab-2:${LEAF_2}`
/** Idle auto-close acting: On with the restore flood guard. */
const ON = { idleAutoCloseMode: 'on', restoreFloodGuard: true }
const SAL_QUESTIONS = [
  'Before I go on, three questions:',
  '1. Phase 0 first?',
  '2. Thirty minutes?',
  '3. Should Archive pause idle agents?'
].join('\n')

/** What the old hibernation wrote: passive, but neither tab-open-only nor first-reveal. */
function legacyRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: '',
    state: 'done',
    capturedAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    origin: 'worktree-sleep',
    ...overrides
  }
}

/** The slept tab after a restart: its pane has no PTY yet. */
function installSlept(
  records: Record<string, SleepingAgentSessionRecord>,
  settings: object | null = ON
): void {
  install(settings ?? {}, {
    workspaceSessionReady: false,
    tabsByWorktree: { 'wt-bg': [tab('tab-1'), tab('tab-2')] },
    terminalLayoutsByTabId: { 'tab-1': layout('pty-1'), 'tab-2': layout('pty-2', LEAF_2) },
    ptyIdsByTabId: { 'tab-1': [], 'tab-2': [] },
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: records
  })
  if (settings === null) {
    useAppStore.setState({ settings: null })
  }
}

async function startWhenReady(): Promise<void> {
  useAppStore.setState({ workspaceSessionReady: true })
  startAgentHibernationCoordinator({ intervalMs: 60_000 })
  await settleLegacySleepRecordPassForTests()
}

function recordNow(paneKey = PANE): SleepingAgentSessionRecord | undefined {
  return useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]
}

function normalizeLines(outcome: string): unknown[] {
  return linesFor('hibernation.normalize-record').filter((line) => line.audit.outcome === outcome)
}

describe('records the old hibernation wrote resume only when their tab opens', () => {
  it("in 'on' with the flood guard gives a legacy record the open-on-click shape and logs it", async () => {
    installSlept({ [PANE]: legacyRecord() })
    await startWhenReady()
    const record = recordNow()!
    expect(record).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      tabId: 'tab-1',
      restoreOnTabOpenOnly: true,
      resumeOnFirstReveal: true,
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    expect(recordAwaitsFirstRevealInOwnTab(record, useAppStore.getState())).toBe(true)
    expect(normalizeLines('done')).toEqual([
      expect.objectContaining({
        target: { paneKey: PANE, tabId: 'tab-1' },
        audit: expect.objectContaining({ rule: 'hibernation.normalize-record', mode: 'on' })
      })
    ])
  })

  it('in shadow (the default) only writes a would-line and changes no record', async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record }, { idleAutoCloseMode: 'shadow' })
    await startWhenReady()
    expect(recordNow()).toBe(record)
    expect(normalizeLines('would')).toEqual([
      expect.objectContaining({ audit: expect.objectContaining({ mode: 'shadow' }) })
    ])
    expect(normalizeLines('done')).toEqual([])
  })

  it("stays a shadow in 'on' while the restore flood guard is off, and says why", async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record }, { idleAutoCloseMode: 'on' })
    await startWhenReady()
    expect(recordNow()).toBe(record)
    expect(normalizeLines('would')).toEqual([
      expect.objectContaining({
        audit: expect.objectContaining({
          evidence: expect.objectContaining({ refused: 'restore-flood-guard-off' })
        })
      })
    ])
  })

  it("does nothing in 'off'", async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record }, { idleAutoCloseMode: 'off' })
    await startWhenReady()
    expect(recordNow()).toBe(record)
    expect(linesFor('hibernation.normalize-record')).toEqual([])
  })

  it('waits for the settings, so a saved off is never read as the shadow default', async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record }, null)
    await startWhenReady()
    expect(linesFor('hibernation.normalize-record')).toEqual([])
    useAppStore.setState({ settings: { idleAutoCloseMode: 'off' } as never })
    await settleLegacySleepRecordPassForTests()
    expect(recordNow()).toBe(record)
    expect(linesFor('hibernation.normalize-record')).toEqual([])
  })

  it('runs once the settings load after the workspace session is ready', async () => {
    installSlept({ [PANE]: legacyRecord() }, null)
    await startWhenReady()
    useAppStore.setState({ settings: ON as never })
    await settleLegacySleepRecordPassForTests()
    expect(recordNow()?.restoreOnTabOpenOnly).toBe(true)
  })

  it('leaves a record whose last reply holds numbered questions on its old wake paths (G1)', async () => {
    const record = legacyRecord({ lastAssistantMessage: SAL_QUESTIONS })
    installSlept({ [PANE]: record })
    await startWhenReady()
    expect(recordNow()).toBe(record)
    expect(normalizeLines('kept')).toEqual([
      expect.objectContaining({
        audit: expect.objectContaining({ evidence: expect.objectContaining({ keep: 'open-ask' }) })
      })
    ])
    expect(guardDeps.readKeep).not.toHaveBeenCalled()
  })

  it('leaves a record main reads as waiting on an answer alone (G1, Stage A1)', async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record })
    guardDeps.readKeep.mockImplementation(async (targets) =>
      targets.map((target) => ({ ...quiet(target), state: 'awaiting-user' }))
    )
    await startWhenReady()
    expect(recordNow()).toBe(record)
  })

  it('leaves a record alone when main cannot read it (unknown means keep)', async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record })
    guardDeps.readKeep.mockResolvedValue([])
    await startWhenReady()
    expect(recordNow()).toBe(record)
  })

  it('leaves a record a person touched in the last 10 minutes alone (G2)', async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record })
    useAppStore.getState().recordTerminalInput(PANE, NOW - 2 * 60_000)
    await startWhenReady()
    expect(recordNow()).toBe(record)
  })

  it('leaves a record whose tab is on screen alone (G3)', async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record })
    cleanups.push(registerTerminalPaneVisibility('tab-1', { current: true }))
    await startWhenReady()
    expect(recordNow()).toBe(record)
  })

  it('re-reads the window after main answers; keeps a tab opened meanwhile (G4)', async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record })
    const visible = { current: false }
    cleanups.push(registerTerminalPaneVisibility('tab-1', visible))
    guardDeps.readKeep.mockImplementation(async (targets) => {
      visible.current = true
      return targets.map(quiet)
    })
    await startWhenReady()
    expect(guardDeps.readKeep).toHaveBeenCalledTimes(1)
    expect(recordNow()).toBe(record)
  })

  it('stops when the mode is switched off while main reads (kill switch)', async () => {
    const record = legacyRecord()
    installSlept({ [PANE]: record })
    guardDeps.readKeep.mockImplementation(async (targets) => {
      useAppStore.setState({ settings: { idleAutoCloseMode: 'off' } as never })
      return targets.map(quiet)
    })
    await startWhenReady()
    expect(recordNow()).toBe(record)
    expect(normalizeLines('done')).toEqual([])
  })

  it.each<[string, SleepingAgentSessionRecord]>([
    ['a mid-task quit record (G5)', legacyRecord({ origin: 'quit', state: 'working' })],
    ['a mid-task live record (G5)', legacyRecord({ origin: 'live', state: 'working' })],
    ['a person’s sleep of a working agent', legacyRecord({ state: 'working' })],
    ['an already tab-open-only record', legacyRecord({ restoreOnTabOpenOnly: true })],
    ['an interrupted record', legacyRecord({ interrupted: true })],
    ['a record whose tab is gone', legacyRecord({ worktreeId: 'wt-other' })]
  ])('leaves %s alone', async (_label, record) => {
    installSlept({ [PANE]: record })
    await startWhenReady()
    expect(recordNow()).toBe(record)
    expect(linesFor('hibernation.normalize-record')).toEqual([])
  })

  it('leaves two records of one conversation alone (their pairing decides which resumes)', async () => {
    const first = legacyRecord()
    const second = legacyRecord({ paneKey: PANE_2, tabId: 'tab-2' })
    installSlept({ [PANE]: first, [PANE_2]: second })
    await startWhenReady()
    expect(recordNow(PANE)).toBe(first)
    expect(recordNow(PANE_2)).toBe(second)
  })

  it('waits for the workspace session, then runs once for the app session', async () => {
    installSlept({ [PANE]: legacyRecord() })
    const stop = startAgentHibernationCoordinator({ intervalMs: 60_000 })
    await settleLegacySleepRecordPassForTests()
    expect(recordNow()?.restoreOnTabOpenOnly).toBe(undefined)
    useAppStore.setState({ workspaceSessionReady: true })
    await settleLegacySleepRecordPassForTests()
    expect(recordNow()?.restoreOnTabOpenOnly).toBe(true)
    stop()
    const later = legacyRecord({
      paneKey: PANE_2,
      tabId: 'tab-2',
      providerSession: { key: 'session_id', id: 'session-2' }
    })
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        ...useAppStore.getState().sleepingAgentSessionsByPaneKey,
        [PANE_2]: later
      }
    })
    startAgentHibernationCoordinator({ intervalMs: 60_000 })
    await settleLegacySleepRecordPassForTests()
    expect(recordNow(PANE_2)).toBe(later)
    expect(normalizeLines('done')).toHaveLength(1)
  })
})
