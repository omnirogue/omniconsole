import { describe, expect, it } from 'vitest'
import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import { hardStopOf } from '../next-steps/next-step-keep-going-hard-stops'
import { freeformApprovalRefusal } from '../session-manage/session-manage-freeform'
import { manageEntry, sidebarRow } from '../session-manage/session-manage-test-fixtures'
import {
  STEWARD_NUDGE_QUIET_MS,
  STEWARD_NUDGE_TEXT,
  STEWARD_UNCLEAR_QUESTION,
  stewardAskDue,
  stewardNudgeDue,
  stewardSafeYesPick,
  stewardSilentMinutes,
  stewardSkipReason,
  stewardStalledHolds
} from './steward-rules'

const HOUR = 3_600_000
const drivers = { chainBound: false, heldDelivery: false }

function own(steps: Partial<NextStepSuggestion>[]) {
  const suggestions = steps.map((step, index) => ({
    id: `s${index + 1}`,
    title: `Step ${index + 1}`,
    prompt: `Do step ${index + 1}`,
    risk: 'safe',
    kind: 'fix',
    offered: true,
    ...step
  })) as NextStepSuggestion[]
  const set = { id: 'set', turnKey: 't1', status: 'pending', suggestions } as NextStepSuggestionSet
  return { set, steps: suggestions }
}

describe('who the steward leaves alone', () => {
  const skip = (entry = {}, row = {}, driving = drivers) =>
    stewardSkipReason(sidebarRow(row), manageEntry(entry), driving)

  it('leaves another computer, an unseen host and a pending launch alone', () => {
    expect(skip({ hostId: 'ssh:box' })).toBe('it runs on another computer')
    expect(skip({ hostId: 'runtime:mac-2' })).toBe('it runs on another computer')
    expect(skip({}, { hostUnavailable: true })).toBe('this computer cannot see it')
    expect(skip({ verdict: 'unverifiable', state: 'unknown' })).toBe('this computer cannot see it')
    expect(skip({}, { launchPending: true })).toBe('its launch is pending')
    expect(skip({ state: 'unknown' })).toBe('its state is unknown')
  })

  it('never takes over a session something already drives', () => {
    expect(skip({ keepGoing: true })).toBe('Keep going drives it')
    expect(skip({}, {}, { chainBound: true, heldDelivery: false })).toBe(
      'a plan or runner drives it'
    )
    expect(skip({}, {}, { chainBound: false, heldDelivery: true })).toBe(
      'a held prompt is waiting for it'
    )
    expect(skip({ pinned: true })).toBe('pinned')
    expect(skip({ state: 'awaiting-user' })).toBe('it is asking the person')
    expect(skip({ state: 'provider-limited' })).toBe('a provider limit holds it')
    expect(skip({ archived: true })).toBe('archived')
  })

  it('looks further at an idle, working or exited local session', () => {
    expect(skip()).toBeNull()
    expect(skip({ state: 'working' })).toBeNull()
    expect(skip({ verdict: 'exited', state: 'exited' })).toBeNull()
  })
})

describe('a safe Yes', () => {
  it('answers a single safe step', () => {
    const pick = stewardSafeYesPick(own([{ title: 'Add the migration' }]))
    expect(pick).toMatchObject({ ok: true, step: { id: 's1' } })
  })

  it('leaves a choice among several options, a question and a hard stop for the person', () => {
    expect(stewardSafeYesPick(own([{}, {}]))).toEqual({
      ok: false,
      reason: 'it offered 2 options, and choosing among them is the person’s call'
    })
    expect(stewardSafeYesPick(own([{ kind: 'ask', title: 'Which region?' }]))).toEqual({
      ok: false,
      reason: '“Which region?”: its proposal asks the person something'
    })
    expect(
      stewardSafeYesPick(
        own([{ title: 'Deploy to production', prompt: 'Deploy the release to prod' }])
      )
    ).toEqual({
      ok: false,
      reason: '“Deploy to production”: it needs the person (hard stop: deploy)'
    })
    expect(
      stewardSafeYesPick(own([{ title: 'Raise the Spring campaign budget to $500/day' }]))
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/hard stop: ad-spend/) })
    // Ad pauses are allowed by default (Sal, 2026-09-26).
    expect(stewardSafeYesPick(own([{ title: 'Pause the Spring promo ad set' }]))).toMatchObject({
      ok: true
    })
    expect(stewardSafeYesPick({ set: null, steps: [] })).toEqual({
      ok: false,
      reason: 'it has no proposal of its own to answer'
    })
  })
})

describe('when a nudge or a question is due', () => {
  it('nudges after 15 quiet minutes, again after 12 h, and never after two', () => {
    expect(stewardNudgeDue(undefined, 0, HOUR)).toEqual({ kind: 'now' })
    expect(stewardNudgeDue(undefined, HOUR - 60_000, HOUR)).toEqual({
      kind: 'later',
      at: HOUR - 60_000 + STEWARD_NUDGE_QUIET_MS
    })
    expect(stewardNudgeDue(undefined, null, HOUR)).toEqual({
      kind: 'later',
      at: HOUR + STEWARD_NUDGE_QUIET_MS
    })
    expect(stewardNudgeDue({ count: 1, lastAt: 0 }, 0, HOUR)).toEqual({
      kind: 'later',
      at: 12 * HOUR
    })
    expect(stewardNudgeDue({ count: 1, lastAt: 0 }, 0, 12 * HOUR)).toEqual({ kind: 'now' })
    expect(stewardNudgeDue({ count: 2, lastAt: 0 }, 0, 100 * HOUR)).toEqual({ kind: 'never' })
  })

  it('asks after 2 quiet hours, once per 24 h, and never on an unknown clock', () => {
    expect(stewardAskDue(undefined, null, 10 * HOUR)).toEqual({ kind: 'never' })
    expect(stewardAskDue(undefined, 9 * HOUR, 10 * HOUR)).toEqual({ kind: 'later', at: 11 * HOUR })
    expect(stewardAskDue(undefined, 0, 10 * HOUR)).toEqual({ kind: 'now' })
    expect(stewardAskDue({ at: 5 * HOUR }, 0, 10 * HOUR)).toEqual({ kind: 'later', at: 29 * HOUR })
  })

  it('holds Stalled until the next turn', () => {
    const stalled = { at: 1, reason: 'x', turnKey: 't1' }
    expect(stewardStalledHolds(stalled, 't1')).toBe(true)
    expect(stewardStalledHolds(stalled, null)).toBe(true)
    expect(stewardStalledHolds(stalled, 't2')).toBe(false)
    expect(stewardStalledHolds(undefined, 't1')).toBe(false)
  })

  it('reads a working session as silent after 10 minutes without output', () => {
    expect(stewardSilentMinutes(null, HOUR)).toBeNull()
    expect(stewardSilentMinutes(HOUR - 9 * 60_000, HOUR)).toBeNull()
    expect(stewardSilentMinutes(HOUR - 25 * 60_000, HOUR)).toBe(25)
  })
})

describe('the words the steward sends', () => {
  it('are never an approval and never touch a hard stop', () => {
    for (const text of [STEWARD_NUDGE_TEXT, STEWARD_UNCLEAR_QUESTION]) {
      expect(freeformApprovalRefusal(text)).toBeNull()
      expect(hardStopOf(text)).toBeNull()
    }
  })
})
