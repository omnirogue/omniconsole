import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import type { WorkflowStep } from '../../../../shared/workflow-graph'
import {
  graphEvidenceLocation,
  graphExcerptFragments,
  type GraphEvidenceCheck,
  type GraphEvidenceRequest
} from './graph-evidence-check'
import type { GraphItem } from './graph-items'
import { graphPlural, graphValueError, type GraphCall, type GraphStepRun } from './graph-plan-types'
import { graphPreVerifies, graphPreVerifyItem, type GraphPreVerify } from './graph-pre-verify'
import type { GraphScope } from './graph-scope'

/** The seat an evidence check is recorded under; the app answers it, never an agent. */
export const GRAPH_EVIDENCE_SEAT_ID = 'evidence'

export type GraphEvidencePlan = {
  pending: boolean
  /** The item with the app's check on it; the item itself when the step checks no evidence. */
  attach: (item: GraphItem) => GraphItem
  /** The attached items a reviewer may read: those the pre-verify dropped go to `dropped`. */
  keep: (items: GraphItem[]) => GraphItem[]
  dropped: GraphItem[]
  /** Why nothing is left to review, when the pre-verify dropped every item. */
  empty: (screened: number) => string | undefined
}

const unchanged: GraphEvidencePlan = {
  pending: false,
  attach: (item) => item,
  keep: (items) => items,
  dropped: [],
  empty: () => undefined
}

/** A review for-each over a list that asked its finders for quotes (`list.evidence`). */
export function graphChecksEvidence(scope: GraphScope, step: WorkflowStep): boolean {
  return (
    step.kind === 'review' && !!step.forEach && !!scope.byId.get(step.forEach.step)?.list?.evidence
  )
}

function readChecks(value: unknown): Record<string, GraphEvidenceCheck> | undefined {
  const checks = (value as { checks?: unknown } | null)?.checks
  return checks && typeof checks === 'object'
    ? (checks as Record<string, GraphEvidenceCheck>)
    : undefined
}

function readPreVerify(value: unknown): Record<string, GraphPreVerify> {
  const checks = (value as { preVerify?: unknown } | null)?.preVerify
  return checks && typeof checks === 'object' ? (checks as Record<string, GraphPreVerify>) : {}
}

/** A drop needs one report: another report of the same result may cite files that exist. */
function reportedOnce(item: GraphItem, check: GraphPreVerify): GraphPreVerify {
  const others = [item.alsoFrom, item.alsoMerged, item.alsoReported].some((list) => list?.length)
  if (!check.dropped || (!others && !item.repeats)) {
    return check
  }
  const { dropped: _dropped, ...kept } = check
  const why =
    'No file it cites exists, but it was reported more than once, so it is still reviewed.'
  return { ...kept, flags: [...kept.flags, why] }
}

/** The run's notes on what the pre-verify dropped and flagged among the items left to review. */
function keepNotes(where: string, items: GraphItem[], dropped: GraphItem[], run: GraphStepRun) {
  const flagged = items.filter((item) => item.evidence?.preVerify?.flags.length).length
  if (dropped.length) {
    const keys = dropped.map((item) => item.key).join(', ')
    run.notes.push(
      `${where}: ${graphPlural(dropped.length, 'result was', 'results were')} dropped before review, as no file ${dropped.length === 1 ? 'it cites' : 'they cite'} exists in the workspace: ${keys}.`
    )
  }
  if (flagged) {
    run.notes.push(
      `${where}: the app's check of citations and absence searches flagged ${graphPlural(flagged, 'result')} for the reviewers.`
    )
  }
}

/** `step[/rN]/evidence` answers before any reviewer prompt is built; legacy specs plan nothing. */
export function graphEvidenceForEach(
  scope: GraphScope,
  input: {
    step: WorkflowStep
    round: number
    inLoop: boolean
    source: readonly GraphItem[]
    dependencies: string[]
    run: GraphStepRun
    where: string
  }
): GraphEvidencePlan {
  const { step, round, inLoop, run } = input
  if (!graphChecksEvidence(scope, step) || !input.source.length) {
    return unchanged
  }
  const own = new Map<string, GraphEvidenceCheck>()
  const request: GraphEvidenceRequest = { items: [] }
  const preVerifies = graphPreVerifies(scope.config)
  for (const item of input.source) {
    const facts = preVerifies ? graphPreVerifyItem(item) : undefined
    if (facts) {
      ;(request.preVerify ??= []).push(facts)
    }
    const location = graphEvidenceLocation(item.location)
    if (!location) {
      own.set(item.key, { status: 'not-code' })
    } else if (!graphExcerptFragments(item.excerpt ?? '').length) {
      own.set(item.key, { status: 'unquoted', line: location.line })
    } else {
      request.items.push({ key: item.key, ...location, excerpt: item.excerpt! })
    }
  }
  let checks: Record<string, GraphEvidenceCheck> = {}
  let verified: Record<string, GraphPreVerify> = {}
  if (request.items.length || request.preVerify?.length) {
    const call: GraphCall = {
      id: [step.id, inLoop ? `r${round}` : '', 'evidence'].filter(Boolean).join('/'),
      prompt: '',
      schema: textAnswerSchema,
      output: 'text',
      seatId: GRAPH_EVIDENCE_SEAT_ID,
      dependencies: input.dependencies,
      stepId: step.id,
      round,
      agentIndex: step.agents.length + 3,
      evidence: request,
      validateSemantics: () => null
    }
    scope.calls.push(call)
    const outcome = scope.outcomes.get(call.id)
    if (!outcome) {
      return { ...unchanged, pending: true }
    }
    const read = 'value' in outcome ? readChecks(outcome.value) : undefined
    const error = graphValueError(outcome) ?? (read ? undefined : 'the check did not finish')
    if (error) {
      run.notes.push(
        `${input.where}: the app could not check the finders' quotes (${error}); they are marked as not read.`
      )
    }
    checks = read ?? {}
    verified = 'value' in outcome ? readPreVerify(outcome.value) : {}
  }
  const dropped: GraphItem[] = []
  // A quote the check never answered for is unread: never found, never missing.
  return {
    pending: false,
    attach: (item) => {
      const check =
        own.get(item.key) ??
        checks[item.key] ??
        (request.items.some((entry) => entry.key === item.key)
          ? { status: 'unreadable' as const }
          : undefined)
      const pre = verified[item.key]
      const evidence = check && pre ? { ...check, preVerify: reportedOnce(item, pre) } : check
      return evidence ? { ...item, evidence } : item
    },
    keep: (items) => {
      const kept = items.filter((item) => !item.evidence?.preVerify?.dropped)
      dropped.push(...items.filter((item) => item.evidence?.preVerify?.dropped))
      keepNotes(input.where, kept, dropped, run)
      return kept
    },
    dropped,
    empty: (screened) =>
      dropped.length
        ? `Nothing to check: no file cited by ${dropped.length === 1 ? 'its one result' : `any of its ${dropped.length} results`} exists in the workspace${screened ? `, and JEV set aside ${screened} as non-findings` : ''}.`
        : undefined
  }
}
