import { sessionOutcomeResultBody as resultBody } from './session-outcome-result'
import { buildSessionReviewInstructions } from '../../shared/session-chain-review-prompt'
import {
  sessionChainStepOutputDir,
  type SessionChain,
  type SessionChainAgentStep
} from '../../shared/session-chain-types'
import { sameReviewRound } from './session-outcome-review-round'
import type { SessionOutcome, SessionOutcomeAction } from '../../shared/session-outcome-types'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import { setStepStatus, setStepWait, type OutcomeStepAccess } from './session-outcome-step-progress'
import { verdictInstructionsFor } from './session-outcome-verdict-hook'
import { launchSessionOutcomeAction } from './session-outcome-executor'

/**
 * How much of one producer's report travels inside a reader's brief. A stage that reads four
 * producers used to inline all four whole, so the sixteenth step of a plan carried the first
 * fifteen: the excerpt keeps the head (what was asked and decided) and the tail (the result), and
 * names the folder holding the rest.
 */
export const WORK_PLAN_REPORT_EXCERPT_CHARS = 12_000
const EXCERPT_HEAD_CHARS = 9_000
const EXCERPT_TAIL_CHARS = 3_000

/** One producer's report as its reader sees it: labelled, bounded, and never silently cut. */
function reportExcerpt(chain: SessionChain, stepId: string, body: string): string {
  const label = `=== ${stepId} ===`
  if (!body) {
    return `${label}\n(no report was recorded for this step)`
  }
  if (body.length <= WORK_PLAN_REPORT_EXCERPT_CHARS) {
    return `${label}\n${body}`
  }
  const omitted = body.length - EXCERPT_HEAD_CHARS - EXCERPT_TAIL_CHARS
  return [
    label,
    body.slice(0, EXCERPT_HEAD_CHARS),
    `… ${omitted} characters omitted from the middle of this report …`,
    body.slice(body.length - EXCERPT_TAIL_CHARS),
    `full report: ${sessionChainStepOutputDir(chain.workspacePath, chain.id, stepId)}`
  ].join('\n')
}

/**
 * The steps whose results this one reads: what `readsFrom` names, or — absent — every earlier step
 * of the outcome, which is what the host has always done. A reviewer never reads its own round's
 * siblings either way: they judge the same candidate independently.
 */
function producerIds(chain: SessionChain, outcome: SessionOutcome, step: SessionChainAgentStep) {
  const ids = outcome.stepIds ?? []
  const declared = step.readsFrom?.filter((id) => ids.includes(id))
  return (declared ?? ids.slice(0, ids.indexOf(step.id))).filter(
    (id) =>
      !sameReviewRound(
        chain.steps.find((candidate) => candidate.id === id),
        step
      )
  )
}

/**
 * Reads the chain and stages one step's launch: the action its agent would run, and the call that
 * starts it. The caller checks the brief fits before spending that call.
 */
export function prepareOutcomeStep(
  access: OutcomeStepAccess,
  outcome: SessionOutcome,
  stepId: string,
  /** The candidate version the cohort pinned for this launch; a review seat carries its own. */
  candidateVersion?: string
): { action: SessionOutcomeAction; launch: () => Promise<unknown> } {
  const chain = access.read()
  const current = chain.steps.find((candidate) => candidate.id === stepId) as SessionChainAgentStep
  const reports = producerIds(chain, outcome, current).flatMap((id) => {
    const attempt = chain.outcomeSet!.attempts.findLast(
      (entry) => entry.actionId === sessionOutcomeStepActionId(id) && entry.state === 'completed'
    )
    // An implicit producer that never completed is not an input; a declared one is, and says so.
    return attempt || current.readsFrom
      ? [reportExcerpt(chain, id, attempt ? resultBody(access.runtime, attempt) : '')]
      : []
  })
  // Every verdict-emitting seat ends with the marker the host reads, whatever it was asked,
  // naming the seat, its attempt and the version it judges — the three the host binds it to.
  const verdict = verdictInstructionsFor(current, outcome, candidateVersion)
  const review = current.review
    ? buildSessionReviewInstructions(current.review, {
        stepId: current.id,
        verdictSuffix: Boolean(verdict)
      })
    : ''
  const action: SessionOutcomeAction = {
    id: sessionOutcomeStepActionId(stepId),
    instruction: [
      current.prompt,
      review,
      verdict,
      ...(reports.length ? ['Previous step reports:', ...reports] : [])
    ]
      .filter(Boolean)
      .join('\n\n'),
    conditionIds: outcome.conditions.map((condition) => condition.id),
    authority: 'existing-user-authority',
    agent: current.agent,
    ...(current.model ? { model: current.model } : {}),
    ...(current.openrouterCandidates !== undefined
      ? { openrouterCandidates: [...current.openrouterCandidates] }
      : {}),
    ...(current.effort ? { effort: current.effort } : {}),
    ...(current.accountChoiceId ? { accountChoiceId: current.accountChoiceId } : {})
  }
  // A launching step is not waiting, whatever held it back before.
  setStepWait(access, chain.id, stepId, null)
  if (current.status === 'failed') {
    // Why: a resumed step is running again; leaving last attempt's failure on it would report a
    // step as dead while its replacement works. Read the chain back so the launch sees the reset.
    setStepStatus(access, stepId, 'queued')
  }
  const staged = access.read()
  return {
    action,
    launch: () =>
      launchSessionOutcomeAction(
        access.runtime,
        staged,
        outcome.id,
        action,
        access.persistAttempt,
        access.detach
      )
  }
}
