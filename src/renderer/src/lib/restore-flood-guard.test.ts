import { beforeEach, describe, expect, it } from 'vitest'
import {
  RECENT_HUMAN_TOUCH_MS,
  classifyGuardedResume,
  getPersonRevealedAt,
  hasLiveInteractiveAsk,
  hasOpenAsk,
  isInterruptedWorkingRecord,
  isRestoreFloodGuardOn,
  notePersonRevealedTab,
  resetPersonRevealsForTests,
  resolveResumeKeepReason
} from './restore-flood-guard'

const NOW = 1_000_000_000

describe('restore flood guard classification', () => {
  it('is on unless switched off', () => {
    expect(isRestoreFloodGuardOn(undefined)).toBe(true)
    expect(isRestoreFloodGuardOn(null)).toBe(true)
    expect(isRestoreFloodGuardOn({})).toBe(true)
    expect(isRestoreFloodGuardOn({ restoreFloodGuard: true })).toBe(true)
    expect(isRestoreFloodGuardOn({ restoreFloodGuard: false })).toBe(false)
  })

  it('keys on what completed-agent hibernation writes, not on restoreOnTabOpenOnly', () => {
    // The 2026-09-30 flood: origin 'worktree-sleep', state 'done', no restoreOnTabOpenOnly.
    expect(
      classifyGuardedResume({ record: { origin: 'worktree-sleep', state: 'done' }, putAway: false })
    ).toBe('finished-sleep')
    expect(
      classifyGuardedResume({
        record: { origin: 'quit', state: 'done', restoreOnTabOpenOnly: true },
        putAway: false
      })
    ).toBe('on-open')
    expect(
      classifyGuardedResume({
        record: { origin: 'live', state: 'done', resumeOnFirstReveal: true },
        putAway: false
      })
    ).toBe('on-open')
    expect(classifyGuardedResume({ record: null, deferredStartup: true, putAway: false })).toBe(
      'on-open'
    )
    // A manual sleep of a still-working agent is the person's own record: only put-away holds it.
    const manualSleepOfWorkingAgent = { origin: 'worktree-sleep', state: 'working' } as const
    expect(classifyGuardedResume({ record: manualSleepOfWorkingAgent, putAway: true })).toBe(
      'put-away'
    )
    expect(classifyGuardedResume({ record: manualSleepOfWorkingAgent, putAway: false })).toBeNull()
    // Legacy records (written before `origin` existed) are worktree-sleep records.
    expect(classifyGuardedResume({ record: { state: 'done' }, putAway: false })).toBe(
      'finished-sleep'
    )
  })

  it("holds 'quit' and 'live' checkpoints of agents that were not mid-task (G5 exempts 'working' only)", () => {
    // The commonest record after an update or restart: an agent idle at its prompt when Sal quit.
    for (const origin of ['quit', 'live'] as const) {
      for (const state of ['done', 'blocked', 'waiting'] as const) {
        expect(classifyGuardedResume({ record: { origin, state }, putAway: false })).toBe(
          'idle-checkpoint'
        )
      }
    }
    expect(
      classifyGuardedResume({ record: { origin: 'quit', state: 'done' }, putAway: true })
    ).toBe('idle-checkpoint')
  })

  it("never gates 'quit' or 'live' records that were mid-task (G5) unless put away", () => {
    for (const origin of ['quit', 'live'] as const) {
      const record = { origin, state: 'working' as const, resumeOnFirstReveal: true as const }
      expect(isInterruptedWorkingRecord(record)).toBe(true)
      expect(classifyGuardedResume({ record, putAway: false, deferredStartup: true })).toBeNull()
    }
    expect(isInterruptedWorkingRecord({ origin: 'worktree-sleep', state: 'working' })).toBe(false)
    expect(
      classifyGuardedResume({ record: null, liveEntryWorking: true, putAway: false })
    ).toBeNull()
  })

  it('holds a mid-task agent the person archived, hid or deleted (#921 put-away rule)', () => {
    // The interrupted-restore auto-continue skips these; a background mount must not resume them.
    for (const origin of ['quit', 'live'] as const) {
      expect(classifyGuardedResume({ record: { origin, state: 'working' }, putAway: true })).toBe(
        'put-away'
      )
    }
    expect(classifyGuardedResume({ record: null, liveEntryWorking: true, putAway: true })).toBe(
      'put-away'
    )
  })

  it('holds a resume a live status row drives unless that row is mid-turn (G5)', () => {
    // A quit writes no record for a 'done' agent: only its hydrated status row drives the resume.
    expect(classifyGuardedResume({ record: null, liveEntryDriven: true, putAway: false })).toBe(
      'idle-checkpoint'
    )
    expect(classifyGuardedResume({ record: null, liveEntryDriven: true, putAway: true })).toBe(
      'put-away'
    )
    expect(
      classifyGuardedResume({
        record: null,
        liveEntryDriven: true,
        liveEntryWorking: true,
        putAway: false
      })
    ).toBeNull()
    expect(
      classifyGuardedResume({
        record: null,
        liveEntryDriven: true,
        liveEntryWorking: true,
        putAway: true
      })
    ).toBe('put-away')
    // No record and no live row: nothing here would resume an agent, so nothing is guarded.
    expect(classifyGuardedResume({ record: null, putAway: false })).toBeNull()
  })

  it('reads the sidebar model only when nothing else decided', () => {
    let reads = 0
    const putAway = (): boolean => {
      reads += 1
      return true
    }
    classifyGuardedResume({ record: { origin: 'worktree-sleep', state: 'done' }, putAway })
    classifyGuardedResume({ record: { origin: 'quit', state: 'done' }, putAway })
    expect(reads).toBe(0)
    expect(
      classifyGuardedResume({ record: { origin: 'worktree-sleep', state: 'working' }, putAway })
    ).toBe('put-away')
    expect(reads).toBe(1)
  })
})

describe('open ask (G1)', () => {
  it('counts the A1 reader verdicts and the hook states it reads as awaiting-user', () => {
    expect(hasOpenAsk({ sessionState: 'awaiting-user' })).toBe(true)
    expect(hasOpenAsk({ sessionState: 'waiting-for-yes' })).toBe(true)
    expect(hasOpenAsk({ sessionState: 'idle' })).toBe(false)
    expect(hasOpenAsk({ state: 'blocked' })).toBe(true)
    expect(hasOpenAsk({ state: 'waiting' })).toBe(true)
    expect(hasOpenAsk({ state: 'done', interactivePrompt: 'Allow rm?' })).toBe(true)
  })

  it("never takes hook 'done' as proof of idle", () => {
    // Sal's 3 numbered questions sat at 'done' for 42 minutes on 2026-09-30.
    expect(
      hasOpenAsk({
        state: 'done',
        lastAssistantMessage:
          'Three things:\n  1. Phase 0 now\n  2. 30 minutes\n  3. Archive pauses'
      })
    ).toBe(true)
    expect(hasOpenAsk({ state: 'done', lastAssistantMessage: 'Ready to merge?  ' })).toBe(true)
    expect(hasOpenAsk({ state: 'done', lastAssistantMessage: 'Done.\n1. Merged the PR' })).toBe(
      false
    )
    expect(hasOpenAsk({ state: 'done', lastAssistantMessage: 'All done.' })).toBe(false)
    expect(hasOpenAsk({ state: 'done' })).toBe(false)
  })

  it('releases a held resume only for a live interactive ask, never for the text heuristic', () => {
    // A held resume keeps the record, so the ask is answered when the tab is opened; an ordinary
    // numbered summary would otherwise resume most finished agents from the background.
    expect(hasLiveInteractiveAsk({ state: 'blocked', interactivePrompt: 'Allow rm build?' })).toBe(
      true
    )
    expect(hasLiveInteractiveAsk({ state: 'waiting', interactivePrompt: 'Pick one' })).toBe(true)
    expect(hasLiveInteractiveAsk({ state: 'blocked', interactivePrompt: '   ' })).toBe(false)
    expect(hasLiveInteractiveAsk({ state: 'blocked' })).toBe(false)
    expect(hasLiveInteractiveAsk({ state: 'done', interactivePrompt: 'Allow rm?' })).toBe(false)
    expect(hasLiveInteractiveAsk(null)).toBe(false)
    // A row main hydrated from last-status.json after a restart, with no live hook since, keeps
    // the prompt the agent showed when the app went away: that is no live ask.
    expect(
      hasLiveInteractiveAsk({
        state: 'blocked',
        interactivePrompt: 'Allow rm build?',
        restoredUnconfirmed: true
      })
    ).toBe(false)
  })
})

describe('keep reasons (G2, G3, revealed after sleep)', () => {
  beforeEach(() => {
    resetPersonRevealsForTests()
  })

  it('keeps a visible pane (G3) and an open ask (G1)', () => {
    expect(resolveResumeKeepReason({ now: NOW, visible: true, openAsk: false })).toBe('visible')
    expect(resolveResumeKeepReason({ now: NOW, visible: false, openAsk: true })).toBe('open-ask')
    expect(resolveResumeKeepReason({ now: NOW, visible: false, openAsk: false })).toBeNull()
  })

  it('keeps a pane a person touched in the last 10 minutes (G2)', () => {
    const recent = NOW - RECENT_HUMAN_TOUCH_MS
    const stale = NOW - RECENT_HUMAN_TOUCH_MS - 1
    for (const field of ['tabLastSeenAt', 'personRevealedAt', 'lastTerminalInputAt'] as const) {
      expect(
        resolveResumeKeepReason({ now: NOW, visible: false, openAsk: false, [field]: recent })
      ).toBe('recent-touch')
      expect(
        resolveResumeKeepReason({ now: NOW, visible: false, openAsk: false, [field]: stale })
      ).toBeNull()
    }
  })

  it('keeps a slept agent whose tab a person revealed after it slept', () => {
    const capturedAt = NOW - 60 * 60_000
    expect(
      resolveResumeKeepReason({
        now: NOW,
        visible: false,
        openAsk: false,
        capturedAt,
        tabRevealedAt: capturedAt + 1
      })
    ).toBe('revealed-after-sleep')
    // Slept while on screen, then left: last seen after capturedAt, but no reveal began since.
    expect(
      resolveResumeKeepReason({
        now: NOW,
        visible: false,
        openAsk: false,
        capturedAt,
        tabRevealedAt: capturedAt - 60_000,
        tabLastSeenAt: capturedAt + 60_000
      })
    ).toBeNull()
    // Input typed after it slept, but long ago, is not a reveal.
    expect(
      resolveResumeKeepReason({
        now: NOW,
        visible: false,
        openAsk: false,
        capturedAt,
        lastTerminalInputAt: capturedAt + 1
      })
    ).toBeNull()
    expect(
      resolveResumeKeepReason({
        now: NOW,
        visible: false,
        openAsk: false,
        capturedAt,
        tabRevealedAt: capturedAt - 1
      })
    ).toBeNull()
  })

  it("records the phone's per-terminal open per tab and forgets it past the G2 window", () => {
    notePersonRevealedTab('tab-a', NOW)
    expect(getPersonRevealedAt('tab-a')).toBe(NOW)
    expect(getPersonRevealedAt('tab-b')).toBeUndefined()
    notePersonRevealedTab('tab-b', NOW + RECENT_HUMAN_TOUCH_MS + 1)
    expect(getPersonRevealedAt('tab-a')).toBeUndefined()
  })
})
