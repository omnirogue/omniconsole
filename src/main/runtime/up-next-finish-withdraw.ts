/**
 * Taking Done back off a chain that has not finished yet.
 *
 * Done is an INTENT on the outcome set (`sessionFinish`), not a step, so withdrawing it is a
 * commit of the same outcomes with that intent cleared — never a plan change, and never a
 * removal of the work above it. The reviser carries a previous finish forward whenever a
 * commit merely leaves the field out (that is what keeps every ordinary plan commit from
 * silently un-finishing a session), so the withdrawal says so itself: `clearSessionFinish`.
 *
 * A Done that has already executed is history and refuses (`up-next-write.ts` keeps that
 * guard on `block.locked`); this is only ever the queued one the person can still see.
 */

import {
  sessionOutcomeDefinition,
  type SessionOutcomeDefinition
} from '../../shared/session-outcome-types'
import { UP_NEXT_REFUSAL_KEYS } from '../../shared/up-next-types'
import { isFinishedOutcomeChain, isSealedRunRefusal } from './session-outcome-source-uniqueness'
import { upNextChainFor } from './up-next'
import type { UpNextCommitContext } from './up-next-commit'

/**
 * The finish takes its own criterion with it. Committing Done binds the outcome to the
 * source conversation's own ending (`bindSessionFinishSource`), and a condition nothing will
 * ever produce a receipt for would leave the Outcome pending for good. The last condition is
 * never dropped: an Outcome states at least one thing it is done when.
 */
function withoutFinishSource(
  definition: SessionOutcomeDefinition,
  sourcePaneKey: string
): SessionOutcomeDefinition {
  const conditions = definition.conditions.filter(
    (condition) => !(condition.kind === 'session' && condition.target === sourcePaneKey)
  )
  return conditions.length && conditions.length !== definition.conditions.length
    ? { ...definition, conditions }
    : definition
}

export async function upNextWithdrawFinish(ctx: UpNextCommitContext): Promise<void> {
  const chain = upNextChainFor(ctx.runtime, ctx.rowKey)
  const set = chain?.outcomeSet
  // A finished run's Done has executed: it is history, and taking it back would reopen the run.
  if (!chain || !set?.sessionFinish || isFinishedOutcomeChain(chain)) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.doneNeedsWork)
  }
  try {
    await ctx.runtime.getSessionOutcomeService().commit(chain, {
      source: 'user',
      expectedRevision: set.revision,
      outcomes: set.outcomes.map((outcome) =>
        withoutFinishSource(sessionOutcomeDefinition(outcome), chain.sourcePaneKey)
      ),
      clearSessionFinish: true
    })
  } catch (error) {
    // The run sealed between the reading above and its lane: its Done has executed after all.
    throw isSealedRunRefusal(error) ? new Error(UP_NEXT_REFUSAL_KEYS.doneNeedsWork) : error
  }
}
