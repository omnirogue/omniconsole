import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import {
  DECIDE_FALLBACK_SKEPTIC_ROUND,
  DECIDE_SKEPTIC_ROUND
} from '../../../../shared/workflow-decide-guard'
import { workflowDescendants } from '../../../../shared/workflow-graph-topology'
import { GRAPH_PROGRAM_REVISION } from '../workflow-program-revisions'

/**
 * When a failed call of a graph run may still run again. A step's prompt is built from the
 * results its inputs settled with, so once a later step has recorded a call built without this
 * call's result, a late success would change that call's identity. From then on the failure is
 * final: the call replays as the same null, neither blocks completion nor counts for Retry.
 *
 * Call ids are `step[/r<round>][/<item>]/a<agent>` (graph-plan.ts). Inside a repeat, what reads
 * what decides: until approved, round by round, the Do step before its Review; until nothing
 * new, a round's Do reads earlier rounds' Do items only, never their reviews.
 */
type GraphCallRef = { step: string; round: number }

function parseCallId(callId: string): GraphCallRef {
  const parts = callId.split('/')
  const round = /^r(\d+)$/.exec(parts[1] ?? '')
  return { step: parts[0], round: round ? Number(round[1]) : 0 }
}

/** The frozen spec of a graph run's checkpoint envelope, or undefined for every other program. */
export function graphSpecFromCheckpoint(snapshotJson: string): WorkflowSpec | undefined {
  try {
    const envelope = JSON.parse(snapshotJson) as {
      snapshot?: { graphProgramRevision?: unknown; graph?: { spec?: unknown } } | null
    }
    const snapshot = envelope.snapshot
    return snapshot?.graphProgramRevision === GRAPH_PROGRAM_REVISION && snapshot.graph?.spec
      ? (snapshot.graph.spec as WorkflowSpec)
      : undefined
  } catch {
    return undefined
  }
}

export function graphCallSuperseded(
  spec: WorkflowSpec,
  callId: string,
  recordedCallIds: readonly string[]
): boolean {
  const call = parseCallId(callId)
  // The post-chair comparison (and Decide's skeptic) reads the chair; it cannot supersede them.
  if (
    spec.finalCheck?.rank === call.step &&
    (call.round === 2 ||
      (spec.finalCheck.skeptic !== undefined &&
        (call.round === DECIDE_SKEPTIC_ROUND || call.round === DECIDE_FALLBACK_SKEPTIC_ROUND)))
  ) {
    return false
  }
  const repeat = spec.repeat
  const body = (step: string) => !!repeat && (repeat.do === step || repeat.review === step)
  const isReview = (step: string) => repeat?.review === step
  // A step after the loop reads what the loop ended with, and a review decides whether the loop
  // goes on, so the loop is one unit: once anything after it recorded a call, it is closed.
  const descendants = body(call.step)
    ? new Set([
        ...workflowDescendants(spec, repeat!.do),
        ...workflowDescendants(spec, repeat!.review)
      ])
    : workflowDescendants(spec, call.step)
  return recordedCallIds.some((recorded) => {
    if (recorded === callId) {
      return false
    }
    const later = parseCallId(recorded)
    if (body(call.step) && body(later.step)) {
      return repeat!.until !== 'nothing-new'
        ? // Round k+1's revision reads round k's draft and reviews (Improve: the best version so
          // far and the judges' notes); round k's review reads its draft.
          later.round > call.round ||
            (later.round === call.round && isReview(later.step) && !isReview(call.step))
        : // Until nothing new, a later round's Do reads every earlier round's items but never a
          // review, so a review call is only ever superseded by a step after the loop.
          !isReview(call.step) &&
            (later.round > call.round || (later.round === call.round && isReview(later.step)))
    }
    return descendants.has(later.step)
  })
}
