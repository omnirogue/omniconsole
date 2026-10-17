/**
 * JEV's reading of how done a conversation's work is after a turn. Advisory only: it steers the
 * tray and Keep going, and never marks a hub card or outcome complete (the hub owns completion).
 */

export type NextStepDoneness = {
  /** 0–1: the person's original request is resolved by the work so far. */
  resolved: number
  /** 0–1: required work toward the request is still missing (decides "done"). */
  remainingWork: number
  /** 0–1: meaningful room for improvement remains (decides only "Push for better"). */
  roomToImprove: number
  /** 0–1: there is evidence the work was checked (tests ran, the page loaded, output inspected). */
  verified: number
  /** Any reading sat in JEV's unsure band. Display only: each decision checks its own readings. */
  unsure: boolean
  /** The host turn this reading answers. */
  turnKey: string
  at: number
}

/** Round-over-round judgement for "Push for better": did the latest round beat the one before? */
export type NextStepImprovementVerdict = {
  /** 0–1 that the latest version is better than the previous one. */
  improved: number
  unsure: boolean
}

export const NEXT_STEP_DONENESS_THRESHOLDS = {
  resolved: 0.9,
  remainingWork: 0.2,
  roomToImprove: 0.2,
  verified: 0.8,
  /** Readings inside [unsureLow, unsureHigh] are not a verdict. */
  unsureLow: 0.2,
  unsureHigh: 0.8,
  /** "Push for better" stops when the latest round is this unlikely to be an improvement. */
  notImproved: 0.2
} as const

export function nextStepDonenessIsUnsure(value: number): boolean {
  return (
    value > NEXT_STEP_DONENESS_THRESHOLDS.unsureLow &&
    value < NEXT_STEP_DONENESS_THRESHOLDS.unsureHigh
  )
}

/** A reading outside the unsure band that meets its threshold. */
const clearAtLeast = (value: number, threshold: number): boolean =>
  !nextStepDonenessIsUnsure(value) && value >= threshold
const clearAtMost = (value: number, threshold: number): boolean =>
  !nextStepDonenessIsUnsure(value) && value <= threshold

/**
 * Clearly finished: resolved, no required work missing, and checked, each reading clear on its
 * own. Room to improve does not count: finished work can still be improved.
 */
export function nextStepLooksDone(reading: NextStepDoneness | null | undefined): boolean {
  if (!reading) {
    return false
  }
  const t = NEXT_STEP_DONENESS_THRESHOLDS
  return (
    clearAtLeast(reading.resolved, t.resolved) &&
    clearAtMost(reading.remainingWork, t.remainingWork) &&
    clearAtLeast(reading.verified, t.verified)
  )
}

/** "Push for better" has run out of road: clearly no room left, or the last round clearly did not help. */
export function nextStepPushIsSpent(
  reading: NextStepDoneness | null | undefined,
  verdict: NextStepImprovementVerdict | null | undefined
): boolean {
  const t = NEXT_STEP_DONENESS_THRESHOLDS
  const noRoom = !!reading && clearAtMost(reading.roomToImprove, t.roomToImprove)
  const noGain = !!verdict && !verdict.unsure && verdict.improved <= t.notImproved
  return noRoom || noGain
}

/** Rounded percentage for display ("≈ 85% done"); null when there is no clear reading. */
export function nextStepDonePercent(reading: NextStepDoneness | null | undefined): number | null {
  if (!reading || nextStepDonenessIsUnsure(reading.resolved)) {
    return null
  }
  return Math.round(reading.resolved * 100)
}
