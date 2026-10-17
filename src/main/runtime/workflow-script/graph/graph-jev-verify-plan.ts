import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import { contractByRef } from '../../../../shared/decision-contracts/decision-contract-library'
import { JEV_VERIFY_CONFIRM_AT } from '../../../../shared/jev-confidence'
import type { WorkflowStep } from '../../../../shared/workflow-graph'
import {
  workflowJevConfirmAt,
  workflowJevRejectAt
} from '../../../../shared/workflow-graph-review-triage'
import { JEV_RESPONSE_BYTES } from '../../../structured-decisions/jev-rank-rubric'
import { graphContractKey, graphContractTable } from './graph-decision-rules'
import { graphEvidenceLocation } from './graph-evidence-check'
import type { GraphItem } from './graph-items'
import {
  GRAPH_JEV_SEAT_ID,
  graphPlural,
  type GraphCall,
  type GraphOkOutput,
  type GraphOutcome,
  type GraphStepRun,
  type GraphTarget,
  type GraphVerifyRequest
} from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { graphWebFencer } from './graph-web-citations'

/**
 * JEV verify (`step.jevVerify`): one host call per review round asks JEV, for every item the round
 * sees, whether it is a real, in-scope defect. Its answer is written onto the targets; no order,
 * merge, escalation, prompt to a reviewer or gap reads it, and it is kept off `run.calls`.
 * Shadow: the step never waits for it. Live: the step's verdicts wait for it (each JEV request is
 * bounded by its own deadline), then an item the reviewers left unverified at p <= rejectAt is set
 * aside by JEV, and at p >= confirmAt (only when the step sets it) confirmed by JEV. A failure or
 * a missing probability changes nothing and is never a "no".
 */

/** The text under a brief heading (prose or bullets), up to the next heading. */
function briefSection(markdown: string, heading: RegExp): string | undefined {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && heading.test(line))
  if (start === -1) {
    return undefined
  }
  const end = lines.findIndex((line, index) => index > start && /^#{1,6}\s/.test(line))
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim()
  return body || undefined
}

/** The goal, and what counts as in scope when a brief (the screen's rubric source first) says. */
function verifyScope(
  goal: string,
  step: WorkflowStep,
  settled: readonly { id: string; output: GraphOkOutput }[]
): string {
  const from = step.forEach?.screen?.rubricFrom
  const inputs = [...settled].sort(
    (left, right) => Number(right.id === from) - Number(left.id === from)
  )
  for (const input of inputs) {
    const brief = input.output.run.texts?.[0]?.markdown
    const counts = brief ? briefSection(brief, /what counts/i) : undefined
    if (counts) {
      return `Goal: ${goal}\n\nWhat counts (and what is out of scope): ${counts}`
    }
  }
  return `Goal: ${goal}`
}

export const graphJevVerifyCallId = (step: WorkflowStep, round: number, inLoop: boolean) =>
  [step.id, inLoop ? `r${round}` : '', 'jev-verify'].filter(Boolean).join('/')

/** Live thresholds: a run frozen under @2 keeps its rule (confirm at 0.9, never set aside). */
function verifyThresholds(
  scope: GraphScope,
  step: WorkflowStep
): { confirmAt?: number; rejectAt?: number } {
  const verify = step.jevVerify
  if (verify?.mode !== 'live') {
    return {}
  }
  const ref = graphContractTable(scope.config)[`${step.id}/verify`]
  if (ref && contractByRef(ref).version === 2) {
    return { confirmAt: verify.confirmAt ?? JEV_VERIFY_CONFIRM_AT }
  }
  const confirmAt = workflowJevConfirmAt(verify)
  return {
    ...(confirmAt !== undefined ? { confirmAt } : {}),
    rejectAt: workflowJevRejectAt(verify)
  }
}

/** Plans the round's shadow verify over every item (not just the review's limit). */
export function graphJevVerifyForEach(
  scope: GraphScope,
  input: {
    step: WorkflowStep
    round: number
    inLoop: boolean
    source: readonly GraphItem[]
    settled: readonly { id: string; output: GraphOkOutput }[]
    dependencies: string[]
    run: GraphStepRun
  }
): void {
  const { step, round, inLoop } = input
  if (!step.jevVerify || step.kind !== 'review' || !input.source.length) {
    return
  }
  const fence = graphWebFencer(scope, JEV_RESPONSE_BYTES) ?? ((text: string) => text)
  const request: GraphVerifyRequest = {
    scope: verifyScope(scope.task.prompt, step, input.settled),
    items: input.source.map((item) => {
      const cited = graphEvidenceLocation(item.location)
      return {
        key: item.key,
        title: fence(item.title),
        location: item.location,
        detail: fence(item.detail),
        ...(cited ? { file: cited.file, line: cited.line } : {})
      }
    }),
    ...graphContractKey(scope.config, `${step.id}/verify`),
    ...verifyThresholds(scope, step)
  }
  const call: GraphCall = {
    id: graphJevVerifyCallId(step, round, inLoop),
    prompt: '',
    schema: textAnswerSchema,
    output: 'text',
    seatId: GRAPH_JEV_SEAT_ID,
    dependencies: input.dependencies,
    stepId: step.id,
    round,
    agentIndex: step.agents.length + 4,
    verify: request,
    validateSemantics: () => null
  }
  scope.calls.push(call)
  input.run.jevVerifyCall = call.id
}

/** JEV's probabilities by item key, or none when it gave none (a failure is never a "no"). */
export function graphJevVerifyProbabilities(
  outcome: GraphOutcome | undefined
): Record<string, number> | undefined {
  const value =
    outcome && 'value' in outcome
      ? (outcome.value as { probabilities?: unknown; error?: unknown } | null)
      : null
  const probabilities = value?.error ? undefined : value?.probabilities
  return probabilities && typeof probabilities === 'object'
    ? (probabilities as Record<string, number>)
    : undefined
}

/** Each root-cause merged finding JEV decided, with every member's probability that decided it. */
export function graphJevVerifyMembers(
  targets: readonly GraphTarget[],
  probabilities: Readonly<Record<string, number>>
): Record<string, Record<string, number>> | undefined {
  const merged = targets.filter(
    (target) => (target.confirmedBy || target.refutedBy) && target.item.alsoMerged?.length
  )
  const members = (keys: string[]) =>
    Object.fromEntries(keys.map((key) => [key, probabilities[key]!]))
  return merged.length
    ? Object.fromEntries(
        merged.map(({ item }) => [item.key, members([item.key, ...item.alsoMerged!])])
      )
    : undefined
}

/** Live mode: the round's verdicts wait until JEV has answered (or failed). */
export function graphJevVerifyPending(
  scope: GraphScope,
  step: WorkflowStep,
  run: GraphStepRun
): boolean {
  return (
    step.jevVerify?.mode === 'live' && !!run.jevVerifyCall && !scope.outcomes.has(run.jevVerifyCall)
  )
}

type JevVerdict =
  | { kind: 'none' }
  | { kind: 'refuted' | 'confirmed' | 'held'; p: number; label: string; unread?: number }

/**
 * Reports merged into a finding that JEV never read: the request carries first reports only, as
 * `fence` rendered them for JEV (a run that reads pages), so each report is compared the same way.
 */
function unreadReports(
  target: GraphTarget,
  request: GraphVerifyRequest,
  fence: (text: string) => string
): number {
  const keys = new Set([target.item.key, ...(target.item.alsoMerged ?? [])])
  const read = request.items.filter((item) => keys.has(item.key))
  return (target.item.alsoReported ?? []).filter(
    (report) =>
      !read.some(
        (item) =>
          item.title === fence(report.title) &&
          item.location === report.location &&
          item.detail === fence(report.detail)
      )
  ).length
}

/**
 * What live JEV verify decides for an unverified target, by the recorded request's thresholds. A
 * root-cause merged finding needs every member's p on the same side, at the highest (set aside) or
 * lowest (confirmed); a finding carrying a merged report JEV did not read is held, never decided.
 */
function jevVerdict(
  target: GraphTarget,
  request: GraphVerifyRequest | undefined,
  answer: (key: string) => number | undefined,
  fence: (text: string) => string
): JevVerdict {
  const probability = answer(target.item.key)
  const members = (target.item.alsoMerged ?? []).map((key) => ({ key, p: answer(key) }))
  const every = [probability, ...members.map((member) => member.p)]
  const known = every.filter((p): p is number => p !== undefined)
  if (!request || target.tally !== 'unverified' || known.length !== every.length) {
    return { kind: 'none' }
  }
  const [low, high] = [Math.min(...known), Math.max(...known)]
  const kind =
    request.rejectAt !== undefined && high <= request.rejectAt
      ? 'refuted'
      : request.confirmAt !== undefined &&
          !target.webUnbacked &&
          !target.item.evidence?.preVerify?.dropped &&
          low >= request.confirmAt
        ? 'confirmed'
        : undefined
  if (!kind) {
    return { kind: 'none' }
  }
  const p = kind === 'refuted' ? high : low
  const unread = unreadReports(target, request, fence)
  const label = members.length
    ? `${target.item.key} (p ${p.toFixed(2)}: ${[{ key: target.item.key, p: probability }, ...members].map((member) => `${member.key} ${member.p!.toFixed(2)}`).join(', ')})`
    : `${target.item.key} (p ${p.toFixed(2)})`
  if (!unread) {
    return { kind, p, label }
  }
  const why = `${graphPlural(unread, 'merged report')} JEV did not read`
  return { kind: 'held', p, unread, label: `${label.slice(0, -1)}; ${why})` }
}

/**
 * Writes each target's probability onto it. Live: an unverified target at p <= rejectAt becomes
 * refuted by JEV; at p >= confirmAt, confirmed by JEV unless a page backs it with no quote the app
 * found; nothing else changes (see jevVerdict for merged findings). The thresholds are the hashed
 * request's, so a replayed record applies the rule it was recorded under. A failed or empty answer
 * changes nothing, not even the log. Until a live answer comes, the step stays active.
 */
export function graphAttachJevVerify(
  scope: GraphScope,
  step: WorkflowStep,
  run: GraphStepRun
): void {
  if (graphJevVerifyPending(scope, step, run)) {
    run.state = 'active'
    return
  }
  const probabilities = run.jevVerifyCall
    ? graphJevVerifyProbabilities(scope.outcomes.get(run.jevVerifyCall))
    : undefined
  // No finite answer for any target is no answer at all: the round is the one it was without JEV.
  const answer = (key: string) => {
    const p = probabilities?.[key]
    return Number.isFinite(p) ? p : undefined
  }
  if (!run.targets?.some((target) => answer(target.item.key) !== undefined)) {
    return
  }
  const request = scope.calls.find((call) => call.id === run.jevVerifyCall)?.verify
  const { confirmAt, rejectAt } = request ?? {}
  if (confirmAt !== undefined || rejectAt !== undefined) {
    run.notes.push(
      `${step.title} round ${run.round}: live JEV verify ${rejectAt !== undefined ? `sets aside at p <= ${rejectAt}` : 'never sets aside'} and ${confirmAt !== undefined ? `confirms at p >= ${confirmAt}` : 'never confirms'}.`
    )
  }
  const confirmed: string[] = []
  const refuted: string[] = []
  const held: string[] = []
  const fence = graphWebFencer(scope, JEV_RESPONSE_BYTES) ?? ((text: string) => text)
  run.targets = run.targets.map((target) => {
    const probability = answer(target.item.key)
    if (probability === undefined) {
      return target
    }
    const verdict = jevVerdict(target, request, answer, fence)
    if (verdict.kind === 'none' || verdict.kind === 'held') {
      if (verdict.kind === 'held') {
        held.push(verdict.label)
        run.jevHeld = { ...run.jevHeld, [target.item.key]: verdict.unread! }
      }
      return { ...target, jevVerify: probability }
    }
    if (verdict.kind === 'refuted') {
      refuted.push(verdict.label)
      return {
        ...target,
        jevVerify: verdict.p,
        tally: 'refuted' as const,
        refutedBy: 'jev' as const
      }
    }
    confirmed.push(verdict.label)
    return {
      ...target,
      jevVerify: verdict.p,
      tally: 'confirmed' as const,
      confirmedBy: 'jev' as const
    }
  })
  if (held.length) {
    run.notes.push(
      `${step.title} round ${run.round}: JEV left ${graphPlural(held.length, 'item')} unverified that it would have decided, as each carries a merged report it did not read: ${held.join(', ')}.`
    )
  }
  if (refuted.length) {
    run.notes.push(
      `${step.title} round ${run.round}: JEV set aside ${graphPlural(refuted.length, 'item')} the reviewers left unverified, at p <= ${rejectAt}: ${refuted.join(', ')}.`
    )
  }
  if (confirmed.length) {
    run.notes.push(
      `${step.title} round ${run.round}: JEV confirmed ${graphPlural(confirmed.length, 'item')} the reviewers left unverified, at p ${confirmAt} or more: ${confirmed.join(', ')}.`
    )
  }
}
