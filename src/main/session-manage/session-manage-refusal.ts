import { adPausesFor, type AdPauseTarget } from '../next-steps/next-step-ad-pause-policy'
import {
  hardStopOf,
  hardStopOfQuestion,
  type HardStop,
  type HardStopCategory
} from '../next-steps/next-step-keep-going-hard-stops'

/** A refusal: nothing was changed, and the message says why in plain words. */
export class SessionManageRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionManageRefusal'
  }
}

/**
 * A failure after part of an action already applied (its Keep going turned off): the handler audits
 * what did change before the error reaches the caller, so no change goes unrecorded.
 */
export class SessionManagePartialError extends Error {
  constructor(
    message: string,
    /** What had already changed, in plain words. */
    readonly applied: string,
    readonly audit?: { before: Record<string, unknown>; after: Record<string, unknown> }
  ) {
    super(`${message} Already done: ${applied}.`)
    this.name = 'SessionManagePartialError'
  }
}

/** Runs the rest of an action after something changed; a failure then is partial, never silent. */
export async function afterApplied<T>(applied: string | null, rest: () => Promise<T>): Promise<T> {
  try {
    return await rest()
  } catch (error) {
    if (applied === null) {
      throw error
    }
    throw new SessionManagePartialError(
      error instanceof Error ? error.message : String(error),
      applied
    )
  }
}

const HARD_STOP_WORDS: Record<HardStopCategory, string> = {
  'ad-spend':
    'changes ad spend (turning on or re-enabling ads, ad sets or campaigns, scaling them, or changing budgets, bids or spend limits)',
  'ad-enterprise': 'pauses OmniRogue Enterprise ads, which are flagged for Sal, not paused',
  'ad-campaign-pause':
    'pauses a whole campaign or ad account (campaigns stay on; pause ad sets instead)',
  'ad-pause': 'pauses ads or ad sets, and the person asked to approve ad pauses for this session',
  deploy: 'deploys, releases or publishes',
  'shared-branch': 'pushes or merges to a shared branch',
  'delete-data': 'deletes data',
  history: 'rewrites git history',
  send: 'sends something to people',
  payment: 'involves a payment',
  credentials: 'touches credentials or permissions'
}

/**
 * The Keep going hard-stop list, on exactly the words that would be sent. An ad pause follows the
 * target's own ad-pause choice, else the global one (allowed by default).
 */
export function refuseHardStop(text: string, target?: AdPauseTarget): void {
  refuseDetectedHardStop(hardStopOf(text, adPausesFor(target)))
}

export function refuseQuestionHardStop(text: string, target?: AdPauseTarget): void {
  refuseDetectedHardStop(hardStopOfQuestion(text, adPausesFor(target)))
}

function refuseDetectedHardStop(stop: HardStop | null): void {
  if (stop) {
    throw new SessionManageRefusal(
      `Refused (hard stop: ${stop.category}): this ${HARD_STOP_WORDS[stop.category]}, which needs the person. Nothing was sent.`
    )
  }
}
