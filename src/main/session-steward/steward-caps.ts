/**
 * The steward's per-session prompt limits (D4), as pure reads of its saved state: 3 Yes per
 * session per day, a stop after 2 turns in a row with no new evidence, 1 nudge per 12 h and 2 in
 * all, 1 question per 24 h. There is no Mac-wide cap (Sal, 26 Sep).
 */

import type { StewardSessionState, StewardYesState } from './steward-state-store'

export const STEWARD_YES_PER_DAY = 3
export const STEWARD_NO_EVIDENCE_TURNS = 2
export const STEWARD_NUDGE_EVERY_MS = 12 * 60 * 60_000
export const STEWARD_NUDGES_TOTAL = 2
export const STEWARD_ASK_EVERY_MS = 24 * 60 * 60_000

export type StewardAllowance<T> = { ok: true; next: T } | { ok: false; reason: string; at?: number }

/** What a Yes is judged against: the turn it answers and the workspace's git head and changes. */
export type StewardYesReading = { turnKey: string | null; evidence: string | null }

export function yesAllowance(
  state: StewardYesState | undefined,
  reading: StewardYesReading,
  day: string
): StewardAllowance<StewardYesState> {
  if (!reading.turnKey) {
    return {
      ok: false,
      reason: 'Its latest turn could not be read, so the steward did not answer it'
    }
  }
  const count = state?.day === day ? state.count : 0
  if (count >= STEWARD_YES_PER_DAY) {
    return {
      ok: false,
      reason: `The steward already said yes to it ${STEWARD_YES_PER_DAY} times today`
    }
  }
  if (state?.lastTurnKey === reading.turnKey) {
    return { ok: false, reason: 'The steward already answered this turn' }
  }
  // Why unreadable counts as unchanged: no evidence of progress is not evidence of progress.
  const fresh =
    state?.lastTurnKey === undefined ||
    (reading.evidence !== null && reading.evidence !== state.lastEvidence)
  const noEvidenceTurns = fresh ? 0 : (state?.noEvidenceTurns ?? 0) + 1
  if (noEvidenceTurns >= STEWARD_NO_EVIDENCE_TURNS) {
    return {
      ok: false,
      reason: `${STEWARD_NO_EVIDENCE_TURNS} turns in a row since its last steward Yes brought no new commits or file changes`
    }
  }
  return {
    ok: true,
    next: {
      day,
      count: count + 1,
      lastTurnKey: reading.turnKey,
      lastEvidence: reading.evidence,
      noEvidenceTurns
    }
  }
}

export function nudgeAllowance(
  state: StewardSessionState['nudge'],
  now: number,
  turnKey: string | null
): StewardAllowance<NonNullable<StewardSessionState['nudge']>> {
  const count = state?.count ?? 0
  if (count >= STEWARD_NUDGES_TOTAL) {
    return { ok: false, reason: `The steward already nudged it ${STEWARD_NUDGES_TOTAL} times` }
  }
  if (state && now - state.lastAt < STEWARD_NUDGE_EVERY_MS) {
    return {
      ok: false,
      reason: 'The steward nudged it less than 12 hours ago',
      at: state.lastAt + STEWARD_NUDGE_EVERY_MS
    }
  }
  return { ok: true, next: { count: count + 1, lastAt: now, lastTurnKey: turnKey } }
}

export function askAllowance(
  state: StewardSessionState['ask'],
  now: number,
  turnKey: string | null
): StewardAllowance<NonNullable<StewardSessionState['ask']>> {
  if (state && now - state.at < STEWARD_ASK_EVERY_MS) {
    return {
      ok: false,
      reason: 'The steward asked it whether it is done less than 24 hours ago',
      at: state.at + STEWARD_ASK_EVERY_MS
    }
  }
  return { ok: true, next: { at: now, turnKey } }
}

/** Steward prompts counted for `day` (reported, never capped); a new day starts at zero. */
export function promptsToday(daily: { day: string; prompts: number }, day: string): number {
  return daily.day === day ? daily.prompts : 0
}
