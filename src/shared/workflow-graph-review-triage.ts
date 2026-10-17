import {
  WORKFLOW_DEFAULT_FOR_EACH,
  WORKFLOW_MAX_FOR_EACH,
  WORKFLOW_MAX_FOR_EACH_ESCALATED,
  WORKFLOW_MAX_INSTRUCTION_CHARS,
  type WorkflowJevVerify,
  type WorkflowScreen,
  type WorkflowStep
} from './workflow-graph'
import {
  JEV_VERIFY_CONFIRM_RANGE,
  JEV_VERIFY_REJECT_AT,
  JEV_VERIFY_REJECT_RANGE
} from './jev-confidence'
import { clampInt, cleanBlock } from './workflow-spec-coercion'

const record = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined

/**
 * A for-each step's limit, and a review's JEV screen and escalation. Escalating raises the limit
 * cap, since most items then take one reviewer rather than all of them.
 */
export function normalizeWorkflowReviewTriage(input: {
  kind: WorkflowStep['kind']
  forEachStep: string | undefined
  forEachRaw: unknown
  escalateRaw: unknown
  mapId: (value: unknown) => string | undefined
}): {
  limit: number
  screen?: WorkflowScreen
  order?: 'impact'
  merge?: 'root-cause'
  escalate?: { max: number; crossFamily?: true; standIn?: true }
} {
  const forEach = record(input.forEachRaw)
  const review = input.kind === 'review' && !!input.forEachStep
  const raw = record(forEach?.screen)
  // A Do step screens only to shortlist what it works on (Decide's finalists).
  const shortlist = input.kind === 'do' && !!input.forEachStep && raw?.shortlist === true
  const screen = review || shortlist ? raw : undefined
  const escalate = review ? record(input.escalateRaw) : undefined
  const limit = clampInt(
    forEach?.limit,
    1,
    escalate ? WORKFLOW_MAX_FOR_EACH_ESCALATED : WORKFLOW_MAX_FOR_EACH,
    WORKFLOW_DEFAULT_FOR_EACH
  )
  const rubric = cleanBlock(screen?.rubric, WORKFLOW_MAX_INSTRUCTION_CHARS)
  const rubricFrom = input.mapId(screen?.rubricFrom)
  return {
    limit,
    ...(screen
      ? {
          screen: {
            ...(rubric ? { rubric } : {}),
            ...(rubricFrom ? { rubricFrom } : {}),
            ...(shortlist ? { shortlist: true as const } : {})
          }
        }
      : {}),
    ...(review && forEach?.order === 'impact' ? { order: 'impact' as const } : {}),
    // Repeats are marked by the impact triage, so merging needs it.
    ...(review && forEach?.order === 'impact' && forEach.merge === 'root-cause'
      ? { merge: 'root-cause' as const }
      : {}),
    ...(escalate
      ? {
          escalate: {
            max: clampInt(escalate.max, 1, limit, Math.min(8, limit)),
            // The first reviewer comes from a family other than the finder's.
            ...(escalate.crossFamily === true ? { crossFamily: true as const } : {}),
            // A first review that gave no answer is made again on another provider.
            ...(escalate.standIn === true ? { standIn: true as const } : {})
          }
        }
      : {})
  }
}

/**
 * Kept on any step, so validation names a misplaced one. An unknown mode, or a `confirmAt` or
 * `rejectAt` that is not a number, is kept in a form validation refuses, so a typo is named.
 */
export function normalizeWorkflowJevVerify(raw: unknown): { jevVerify?: WorkflowJevVerify } {
  const verify = record(raw)
  if (!verify) {
    return {}
  }
  if (verify.mode === 'shadow') {
    return { jevVerify: { mode: 'shadow' } }
  }
  if (verify.mode !== 'live') {
    return { jevVerify: { mode: 'unknown' } }
  }
  const threshold = (at: unknown) => (typeof at === 'number' ? at : Number.NaN)
  return {
    jevVerify: {
      mode: 'live',
      ...(verify.confirmAt === undefined ? {} : { confirmAt: threshold(verify.confirmAt) }),
      ...(verify.rejectAt === undefined ? {} : { rejectAt: threshold(verify.rejectAt) })
    }
  }
}

/** Live JEV verify confirms only at a `confirmAt` its step sets; undefined otherwise. */
export function workflowJevConfirmAt(verify: WorkflowJevVerify | undefined): number | undefined {
  return verify?.mode === 'live' ? verify.confirmAt : undefined
}

/**
 * The probability at or below which live JEV verify sets an item aside; undefined otherwise. The
 * default applies only when a step sets neither threshold: a `confirmAt`-only spec stays confirm-only.
 */
export function workflowJevRejectAt(verify: WorkflowJevVerify | undefined): number | undefined {
  if (verify?.mode !== 'live') {
    return undefined
  }
  return verify.rejectAt ?? (verify.confirmAt === undefined ? JEV_VERIFY_REJECT_AT : undefined)
}

const inRange = (value: number, [low, high]: readonly [number, number]) =>
  value >= low && value <= high

/** What stops a screening, escalating or ranked review from running as written. */
export function workflowReviewTriageProblems(
  step: WorkflowStep,
  name: string,
  byId: ReadonlyMap<string, WorkflowStep>
): string[] {
  const rubricFrom = step.forEach?.screen?.rubricFrom
  const rankable = step.inputs.some((id) => {
    const input = byId.get(id)
    return input?.kind === 'review' && !!input.forEach
  })
  return [
    ...(step.rankItems && !rankable
      ? [`${name} ranks reviewed results, so it must read a step that reviews each item.`]
      : []),
    ...(rubricFrom && !step.inputs.includes(rubricFrom)
      ? [`${name} takes its screening rubric from a step it does not read.`]
      : []),
    ...(step.escalate && step.agents.length < 2
      ? [`${name} escalates to more reviewers, so it needs at least two.`]
      : []),
    ...(step.jevVerify && (step.kind !== 'review' || !step.forEach)
      ? [`${name}: only a review of each item can ask JEV to verify the items.`]
      : []),
    ...(step.jevVerify?.mode === 'unknown'
      ? [`${name}: JEV verify's mode is "shadow" or "live".`]
      : []),
    ...(step.jevVerify?.mode === 'live' &&
    step.jevVerify.confirmAt !== undefined &&
    !inRange(step.jevVerify.confirmAt, JEV_VERIFY_CONFIRM_RANGE)
      ? [
          `${name}: JEV verify's confirmAt must be a number from ${JEV_VERIFY_CONFIRM_RANGE[0]} to ${JEV_VERIFY_CONFIRM_RANGE[1]}.`
        ]
      : []),
    ...(step.jevVerify?.mode === 'live' &&
    step.jevVerify.rejectAt !== undefined &&
    !inRange(step.jevVerify.rejectAt, JEV_VERIFY_REJECT_RANGE)
      ? [
          `${name}: JEV verify's rejectAt must be a number from ${JEV_VERIFY_REJECT_RANGE[0]} to ${JEV_VERIFY_REJECT_RANGE[1]}.`
        ]
      : []),
    ...(step.jevVerify?.mode === 'live' &&
    step.jevVerify.rejectAt !== undefined &&
    step.jevVerify.confirmAt !== undefined &&
    step.jevVerify.rejectAt >= step.jevVerify.confirmAt
      ? [`${name}: JEV verify's rejectAt must be below its confirmAt.`]
      : [])
  ]
}
