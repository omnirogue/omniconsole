import type { BuildReviewAgentChoice } from '../../../shared/build-review-pipeline'
import {
  evaluateSessionEffortParity,
  isSessionEffortParityDivergent,
  sessionEffortParityValues,
  type SessionEffortParity
} from '../../../shared/session-effort-parity'
import { supportedEffortsForAgentModel } from '../../../shared/session-effort-support'

/**
 * The launch receipt `orchestration.workerStart` already answers with: what the start
 * was asked for, and what it ended up effective as. A federated or hub-side start can
 * resolve the effort differently (or leave `effective` null while it is still pending),
 * so the coordinator reads the receipt instead of assuming its own request was honoured.
 */
export type WorkerLaunchReceiptLike = {
  requested?: { agent?: string | null; model?: string | null; effort?: string | null } | null
  effective?: { agent?: string | null; model?: string | null; effort?: string | null } | null
}

function selection(
  value: WorkerLaunchReceiptLike['effective']
): { model?: string; effort?: string } | undefined {
  if (!value) {
    return undefined
  }
  return {
    ...(value.model ? { model: value.model } : {}),
    ...(value.effort ? { effort: value.effort } : {})
  }
}

/** Requested vs applied for one worker start. `unobserved` while no receipt says. */
export function workerStartEffortParity(
  choice: BuildReviewAgentChoice,
  receipt: WorkerLaunchReceiptLike | null | undefined
): SessionEffortParity {
  return evaluateSessionEffortParity({
    requested: {
      ...(choice.model ? { model: choice.model } : {}),
      ...(choice.effort ? { effort: choice.effort } : {})
    },
    applied: selection(receipt?.effective),
    supportedEfforts: supportedEffortsForAgentModel(choice.agent, choice.model)
  })
}

/**
 * The Run event text for a divergence, or null when there is nothing to report. English
 * here matches the rest of this pipeline's event log; the renderer localizes the card.
 */
export function workerEffortParityEventText(parity: SessionEffortParity): string | null {
  if (!isSessionEffortParityDivergent(parity)) {
    return null
  }
  const { requested = 'the requested value', applied } = sessionEffortParityValues(parity)
  switch (parity.reason) {
    case 'effort-unsupported':
      return `Effort ${requested} is not advertised for this model, so it was not applied and nothing was lowered in its place.`
    case 'model-differs':
      return `Started on ${applied ?? 'another model'}, not the requested ${requested}.`
    case 'effort-dropped':
      return `Started with no effort applied; ${requested} was requested.`
    case 'effort-differs':
      return `Started at ${applied}, not the requested ${requested}.`
    case undefined:
      return `Did not start at the requested ${requested}.`
  }
}
