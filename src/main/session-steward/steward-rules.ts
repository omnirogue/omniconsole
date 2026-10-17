/**
 * The steward's rules (Phase 2, §3), as pure reads: who it leaves alone because something already
 * drives it, which proposal is a safe Yes, when a nudge or a "are you done?" question is due, when
 * a session is Stalled, and when a working session has gone silent. The pass acts on them.
 */

import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { adPausesFor } from '../next-steps/next-step-ad-pause-policy'
import { firstStepRefusal } from '../next-steps/next-step-keep-going-hard-stops'
import { SESSION_HUNG_AFTER_MS } from '../session-manage/session-manage-control'
import { remoteExecutionRefusal } from '../session-manage/session-manage-locality'
import { chooseOwnStep, type SessionOwnSteps } from '../session-manage/session-manage-steps'
import { STEWARD_NUDGE_EVERY_MS, STEWARD_NUDGES_TOTAL, STEWARD_ASK_EVERY_MS } from './steward-caps'
import type { StewardSessionState } from './steward-state-store'

export const STEWARD_UNCLEAR_QUIET_MS = 2 * 60 * 60_000
/** A session nothing changed on is looked at again at least this often. */
export const STEWARD_RECHECK_MS = 30 * 60_000

/** Fixed words, so nothing the session wrote can turn a nudge into an approval or a hard stop. */
export const STEWARD_NUDGE_TEXT =
  'You stopped with work remaining on your task. Continue it, record what you are waiting on with `omni outcome wait`, or hand back to the person with a short note of what is left.'
export const STEWARD_UNCLEAR_QUESTION = 'In two lines: is your task complete, and what is left?'

export type StewardDrivers = {
  /** A live outcome runner or session chain moves it forward. */
  chainBound: boolean
  /** A prompt held for it (`--when-idle`) is waiting or being delivered. */
  heldDelivery: boolean
}

/**
 * Why the steward leaves a session alone: it cannot see or reach it, or something already drives
 * it (Keep going, a runner or chain, a held prompt, the person's own question). Null when it may
 * look further. Tier 2 applies its own rules on top.
 */
export function stewardSkipReason(
  row: Pick<SessionManageSidebarRow, 'hostUnavailable' | 'launchPending'>,
  entry: SessionManageEntry,
  drivers: StewardDrivers
): string | null {
  // Why first: nothing the steward does reaches a session another computer runs (phase 4).
  if (remoteExecutionRefusal(entry, 'continue')) {
    return 'it runs on another computer'
  }
  if (entry.archived) {
    return 'archived'
  }
  if (row.hostUnavailable || entry.verdict === 'unverifiable') {
    return 'this computer cannot see it'
  }
  if (row.launchPending || !entry.paneKey) {
    return 'its launch is pending'
  }
  if (entry.verdict === 'live' && entry.state === 'unknown') {
    return 'its state is unknown'
  }
  if (entry.pinned) {
    return 'pinned'
  }
  if (entry.keepGoing) {
    return 'Keep going drives it'
  }
  if (drivers.chainBound) {
    return 'a plan or runner drives it'
  }
  if (drivers.heldDelivery) {
    return 'a held prompt is waiting for it'
  }
  if (entry.state === 'awaiting-user') {
    return 'it is asking the person'
  }
  return entry.state === 'provider-limited' ? 'a provider limit holds it' : null
}

const HARD_STOP_WORDS: Record<string, string> = {
  'needs-you-question': 'its proposal asks the person something',
  'no-safe-suggestion': 'its proposal has no step to run'
}

export type StewardSafeYesPick =
  | { ok: true; set: NextStepSuggestionSet; step: NextStepSuggestion }
  | { ok: false; reason: string }

/**
 * The one proposal a Yes may answer: a single step (several options are the person's choice),
 * clear of every hard stop, and never a question for the person.
 */
export function stewardSafeYesPick(own: SessionOwnSteps): StewardSafeYesPick {
  if (own.steps.length > 1) {
    return {
      ok: false,
      reason: `it offered ${own.steps.length} options, and choosing among them is the person’s call`
    }
  }
  const chosen = chooseOwnStep(own, { kind: 'yes' })
  if ('refusal' in chosen) {
    return { ok: false, reason: 'it has no proposal of its own to answer' }
  }
  // An ad pause follows the session's own ad-pause choice (allowed by default).
  const refusal = firstStepRefusal(
    { ...chosen.set, suggestions: [chosen.step] },
    adPausesFor(chosen.set.conversation)
  )
  if (refusal) {
    const words =
      HARD_STOP_WORDS[refusal.reason] ??
      `it needs the person (hard stop: ${refusal.reason.replace(/^needs-you-/, '')})`
    return { ok: false, reason: `“${chosen.step.title}”: ${words}` }
  }
  return { ok: true, set: chosen.set, step: chosen.step }
}

export type StewardDue = { kind: 'now' } | { kind: 'later'; at: number } | { kind: 'never' }

/** A nudge waits this long after the session's last activity: the person may be reading it. */
export const STEWARD_NUDGE_QUIET_MS = 15 * 60_000

/**
 * A nudge: due now, later (15 quiet minutes, then 12 h after the last), or never again (twice
 * already, so Stalled). An unknown activity clock waits; it is never read as quiet.
 */
export function stewardNudgeDue(
  state: StewardSessionState['nudge'],
  lastActivityAt: number | null,
  now: number
): StewardDue {
  if ((state?.count ?? 0) >= STEWARD_NUDGES_TOTAL) {
    return { kind: 'never' }
  }
  if (lastActivityAt === null || now - lastActivityAt < STEWARD_NUDGE_QUIET_MS) {
    return { kind: 'later', at: (lastActivityAt ?? now) + STEWARD_NUDGE_QUIET_MS }
  }
  return state && now - state.lastAt < STEWARD_NUDGE_EVERY_MS
    ? { kind: 'later', at: state.lastAt + STEWARD_NUDGE_EVERY_MS }
    : { kind: 'now' }
}

/** The "are you done?" question: after 2 quiet hours, once per 24 h. */
export function stewardAskDue(
  state: StewardSessionState['ask'],
  lastActivityAt: number | null,
  now: number
): StewardDue {
  if (lastActivityAt === null) {
    return { kind: 'never' }
  }
  if (now - lastActivityAt < STEWARD_UNCLEAR_QUIET_MS) {
    return { kind: 'later', at: lastActivityAt + STEWARD_UNCLEAR_QUIET_MS }
  }
  return state && now - state.at < STEWARD_ASK_EVERY_MS
    ? { kind: 'later', at: state.at + STEWARD_ASK_EVERY_MS }
    : { kind: 'now' }
}

/** Stalled holds until the session's next turn. */
export function stewardStalledHolds(
  stalled: StewardSessionState['stalled'],
  turnKey: string | null
): boolean {
  return Boolean(stalled) && (turnKey === null || stalled!.turnKey === turnKey)
}

/** Minutes a working session has printed nothing, once that reads as silent; else null. */
export function stewardSilentMinutes(lastOutputAt: number | null, now: number): number | null {
  if (lastOutputAt === null || now - lastOutputAt < SESSION_HUNG_AFTER_MS) {
    return null
  }
  return Math.floor((now - lastOutputAt) / 60_000)
}
