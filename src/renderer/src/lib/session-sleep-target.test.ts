import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  isSessionAsleep,
  planSessionSleep,
  type SessionSleepHost,
  type SessionSleepState
} from './session-sleep-target'

const LEAF = '11111111-1111-4111-8111-111111111111'
const TAB = 'tab-1'
const PANE = `${TAB}:${LEAF}`
const WORKTREE = 'folder:notes'
const ROW = { kind: 'terminal' as const, worktreeId: WORKTREE, tabId: TAB, paneKey: PANE }
const LOCAL_HOST: SessionSleepHost = {
  runtimeEnvironmentId: null,
  authority: 'none',
  isPhoneDriving: () => false
}
const LOCAL = (): SessionSleepHost => LOCAL_HOST
const withHost = (overrides: Partial<SessionSleepHost>) => (): SessionSleepHost => ({
  ...LOCAL_HOST,
  ...overrides
})

function state(overrides: Partial<SessionSleepState> = {}): SessionSleepState {
  return {
    tabsByWorktree: { [WORKTREE]: [{ id: TAB }] },
    terminalLayoutsByTabId: { [TAB]: { ptyIdsByLeafId: { [LEAF]: 'pty-1' } } },
    ptyIdsByTabId: { [TAB]: ['pty-1'] },
    agentStatusByPaneKey: {
      [PANE]: {
        paneKey: PANE,
        state: 'working',
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'abc' }
      }
    },
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    ...overrides
  } as unknown as SessionSleepState
}

describe('planSessionSleep', () => {
  it('targets the live PTY of a resumable agent, working or not, in a folder workspace', () => {
    expect(planSessionSleep(state(), ROW, LOCAL)).toEqual({
      ok: true,
      target: { worktreeId: WORKTREE, tabId: TAB, leafId: LEAF, paneKey: PANE, ptyId: 'pty-1' }
    })
  })

  it('has nothing to sleep when the pane has no live PTY or is not a terminal', () => {
    expect(planSessionSleep(state({ ptyIdsByTabId: { [TAB]: [] } }), ROW, LOCAL)).toEqual({
      ok: false,
      reason: 'no-live-pty'
    })
    expect(planSessionSleep(state(), { ...ROW, kind: 'structured' }, LOCAL)).toEqual({
      ok: false,
      reason: 'not-terminal'
    })
    expect(planSessionSleep(state(), { ...ROW, paneKey: 'tab-1:0' }, LOCAL)).toEqual({
      ok: false,
      reason: 'not-terminal'
    })
  })

  it('refuses a plain shell or an agent without a provider session id', () => {
    expect(planSessionSleep(state({ agentStatusByPaneKey: {} }), ROW, LOCAL).ok).toBe(false)
    const noId = state({
      agentStatusByPaneKey: {
        [PANE]: { paneKey: PANE, state: 'working', agentType: 'claude' }
      } as unknown as SessionSleepState['agentStatusByPaneKey']
    })
    expect(planSessionSleep(noId, ROW, LOCAL)).toEqual({ ok: false, reason: 'not-resumable' })
  })

  it('never stops what it cannot verify: unanswered hosts, paired runtimes and phones', () => {
    expect(planSessionSleep(state(), ROW, withHost({ authority: 'unverifiable' }))).toEqual({
      ok: false,
      reason: 'unverifiable-host'
    })
    expect(planSessionSleep(state(), ROW, withHost({ runtimeEnvironmentId: 'env-1' }))).toEqual({
      ok: false,
      reason: 'paired-host'
    })
    expect(planSessionSleep(state(), ROW, withHost({ isPhoneDriving: () => true }))).toEqual({
      ok: false,
      reason: 'phone-driving'
    })
  })

  it('allows a live direct-SSH host', () => {
    expect(planSessionSleep(state(), ROW, withHost({ authority: 'live' })).ok).toBe(true)
  })

  it('respects the orchestration resume fence', () => {
    const fenced = state({
      sleepingAgentSessionsByPaneKey: {
        [PANE]: {
          paneKey: PANE,
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
        } as SleepingAgentSessionRecord
      }
    })
    expect(planSessionSleep(fenced, ROW, LOCAL)).toEqual({ ok: false, reason: 'resume-blocked' })
  })
})

describe('isSessionAsleep', () => {
  const record = { paneKey: PANE, worktreeId: WORKTREE } as SleepingAgentSessionRecord
  it('is asleep with a record and no live PTY, awake while the PTY runs', () => {
    const slept = state({
      ptyIdsByTabId: { [TAB]: [] },
      sleepingAgentSessionsByPaneKey: { [PANE]: record }
    })
    expect(isSessionAsleep(slept, ROW)).toBe(true)
    expect(
      isSessionAsleep(state({ sleepingAgentSessionsByPaneKey: { [PANE]: record } }), ROW)
    ).toBe(false)
    expect(isSessionAsleep(state(), ROW)).toBe(false)
  })

  it("follows a paired owner's rest for a row its ledger vouches for, never this computer's records", () => {
    const vouched = (rest: 'live' | 'dormant' | 'asleep' | 'unknown') => ({
      ...ROW,
      mirroredConversation: {
        environmentId: 'env-studio',
        conversation: null,
        ownerPaneKey: null,
        ownerTabId: null,
        rest,
        listed: true,
        stale: false,
        ownerState: 'ready' as const
      }
    })
    // This computer holds a record and no live PTY for the pane, yet only the owner's word counts.
    const slept = state({
      ptyIdsByTabId: { [TAB]: [] },
      sleepingAgentSessionsByPaneKey: { [PANE]: record }
    })
    expect(isSessionAsleep(slept, vouched('live'))).toBe(false)
    expect(isSessionAsleep(slept, vouched('dormant'))).toBe(false)
    expect(isSessionAsleep(state(), vouched('asleep'))).toBe(true)
    // A record row of the owner has neither tab nor pane here.
    expect(isSessionAsleep(state(), { ...vouched('asleep'), tabId: null, paneKey: null })).toBe(
      true
    )
    // The owner does not say (a frozen bucket vouches for presence only): this computer's own
    // record of the pane speaks again, as it did before the ledger.
    expect(isSessionAsleep(slept, vouched('unknown'))).toBe(true)
    expect(isSessionAsleep(state(), vouched('unknown'))).toBe(false)
  })
})
