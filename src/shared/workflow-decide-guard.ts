import type { CouncilFinalCheck } from './workflow-council-final-check'
import type { WorkflowSpec } from './workflow-graph'
import { WORKFLOW_COMPARE_LAST_ROUND } from './workflow-graph-decide-fields'

/**
 * Decide's skeptic after the blind final check: what was published, and whether a model from a
 * family other than its writer checked it against the frame's hard limits. A known failure is
 * never published; an unknown one is shown unchecked, as a gap.
 */
export type DecideSkeptic = {
  shipped: 'memo' | 'finalist' | 'none'
  status: 'kept' | 'withheld' | 'unchecked' | 'no-limits'
  /** Checked against the listed limits, or the whole frame when they are not listed clearly. */
  against?: 'limits' | 'frame'
  /** The skeptic found the memo breaks a limit (the best finalist was then checked instead). */
  memoRejected?: true
  /** The skeptic found the best finalist breaks a limit. */
  finalistRejected?: true
  why?: 'failed' | 'no-seat' | 'finished-early'
}

/** The skeptic's rounds of the compared step, after every round the comparison may use. */
export const DECIDE_SKEPTIC_ROUND = WORKFLOW_COMPARE_LAST_ROUND + 1
export const DECIDE_FALLBACK_SKEPTIC_ROUND = DECIDE_SKEPTIC_ROUND + 1

type Translate = (key: string, fallback: string) => string
const english: Translate = (_key, fallback) => fallback

/** What the blind comparison itself found, whatever was shown after it. */
function comparisonLine(check: CouncilFinalCheck, t: Translate): string {
  switch (check.result) {
    case 'chair':
      return t(
        'workflowGraph.decideGuard.memoHeldUp',
        'Guard: the memo held up against the best finalist.'
      )
    case 'inconclusive':
      return t(
        'workflowGraph.decideGuard.comparisonUndecided',
        'Guard: the comparison with the best finalist was not decisive.'
      )
    case 'first-opinion':
      return t(
        'workflowGraph.decideGuard.finalist',
        'Guard: the best finalist was judged better than the memo, so it is shown instead.'
      )
    case 'finished-early':
      return t(
        'workflowGraph.decideGuard.finishedEarly',
        'The guard was skipped: the run finished early.'
      )
    case 'failed':
    case 'no-peer-votes':
      return t(
        'workflowGraph.decideGuard.comparisonFailed',
        'The guard could not compare the memo with the best finalist.'
      )
  }
}

function guardLine(check: CouncilFinalCheck, skeptic: DecideSkeptic | undefined, t: Translate) {
  if (skeptic?.shipped === 'none') {
    if (skeptic.memoRejected && !skeptic.finalistRejected) {
      return t(
        'workflowGraph.decideGuard.withheldMemo',
        "No recommendation passed the checks: a skeptic found that the memo breaks a hard limit in the frame, and no finalist was placed to stand in. The finalists and the skeptic's reasons are below; check them before acting."
      )
    }
    return skeptic.memoRejected
      ? t(
          'workflowGraph.decideGuard.withheldBoth',
          "No recommendation passed the checks: a skeptic found that the memo breaks a hard limit in the frame, and so does the best finalist. The finalists and the skeptic's reasons are below; check them before acting."
        )
      : t(
          'workflowGraph.decideGuard.withheldFinalist',
          "No recommendation passed the checks: the best finalist was judged better than the memo, but a skeptic found that it breaks a hard limit in the frame. The finalists and the skeptic's reasons are below; check them before acting."
        )
  }
  if (skeptic?.memoRejected) {
    return `${comparisonLine(check, t)} ${t(
      'workflowGraph.decideGuard.skepticRejectedMemo',
      'A skeptic then found that the memo breaks a hard limit in the frame, so the best finalist is shown instead.'
    )}`
  }
  switch (check.result) {
    case 'chair':
      return t(
        'workflowGraph.decideGuard.memo',
        'Guard: the memo was compared blind with the best finalist and kept.'
      )
    case 'first-opinion':
      return t(
        'workflowGraph.decideGuard.finalist',
        'Guard: the best finalist was judged better than the memo, so it is shown instead.'
      )
    case 'inconclusive':
      return t(
        'workflowGraph.decideGuard.inconclusive',
        'Guard: the comparison with the best finalist was not decisive, so the memo was kept.'
      )
    case 'failed':
      return t(
        'workflowGraph.decideGuard.failed',
        'The guard could not compare the memo with the best finalist, so the memo is shown unchecked.'
      )
    case 'finished-early':
      return t(
        'workflowGraph.decideGuard.finishedEarly',
        'The guard was skipped: the run finished early.'
      )
    case 'no-peer-votes':
      return t(
        'workflowGraph.decideGuard.noFinalist',
        'The guard was skipped: the comparison placed no finalist, so the memo is shown unchecked.'
      )
  }
}

function skepticLine(skeptic: DecideSkeptic, t: Translate): string | undefined {
  if (skeptic.status === 'kept') {
    return skeptic.against === 'frame'
      ? t(
          'workflowGraph.decideGuard.skepticKeptFrame',
          "A skeptic from another model family checked what is shown against the frame as a whole, because the frame's hard limits are not listed clearly."
        )
      : t(
          'workflowGraph.decideGuard.skepticKept',
          'A skeptic from another model family checked what is shown against every hard limit in the frame.'
        )
  }
  if (skeptic.status === 'no-limits') {
    return t(
      'workflowGraph.decideGuard.skepticNoLimits',
      'The frame states there are no hard limits, so there were none to check.'
    )
  }
  if (skeptic.status !== 'unchecked') {
    return undefined
  }
  switch (skeptic.why) {
    case 'no-seat':
      return t(
        'workflowGraph.decideGuard.skepticNoSeat',
        'No model family independent of its writer was available to check what is shown against the hard limits, so it is shown unchecked.'
      )
    case 'finished-early':
      return t(
        'workflowGraph.decideGuard.skepticSkipped',
        'The skeptic was skipped because the run finished early, so what is shown is unchecked against the hard limits.'
      )
    case 'failed':
    case undefined:
      return t(
        'workflowGraph.decideGuard.skepticFailed',
        'The skeptic could not check what is shown against the hard limits, so it is shown unchecked.'
      )
  }
}

/** The note under a Decide result: what was shipped, and what checked it. */
export function decideGuardNote(check: CouncilFinalCheck, translate: Translate): string {
  const skeptic = check.skeptic
  const extra = skeptic && skeptic.shipped !== 'none' ? skepticLine(skeptic, translate) : undefined
  return [guardLine(check, skeptic, translate), extra].filter(Boolean).join(' ')
}

/** Nothing checked, a limit left in doubt, or nothing that passed: each is a gap. */
export function decideGuardIsGap(check: CouncilFinalCheck): boolean {
  return (
    ['failed', 'finished-early', 'no-peer-votes'].includes(check.result) ||
    check.skeptic?.status === 'unchecked' ||
    check.skeptic?.status === 'withheld'
  )
}

export function decideGuardDescription(translate: Translate = english): string {
  return translate(
    'workflowGraph.decideGuard.description',
    'A guard compares the memo blind with the best finalist and keeps the finalist only if it is judged better; a skeptic from another model family then checks what would be shown against every hard limit, and a result that breaks one is never shown as the recommendation.'
  )
}

/** A skeptic that names no step the final step reads, as a validation problem. */
export function decideSkepticProblems(
  spec: WorkflowSpec,
  translate: Translate = english
): string[] {
  const check = spec.finalCheck
  if (!check || check.skeptic === undefined) {
    return []
  }
  const frame = spec.steps.find((step) => step.id === check.skeptic)
  const chair = spec.steps.find((step) => step.id === check.chair)
  return frame?.kind === 'do' && chair?.inputs.includes(frame.id)
    ? []
    : [
        translate(
          'workflowGraph.decideGuard.invalidSkeptic',
          "The guard's skeptic must read the frame from a Do step that the final step also reads."
        )
      ]
}
