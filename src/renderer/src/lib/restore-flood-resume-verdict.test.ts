import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  registerVisibleTerminalTab,
  resetForegroundTerminalTabIdsForTests
} from './foreground-terminal-tabs'
import { resetPersonRevealsForTests } from './restore-flood-guard'
import { decideBackgroundResume } from './restore-flood-resume-verdict'

const T0 = 2_000_000_000_000
const MINUTE = 60_000

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-a:leaf-1',
    tabId: 'tab-a',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'thread-a' },
    prompt: '',
    state: 'done',
    capturedAt: T0 - 60 * MINUTE,
    updatedAt: T0 - 60 * MINUTE,
    origin: 'worktree-sleep',
    ...overrides
  }
}

const guardOn = { settings: {} }

function at(time: number): void {
  vi.setSystemTime(time)
}

beforeEach(() => {
  vi.useFakeTimers()
  at(T0)
})

afterEach(() => {
  vi.useRealTimers()
  resetForegroundTerminalTabIdsForTests()
  resetPersonRevealsForTests()
})

describe('background resume verdict', () => {
  it('a tab put to sleep while on screen, then left, stays held for a background wake', () => {
    // Sal opens the tab, uses per-session "Put to sleep" on it, then switches to another tab.
    const release = registerVisibleTerminalTab('tab-a')
    at(T0 + MINUTE)
    const manualSleep = record({ capturedAt: T0 + MINUTE, restoreOnTabOpenOnly: true })
    at(T0 + 2 * MINUTE)
    release()
    // 20 minutes later (past the 10-minute G2 window) the phone opens the workspace.
    at(T0 + 22 * MINUTE)
    expect(
      decideBackgroundResume(guardOn, {
        paneKey: manualSleep.paneKey,
        tabId: 'tab-a',
        record: manualSleep,
        visible: false
      }).hold
    ).toBe(true)
  })

  it('a tab a person opened again after it slept keeps its resume', () => {
    const slept = record({ capturedAt: T0 })
    at(T0 + MINUTE)
    const release = registerVisibleTerminalTab('tab-a')
    at(T0 + 2 * MINUTE)
    release()
    at(T0 + 30 * MINUTE)
    expect(
      decideBackgroundResume(guardOn, {
        paneKey: slept.paneKey,
        tabId: 'tab-a',
        record: slept,
        visible: false
      })
    ).toEqual({ hold: false, reason: 'revealed-after-sleep' })
  })

  it('holds a finished agent whose last message is a numbered summary or a question', () => {
    // G1 for a held resume: the record stays resumable and opening the tab resumes it.
    for (const lastAssistantMessage of [
      'Done:\n1. Fixed the restore flood\n2. Added tests\n3. Pushed the branch',
      'Want me to open a PR?'
    ]) {
      const finished = record({ lastAssistantMessage })
      expect(
        decideBackgroundResume(guardOn, {
          paneKey: finished.paneKey,
          tabId: 'tab-a',
          record: finished,
          visible: false
        }).hold
      ).toBe(true)
    }
  })

  it('a live interactive ask still keeps the resume', () => {
    const finished = record()
    expect(
      decideBackgroundResume(guardOn, {
        paneKey: finished.paneKey,
        tabId: 'tab-a',
        record: finished,
        entry: { state: 'blocked', interactivePrompt: 'Allow git push?' },
        visible: false
      })
    ).toEqual({ hold: false, reason: 'open-ask' })
  })

  it("holds an idle 'quit' checkpoint; a mid-task one still auto-continues (G5)", () => {
    const idle = record({ origin: 'quit', state: 'done' })
    expect(
      decideBackgroundResume(guardOn, {
        paneKey: idle.paneKey,
        tabId: 'tab-a',
        record: idle,
        visible: false
      })
    ).toEqual({ hold: true, kind: 'idle-checkpoint' })
    const working = record({ origin: 'quit', state: 'working' })
    expect(
      decideBackgroundResume(guardOn, {
        paneKey: working.paneKey,
        tabId: 'tab-a',
        record: working,
        visible: false
      })
    ).toEqual({ hold: false, reason: 'not-guarded' })
  })

  it("holds a hydrated 'done' row with no record; a person's reasons still release it", () => {
    const target = {
      paneKey: 'tab-a:leaf-1',
      tabId: 'tab-a',
      record: null,
      entry: { state: 'done' as const, restoredUnconfirmed: true },
      liveEntryDriven: true,
      visible: false
    }
    expect(decideBackgroundResume(guardOn, target)).toEqual({
      hold: true,
      kind: 'idle-checkpoint'
    })
    expect(decideBackgroundResume(guardOn, { ...target, visible: true })).toEqual({
      hold: false,
      reason: 'visible'
    })
    expect(
      decideBackgroundResume(
        { ...guardOn, lastTerminalInputAtByPaneKey: { 'tab-a:leaf-1': T0 - 9 * MINUTE } },
        target
      )
    ).toEqual({ hold: false, reason: 'recent-touch' })
    expect(
      decideBackgroundResume(guardOn, {
        ...target,
        entry: { state: 'blocked', interactivePrompt: 'Allow git push?' }
      })
    ).toEqual({ hold: false, reason: 'open-ask' })
    // G5: a mid-turn row still auto-continues.
    expect(
      decideBackgroundResume(guardOn, {
        ...target,
        entry: { state: 'working' },
        liveEntryWorking: true
      })
    ).toEqual({ hold: false, reason: 'not-guarded' })
    expect(decideBackgroundResume({ settings: { restoreFloodGuard: false } }, target)).toEqual({
      hold: false,
      reason: 'guard-off'
    })
  })
})
