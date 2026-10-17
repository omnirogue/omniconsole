/**
 * Done — the terminal block, and the only one that finishes something.
 *
 * A PURSUIT records how it finishes on its own outcome set, and the chain carries that out
 * when the Outcome is met (`sessionFinish`: Close ends the tab, Save files the session in its
 * folder). An ORDINARY conversation has no Outcome, and none is manufactured for it (frozen
 * model, invariants 2 and 10) — so "Finish now" on a conversation that never became a pursuit
 * is the SURFACE's own finish door (`finishNextStep`: session → finishSession, thread →
 * finishThread, card → completeTask). The choice is handed back for it to carry out rather
 * than refused with "there is no queued work to finish yet".
 *
 * On a pursuit the person's Done also ANSWERS the review the composer authored for them, so the
 * finish they chose is not left waiting on a tick they have just given in another form
 * (`answeredByDone`). Nothing else on the Outcome is touched.
 */

import type { SessionFinishChoice } from '../../shared/session-finish-intent'
import {
  sessionOutcomeDefinition,
  type SessionOutcomeDefinition
} from '../../shared/session-outcome-types'
import { UP_NEXT_REFUSAL_KEYS, type UpNextDoneBlock } from '../../shared/up-next-types'
import { bindSessionFinishSource } from './session-outcome-finish-source'
import { isFinishedOutcomeChain, isSealedRunRefusal } from './session-outcome-source-uniqueness'
import { upNextChainFor } from './up-next'
import type { UpNextCommitContext } from './up-next-commit'

/** Close or Save, as the person chose it under Done. Never `me`: it is not offered. */
export function upNextFinishChoiceOf(block: UpNextDoneBlock): SessionFinishChoice {
  return {
    action: block.finish === 'save' ? 'save' : 'end',
    ...(block.finish === 'save' && block.folderId ? { folderId: block.folderId } : {})
  }
}

/** Who carried the finish out: this host, or the surface that owns the conversation. */
export type UpNextFinishResult =
  | { performed: 'host' }
  | { performed: 'surface'; finish: SessionFinishChoice }

/**
 * Done IS the person's answer to their OWN review, so the obligation to come back and tick it
 * does not survive the finish they just chose.
 *
 * The composer authors that criterion itself for a first commit — "I have reviewed the result",
 * `finish: 'my-review'` (`up-next-plan-edit.ts:170-176`) — because every Outcome needs one Done
 * When and the work has to come back to somebody. Nobody typed it. Live, that left the person
 * pressing Done under the panel's own words ("Close — ends the tab", "■ ends here", "or Done to
 * finish as is") on a pursuit that then waited for a tick they had just given in another form:
 * two live-sim runs ended with `sessionFinish {action:'end'}` recorded, the tab still open and
 * `my-review` still open (`omni-data.json` chains `source_b3cefdb0…`, `source_4caddd31…`).
 *
 * Only the OWNER's own review goes: a condition of kind `review` with no `recipientId`, and only
 * when no action of the outcome is waiting on it. Another person's review (a Person block's
 * recipient), and every mechanical criterion — file, report, verdict, command — stands exactly as
 * it was: the person is answering their own question, not deciding that a machine check passed
 * (frozen model invariant 4). Invariant 5 names this shape: "a finish that adds or removes a
 * review/handoff condition is a Done When change" — so it bumps the revision, which is also what
 * clears a stale block the source refusal latch left on the outcome.
 */
function answeredByDone(outcome: SessionOutcomeDefinition): SessionOutcomeDefinition {
  const answered = outcome.conditions
    .filter((condition) => condition.kind === 'review' && !condition.recipientId)
    .map((condition) => condition.id)
    .filter((id) => !outcome.actions.some((action) => action.conditionIds.includes(id)))
  if (!answered.length) {
    return outcome
  }
  const conditions = outcome.conditions.filter((condition) => !answered.includes(condition.id))
  // The schema needs a criterion to stand on: the finish's own source receipt is bound before
  // this runs, so there is always one. A shape that would be left with none keeps what it had.
  if (!conditions.length) {
    return outcome
  }
  return {
    ...outcome,
    // The finish node the plan lowered was "comes back to me"; the person has answered it, so the
    // outcome is reached when its remaining criteria are, and the validator no longer requires a
    // review condition for it (`session-outcome-validation.ts:128-137`).
    ...(outcome.finish === 'my-review' ? { finish: 'complete' as const } : {}),
    conditions
  }
}

export async function upNextCommitFinish(
  ctx: UpNextCommitContext,
  block: UpNextDoneBlock
): Promise<UpNextFinishResult> {
  const chain = upNextChainFor(ctx.runtime, ctx.rowKey)
  const set = chain?.outcomeSet
  if (!chain || !set) {
    return { performed: 'surface', finish: upNextFinishChoiceOf(block) }
  }
  if (isFinishedOutcomeChain(chain)) {
    // The pursuit this conversation was on is already finished; there is nothing to finish.
    throw new Error(UP_NEXT_REFUSAL_KEYS.doneNeedsWork)
  }
  // The finish's own source receipt is bound FIRST — the commit path binds it anyway
  // (`session-outcome-commit.ts:150`), and asking for it here is what leaves the outcome a
  // criterion to stand on while the person's own review is taken off it.
  const bound = bindSessionFinishSource(
    {
      source: 'user',
      expectedRevision: set.revision,
      outcomes: set.outcomes.map(sessionOutcomeDefinition),
      sessionFinish: upNextFinishChoiceOf(block)
    },
    chain
  )
  try {
    await ctx.runtime
      .getSessionOutcomeService()
      .commit(chain, { ...bound, outcomes: bound.outcomes.map(answeredByDone) })
  } catch (error) {
    // The run sealed between the reading above and its lane: the same refusal, in the same words.
    throw isSealedRunRefusal(error) ? new Error(UP_NEXT_REFUSAL_KEYS.doneNeedsWork) : error
  }
  return { performed: 'host' }
}
