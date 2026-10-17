/**
 * The async questions an answer is on its way to, per pane. Claimed before the first byte and
 * kept until Codex reports the turn that answer started (its UserPromptSubmit arrives seconds
 * after Enter), so the pane card, Needs you and `omni session answer` never send a second answer
 * into that gap. A claim nothing was written for is released at once.
 */

import type { ShownAsyncQuestion } from '../../shared/codex-async-question-dismissal'

/** `leftOut`: questions the answer's card showed and skipped, dismissed once Codex takes it. */
type Claim = {
  owner: string
  questions: ReadonlySet<string>
  leftOut: readonly ShownAsyncQuestion[]
}

const claims = new Map<string, Claim[]>()
/** When main heard each pane's Codex lead end its turn (its Stop), which is when a question left waiting starts to be the person's. */
const turnEndedAt = new Map<string, number>()
/** Answers Codex took (it reported their turn): confirmation evidence, bounded. */
const taken = new Set<string>()
const MAX_TAKEN = 512

function heldOn(paneKey: string): Claim[] {
  return claims.get(paneKey) ?? []
}

export function asyncQuestionAnswerClaimed(paneKey: string, question: string): boolean {
  return heldOn(paneKey).some((claim) => claim.questions.has(question))
}

/** Claims `questions` for `owner`; false when any of them is already on its way. */
export function claimAsyncQuestionAnswer(
  paneKey: string,
  questions: readonly string[],
  owner: string,
  leftOut: readonly ShownAsyncQuestion[] = []
): boolean {
  if (questions.some((question) => asyncQuestionAnswerClaimed(paneKey, question))) {
    return false
  }
  claims.set(paneKey, [...heldOn(paneKey), { owner, questions: new Set(questions), leftOut }])
  return true
}

export function holdsAsyncQuestionAnswer(paneKey: string, owner: string): boolean {
  return heldOn(paneKey).some((claim) => claim.owner === owner)
}

/** Nothing was written for this answer: its questions are free again. */
export function releaseAsyncQuestionAnswer(paneKey: string, owner: string): void {
  const kept = heldOn(paneKey).filter((claim) => claim.owner !== owner)
  if (kept.length > 0) {
    claims.set(paneKey, kept)
  } else {
    claims.delete(paneKey)
  }
}

/**
 * Codex reported a new lead turn (`taken`) or a new session (`reset`) on this pane: whatever was
 * claimed there is settled, and the next question, even one worded the same, is free. Returns the
 * questions the taken answers left out, for the caller to dismiss.
 */
export function settleAsyncQuestionAnswers(
  paneKey: string,
  reason: 'taken' | 'reset'
): ShownAsyncQuestion[] {
  const leftOut: ShownAsyncQuestion[] = []
  for (const claim of heldOn(paneKey)) {
    if (reason === 'taken') {
      leftOut.push(...claim.leftOut)
      taken.add(claim.owner)
      if (taken.size > MAX_TAKEN) {
        taken.delete(taken.values().next().value!)
      }
    }
  }
  claims.delete(paneKey)
  if (reason === 'reset') {
    turnEndedAt.delete(paneKey)
  }
  return leftOut
}

export function noteAsyncQuestionTurnEnded(paneKey: string, at: number = Date.now()): void {
  turnEndedAt.set(paneKey, at)
}

export function asyncQuestionTurnEndedAt(paneKey: string): number | undefined {
  return turnEndedAt.get(paneKey)
}

/** Codex reported the turn this answer started. */
export function asyncQuestionAnswerTaken(owner: string): boolean {
  return taken.has(owner)
}

export function resetAsyncQuestionAnswerClaimsForTests(): void {
  claims.clear()
  taken.clear()
  turnEndedAt.clear()
}
